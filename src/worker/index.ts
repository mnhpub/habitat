import { Hono, type Context, type Next } from 'hono';
import type { Env } from './env';
import { authenticate, devAuthEnabled, devCookie, type Identity } from './auth';
import { ALL_ROLES, type Role } from '../shared/types';
import { CommandError } from '../shared/command';
import { resolveActor as actorFor } from './membership';
import { readJson } from './request';
import { getServerByName } from 'partyserver';
import { generateBreakoutNotes, NotesUnavailable } from './notes';
import { translateText } from './translate';
import { isLanguageCode, TRANSLATION_MAX_CHARS } from '../shared/languages';

export { EventRoom } from './event-room';

type Vars = { identity: Identity };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ------------------------------------------------------------------ dev sign-in (localhost only)

app.post('/api/dev/login', async (c) => {
  if (!devAuthEnabled(c.env, c.req.raw)) return c.json({ error: 'Not available' }, 404);
  const body = await readJson(c.req.raw);
  if (typeof body.email !== 'string' || !body.email.includes('@') || body.email.length > 254 ||
      (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)) ||
      (body.warp !== undefined && typeof body.warp !== 'boolean')) return c.json({ error: 'Invalid sign-in details' }, 400);
  c.header('Set-Cookie', devCookie(body.email, body.name as string | undefined ?? body.email.split('@')[0], body.warp as boolean | undefined ?? true));
  return c.json({ ok: true });
});

app.post('/api/dev/logout', (c) => {
  if (!devAuthEnabled(c.env, c.req.raw)) return c.json({ error: 'Not available' }, 404);
  c.header('Set-Cookie', 'dev_user=; Path=/; Max-Age=0');
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ authentication

const requireIdentity = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) => {
  const identity = await authenticate(c.req.raw, c.env, c.req.path.endsWith('/commands'));
  if (!identity) {
    return c.json({ error: 'Not signed in', devAuth: devAuthEnabled(c.env, c.req.raw) }, 401);
  }
  c.set('identity', identity);
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'INSERT INTO users (email, name, last_seen, warp) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(email) DO UPDATE SET name = ?2, last_seen = ?3, warp = ?4',
    ).bind(identity.email, identity.name, Date.now(), identity.warp ? 1 : 0).run().catch(() => undefined),
  );
  await next();
};
app.use('/api/*', requireIdentity);
app.use('/parties/*', requireIdentity);

app.get('/api/me', (c) => {
  const id = c.get('identity');
  return c.json({ identity: id, devAuth: id.source === 'dev', requireWarp: c.env.REQUIRE_WARP_FOR_PRODUCTION === 'true' });
});

// ------------------------------------------------------------------ events

interface EventRow { id: string; name: string; kind: string; venue: string; created_by: string; created_at: number; join_open: number; roles?: string | null }

