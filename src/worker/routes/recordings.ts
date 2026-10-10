import type { Context, Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { resolveActor as actorFor } from '../membership';
import { orgRole, canManage } from '../tenancy';
import { roomFor, partKey } from '../events-db';
import { readJson } from '../request';

/** One uploaded part. Browsers send a few seconds of WebM each; large parts are refused. */
const MAX_PART_BYTES = 16 * 1024 * 1024;
const RECORDING_ROLES = ['organizer', 'producer', 'moderator'];

interface RecordingRow {
  id: string; event_id: string; org_id: string; title: string; session_key: string; started_by: string;
  started_at: number; ended_at: number | null; status: 'recording' | 'ready'; parts: number; bytes: number;
}

/**
 * Team session recording. The browser records the video room and uploads parts in order;
 * the Worker stores them in R2 and the Durable Object shows everyone in the session that it is being recorded.
 */
export function mountRecordings(app: Hono<AppEnv>) {
  app.post('/api/events/:id/recordings', async (c) => {
    const eventId = c.req.param('id');
    const actor = await actorFor(c.env, c.get('identity'), eventId);
    if (!actor) return c.json({ error: 'No access to this event' }, 403);
    const body = await readJson(c.req.raw);
    if (body.consent !== true) return c.json({ error: 'Confirm that everyone in the session knows it is being recorded' }, 400);
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'Video room';
    const event = await c.env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventId).first<{ org_id: string }>();
    if (!event) return c.json({ error: 'Event not found' }, 404);
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO recordings (id, event_id, org_id, title, session_key, started_by, started_at, status, parts, bytes)
       VALUES (?1, ?2, ?3, ?4, 'call', ?5, ?6, 'recording', 0, 0)`,
    ).bind(id, eventId, event.org_id, title, actor.email, Date.now()).run();
    const result = await roomFor(c.env, eventId).command(actor, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: id });
    if (!result.ok) {
      await c.env.DB.prepare('DELETE FROM recordings WHERE id = ?').bind(id).run();
      return c.json(result, result.status === 403 || result.status === 409 ? result.status : 400);
    }
    return c.json({ id }, 201);
  });

  app.post('/api/events/:id/recordings/:rid/parts/:n', async (c) => {
    const { row, actor, error } = await recordingFor(c, c.req.param('rid'), c.req.param('id'));
    if (error) return error;
    if (!row || row.started_by !== actor!.email) return c.json({ error: 'Only the person who started this recording can upload to it' }, 403);
    if (row.status !== 'recording') return c.json({ error: 'This recording has already stopped' }, 409);
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 0) return c.json({ error: 'Invalid part number' }, 400);
    // Parts must arrive in order; a repeated or skipped part would corrupt the download.
    if (n !== row.parts) return c.json({ error: `Expected part ${row.parts}`, expected: row.parts }, 409);
    if (!c.env.RECORDINGS) return c.json({ error: 'Recording storage is not configured' }, 503);
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_PART_BYTES) return c.json({ error: 'That part is too large' }, 413);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PART_BYTES) return c.json({ error: 'Invalid part' }, 400);
    await c.env.RECORDINGS.put(partKey(row.id, n), bytes);
    const result = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE recordings SET parts = parts + 1, bytes = bytes + ?2 WHERE id = ?1 AND status = 'recording' AND parts = ?3")
        .bind(row.id, bytes.byteLength, n),
      c.env.DB.prepare('INSERT INTO recording_parts (recording_id, part, bytes) VALUES (?1, ?2, ?3)').bind(row.id, n, bytes.byteLength),
    ]);
    if (!result[0].meta?.changes) {
      await c.env.RECORDINGS.delete(partKey(row.id, n));
      return c.json({ error: 'Another part arrived first. Retry.' }, 409);
    }
    return c.json({ ok: true, part: n });
  });

  app.post('/api/events/:id/recordings/:rid/stop', async (c) => {
    const { row, actor, error } = await recordingFor(c, c.req.param('rid'), c.req.param('id'));
    if (error) return error;
    if (!row) return c.json({ error: 'Recording not found' }, 404);
    const result = await roomFor(c.env, row.event_id).command(actor!, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: null });
    if (!result.ok) return c.json(result, result.status === 403 || result.status === 409 ? result.status : 400);
    await c.env.DB.prepare("UPDATE recordings SET status = 'ready', ended_at = ? WHERE id = ? AND status = 'recording'").bind(Date.now(), row.id).run();
    return c.json({ ok: true });
  });

  app.get('/api/events/:id/recordings', async (c) => {
    const eventId = c.req.param('id');
    const actor = await actorFor(c.env, c.get('identity'), eventId);
    if (!actor) return c.json({ error: 'No access to this event' }, 403);
    const canSeeAll = actor.roles.some((r) => RECORDING_ROLES.includes(r));
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM recordings WHERE event_id = ? ${canSeeAll ? '' : 'AND started_by = ?'} ORDER BY started_at DESC LIMIT 100`,
    ).bind(...(canSeeAll ? [eventId] : [eventId, actor.email])).all<RecordingRow>();
    return c.json(results.map(recordingJson));
  });

  /** Download a finished recording: parts are streamed in order, so long recordings never sit in memory. */
  app.get('/api/events/:id/recordings/:rid/media', async (c) => {
    const { row, actor, error } = await recordingFor(c, c.req.param('rid'), c.req.param('id'));
    if (error) return error;
    if (!row) return c.json({ error: 'Recording not found' }, 404);
    if (row.status !== 'ready') return c.json({ error: 'This recording is still in progress' }, 409);
    const canSee = actor!.roles.some((r) => RECORDING_ROLES.includes(r)) || row.started_by === actor!.email
      || canManage(await orgRole(c.env, actor!.email, row.org_id));
    if (!canSee) return c.json({ error: 'Only recording organizers can download this' }, 403);
    const { results } = await c.env.DB.prepare('SELECT part FROM recording_parts WHERE recording_id = ? ORDER BY part')
      .bind(row.id).all<{ part: number }>();
    const env = c.env;
    const queue = results.map((r) => r.part);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const part = queue.shift();
        if (part === undefined) return controller.close();
        const object = await env.RECORDINGS!.get(partKey(row.id, part));
        if (!object) return controller.error(new Error(`Recording part ${part} is missing`));
        controller.enqueue(new Uint8Array(await object.arrayBuffer()));
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'video/webm',
        'content-disposition': `attachment; filename="${row.title.replace(/[^\w .-]/g, '_')}-${row.id.slice(0, 8)}.webm"`,
        'cache-control': 'private, no-store',
      },
    });
  });

  app.get('/api/orgs/:id/recordings', async (c) => {
    const orgId = c.req.param('id');
    if (!canManage(await orgRole(c.env, c.get('identity').email, orgId))) return c.json({ error: 'Workspace admins only' }, 403);
    const { results } = await c.env.DB.prepare('SELECT * FROM recordings WHERE org_id = ? ORDER BY started_at DESC LIMIT 200')
      .bind(orgId).all<RecordingRow>();
    return c.json(results.map(recordingJson));
  });
}

/** Look up a recording in an event the caller can reach. Returns an error response instead of throwing. */
async function recordingFor(c: Context<AppEnv>, rid: string, eventId: string) {
  const actor = await actorFor(c.env, c.get('identity'), eventId);
  if (!actor) return { row: null, actor: null, error: c.json({ error: 'No access to this event' }, 403) };
  const row = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ? AND event_id = ?').bind(rid, eventId).first<RecordingRow>();
  return { row: row ?? null, actor, error: null };
}

function recordingJson(r: RecordingRow) {
  return {
    id: r.id, eventId: r.event_id, title: r.title, startedBy: r.started_by, startedAt: r.started_at, endedAt: r.ended_at,
    status: r.status, parts: r.parts, bytes: r.bytes,
  };
}