app.get('/api/events', async (c) => {
  const email = c.get('identity').email;
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, m.roles FROM events e LEFT JOIN members m ON m.event_id = e.id AND m.email = ?1
     WHERE m.email IS NOT NULL OR e.join_open = 1 ORDER BY e.created_at DESC LIMIT 100`,
  ).bind(email).all<EventRow>();
  return c.json(await Promise.all(results.map(async (r) => ({
    id: r.id, ...(await room(c.env, r.id).metadata()), kind: r.kind, createdAt: r.created_at,
    roles: r.roles ? (JSON.parse(r.roles) as Role[]) : ['attendee'], member: !!r.roles,
  }))));
});

app.post('/api/events', async (c) => {
  const id = c.get('identity');
  const body = await readJson(c.req.raw);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return c.json({ error: 'Give the event a name (up to 120 characters)' }, 400);
  if ((body.venue !== undefined && (typeof body.venue !== 'string' || body.venue.length > 120)) ||
      (body.joinOpen !== undefined && typeof body.joinOpen !== 'boolean')) return c.json({ error: 'Invalid event settings' }, 400);
  const kind = body.kind === 'social' ? 'social' : 'corporate';
  const eventId = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO events (id, name, kind, venue, created_by, created_at, join_open) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(eventId, name, kind, body.venue ?? '', id.email, now, body.joinOpen === false ? 0 : 1),
    c.env.DB.prepare('INSERT INTO members (event_id, email, name, roles, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(eventId, id.email, id.name, JSON.stringify(['organizer']), id.email, now),
  ]);
  await room(c.env, eventId).init(eventId, name, kind, id.email, body.venue as string | undefined ?? '');
  return c.json({ id: eventId }, 201);
});

function room(env: Env, eventId: string) {
  return env.EVENTS.get(env.EVENTS.idFromName(eventId));
}

app.get('/api/events/:id/snapshot', async (c) => {
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  return c.json(await room(c.env, c.req.param('id')).snapshot(actor));
});

app.post('/api/events/:id/commands', async (c) => {
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const cmd = await readJson(c.req.raw);
  const result = await room(c.env, c.req.param('id')).command(actor, cmd);
  return c.json(result, result.ok ? 200 : errorStatus(result.status ?? 400));
});

app.get('/api/events/:id/journal', async (c) => {
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const before = c.req.query('before');
  const limit = Number(c.req.query('limit') ?? 100);
  return c.json(await room(c.env, c.req.param('id')).journal(actor, before ? Number(before) : null, limit));
});

// Live event socket: PartyServer routes /parties/events/:id to the event's EventRoom.
// The Worker has already checked Access and membership, so the room trusts these headers.
app.get('/parties/events/:id', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.json({ error: 'Expected WebSocket' }, 426);
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Actor', JSON.stringify(actor));
  headers.set('X-Session-Expires', String(Math.min(c.get('identity').expiresAt, Date.now() + 5 * 60_000)));
  const live = await getServerByName(c.env.EVENTS, c.req.param('id'));
  return live.fetch(new Request(c.req.raw.url, { headers }));
});

// ------------------------------------------------------------------ translation

app.post('/api/events/:id/translate', async (c) => {
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const body = await readJson(c.req.raw);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > TRANSLATION_MAX_CHARS) return c.json({ error: 'Text to translate is required (up to 500 characters)' }, 400);
  if (!isLanguageCode(body.target)) return c.json({ error: 'Choose a supported language' }, 400);
  if (body.source !== undefined && !isLanguageCode(body.source)) return c.json({ error: 'Choose a supported language' }, 400);
  try {
    const translated = await translateText(c.env, text, body.target, body.source as string | undefined);
    return c.json({ text: translated, source: body.source ?? 'en', target: body.target });
  } catch (err) {
    console.error('Translation failed', err);
    return c.json({ error: 'Translation is unavailable right now. Try again in a moment.' }, 502);
  }
});

// ------------------------------------------------------------------ small-team breakouts

app.post('/api/events/:id/breakouts/:bid/notes', async (c) => {
  const eventId = c.req.param('id');
  const actor = await actorFor(c.env, c.get('identity'), eventId);
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const events = room(c.env, eventId);
  const read = await events.breakoutRoom(actor, c.req.param('bid'));
  if (!read.ok) return c.json({ error: read.error }, errorStatus(read.status));
  if (!read.breakout.messages.length) return c.json({ error: 'Nothing has been said in this breakout yet' }, 400);
  let text: string;
  try {
    text = await generateBreakoutNotes(c.env, read.breakout);
  } catch (err) {
    if (err instanceof NotesUnavailable) return c.json({ error: err.message }, 503);
    console.error('Breakout notes failed', err);
    return c.json({ error: 'Notes could not be generated. Try again in a moment.' }, 502);
  }
  const result = await events.command(actor, { type: 'SET_BREAKOUT_NOTES', breakoutId: read.breakout.id, text });
  return c.json(result, result.ok ? 200 : errorStatus(result.status ?? 400));
});

app.delete('/api/events/:id', async (c) => {
  const eventId = c.req.param('id');
  if (!(await requireOrganizer(c.env, c.get('identity'), eventId))) return c.json({ error: 'Organizers only' }, 403);
  // Membership goes first: once it is gone nobody can reach the room, even if clearing it fails below.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM members WHERE event_id = ?').bind(eventId),
    c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId),
  ]);
  try {
    await room(c.env, eventId).destroy();
  } catch (err) {
    // The event is already gone for everyone; a leftover room holds no reachable data.
    console.error('Event room cleanup failed', err);
  }
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ team (organizers)

async function requireOrganizer(env: Env, identity: Identity, eventId: string): Promise<boolean> {
  const a = await actorFor(env, identity, eventId);
  return !!a?.roles.includes('organizer');
}

app.get('/api/events/:id/members', async (c) => {
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor || actor.roles.every((r) => r === 'attendee')) return c.json({ error: 'Crew only' }, 403);
  const { results } = await c.env.DB.prepare('SELECT email, name, roles, added_at FROM members WHERE event_id = ? ORDER BY added_at')
    .bind(c.req.param('id')).all<{ email: string; name: string; roles: string; added_at: number }>();
  return c.json(results.map((r) => ({ email: r.email, name: r.name, roles: JSON.parse(r.roles) as Role[], addedAt: r.added_at })));
});

app.put('/api/events/:id/members', async (c) => {
  const eventId = c.req.param('id');
  const identity = c.get('identity');
  if (!(await requireOrganizer(c.env, identity, eventId))) return c.json({ error: 'Organizers only' }, 403);
  const body = await readJson(c.req.raw);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@') || email.length > 254) return c.json({ error: 'Valid email required' }, 400);
  if (!Array.isArray(body.roles) || body.roles.some(r => !ALL_ROLES.includes(r as Role)) ||
      (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120))) return c.json({ error: 'Invalid member details' }, 400);
  const roles = [...new Set(body.roles as Role[])];
  if (!roles.length) return c.json({ error: 'Pick at least one role' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO members (event_id, email, name, roles, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(event_id, email) DO UPDATE SET roles = ?4, name = CASE WHEN ?3 = '' THEN members.name ELSE ?3 END`,
  ).bind(eventId, email, (body.name as string | undefined)?.trim() ?? '', JSON.stringify(roles), identity.email, Date.now()).run();
  await room(c.env, eventId).refreshRoles(email, roles);
  return c.json({ ok: true });
});

app.delete('/api/events/:id/members/:email', async (c) => {
  const eventId = c.req.param('id');
  const identity = c.get('identity');
  if (!(await requireOrganizer(c.env, identity, eventId))) return c.json({ error: 'Organizers only' }, 403);
  const email = decodeURIComponent(c.req.param('email')).toLowerCase();
  if (email === identity.email) return c.json({ error: "You can't remove yourself" }, 400);
  await c.env.DB.prepare('DELETE FROM members WHERE event_id = ? AND email = ?').bind(eventId, email).run();
  await room(c.env, eventId).refreshRoles(email, []);
  return c.json({ ok: true });
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  if (err instanceof CommandError) return c.json({ error: err.message }, errorStatus(err.status));
  console.error(err);
  return c.json({ error: 'Server error' }, 500);
});

function errorStatus(status: number): 400 | 403 | 404 | 409 | 413 | 500 {
  return status === 403 || status === 404 || status === 409 || status === 413 || status === 500 ? status : 400;
}

export default app;
