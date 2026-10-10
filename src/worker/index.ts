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
import { MAX_CALL_TRACKS, TRACK_NAME } from '../shared/call';
import { RealtimeError, answerSession, publishTracks, subscribeTracks } from './realtime';
import { orgRole } from './tenancy';
import { createEvent, purgeRecordings } from './events-db';
import { mountWorkspaces } from './routes/workspaces';
import { mountMarketing } from './routes/marketing';
import { mountRecordings } from './routes/recordings';
import { runScheduled } from './scheduler';
import type { AppVars } from './app-types';

export { EventRoom } from './event-room';

type Vars = AppVars;
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
  // Unsubscribe links and calendar feeds come from email and calendar apps, which cannot sign in.
  // Access must bypass /api/public/* (see README); every route there checks its own token.
  if (c.req.path.startsWith('/api/public/')) return next();
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

mountWorkspaces(app);
mountMarketing(app);
mountRecordings(app);

app.get('/api/me', (c) => {
  const id = c.get('identity');
  return c.json({ identity: id, devAuth: id.source === 'dev', requireWarp: c.env.REQUIRE_WARP_FOR_PRODUCTION === 'true' });
});

// ------------------------------------------------------------------ events

interface EventRow {
  id: string; name: string; kind: string; venue: string; created_by: string; created_at: number; join_open: number;
  org_id: string | null; starts_at: number | null; duration_min: number; series_id: string | null; roles?: string | null;
}

app.get('/api/events', async (c) => {
  const email = c.get('identity').email;
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, m.roles FROM events e LEFT JOIN members m ON m.event_id = e.id AND m.email = ?1
     WHERE m.email IS NOT NULL OR e.join_open = 1 ORDER BY COALESCE(e.starts_at, e.created_at) DESC LIMIT 100`,
  ).bind(email).all<EventRow>();
  return c.json(await Promise.all(results.map(async (r) => ({
    id: r.id, ...(await room(c.env, r.id).metadata()), kind: r.kind, createdAt: r.created_at,
    orgId: r.org_id, startsAt: r.starts_at, durationMin: r.duration_min, seriesId: r.series_id,
    roles: r.roles ? (JSON.parse(r.roles) as Role[]) : ['attendee'], member: !!r.roles,
  }))));
});

/** Create an event in a workspace. Without one, the event goes into the person's own workspace, created on first use. */
app.post('/api/events', async (c) => {
  const id = c.get('identity');
  const body = await readJson(c.req.raw);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return c.json({ error: 'Give the event a name (up to 120 characters)' }, 400);
  if ((body.venue !== undefined && (typeof body.venue !== 'string' || body.venue.length > 120)) ||
      (body.joinOpen !== undefined && typeof body.joinOpen !== 'boolean')) return c.json({ error: 'Invalid event settings' }, 400);
  const now = Date.now();
  if (body.startsAt !== undefined && (typeof body.startsAt !== 'number' || !Number.isFinite(body.startsAt) ||
      body.startsAt < now - 86_400_000 || body.startsAt > now + 5 * 365 * 86_400_000)) return c.json({ error: 'Pick a date within the next five years' }, 400);
  const durationMin = body.durationMin === undefined ? 60 : Number(body.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 1440) return c.json({ error: 'Sessions last 15 minutes to 24 hours' }, 400);
  const kind = body.kind === 'social' ? 'social' : 'corporate';
  let orgId = typeof body.orgId === 'string' ? body.orgId : null;
  if (orgId) {
    if (!(await orgRole(c.env, id.email, orgId))) return c.json({ error: 'You are not a member of that workspace' }, 403);
  } else {
    orgId = await personalWorkspace(c.env, id.email, id.name);
  }
  const eventId = crypto.randomUUID();
  await createEvent(c.env, {
    id: eventId, orgId, name, kind, venue: (body.venue as string | undefined) ?? '', createdBy: id.email,
    joinOpen: body.joinOpen !== false, startsAt: typeof body.startsAt === 'number' ? body.startsAt : null, durationMin,
  });
  return c.json({ id: eventId }, 201);
});

/** The workspace a person's events go into when they name none. Created the first time it is needed. */
async function personalWorkspace(env: Env, email: string, name: string): Promise<string> {
  const existing = await env.DB.prepare('SELECT org_id FROM org_members WHERE email = ? ORDER BY added_at LIMIT 1')
    .bind(email).first<{ org_id: string }>();
  if (existing) return existing.org_id;
  const id = `ws-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(id, `${name}'s workspace`, email, now),
    env.DB.prepare("INSERT INTO org_members (org_id, email, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)").bind(id, email, email, now),
  ]);
  return id;
}

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
  await purgeRecordings(c.env, eventId);
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

// ------------------------------------------------------------------ video room (Cloudflare Realtime)

function videoError(err: unknown): { status: 503 | 502; body: { error: string } } {
  if (err instanceof RealtimeError) return { status: err.status === 503 ? 503 : 502, body: { error: err.message } };
  console.error('Video room request failed', err);
  return { status: 502, body: { error: 'Video could not connect. Try again in a moment.' } };
}

const sdpText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200_000;
const sessionIdText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

/** Publish this person's camera and microphone. The server creates the SFU session, then records it in the room. */
app.post('/api/events/:id/calls/publish', async (c) => {
  const eventId = c.req.param('id');
  const actor = await actorFor(c.env, c.get('identity'), eventId);
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const body = await readJson(c.req.raw);
  const tracks = Array.isArray(body.tracks) ? (body.tracks as { mid?: unknown; trackName?: unknown }[]) : [];
  if (!sdpText(body.sdp) || !tracks.length || tracks.length > MAX_CALL_TRACKS ||
      tracks.some((t) => typeof t.mid !== 'string' || typeof t.trackName !== 'string' || !TRACK_NAME.test(t.trackName))) {
    return c.json({ error: 'Invalid video publish request' }, 400);
  }
  const names = tracks.map((t) => t.trackName as string);
  try {
    const { sessionId, answer } = await publishTracks(c.env, body.sdp, tracks.map((t) => ({ mid: t.mid as string, trackName: t.trackName as string })));
    const result = await room(c.env, eventId).command(actor, { type: 'CALL_JOIN', sessionId, tracks: names });
    if (!result.ok) return c.json(result, errorStatus(result.status ?? 400));
    return c.json({ sessionId, answer });
  } catch (err) {
    const { status, body: out } = videoError(err);
    return c.json(out, status);
  }
});

/** Receive another participant's published tracks. Only tracks listed in the room can be requested. */
app.post('/api/events/:id/calls/subscribe', async (c) => {
  const eventId = c.req.param('id');
  const actor = await actorFor(c.env, c.get('identity'), eventId);
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const body = await readJson(c.req.raw);
  const trackNames = Array.isArray(body.trackNames) ? body.trackNames : [];
  if (!sessionIdText(body.publisherSessionId) || !trackNames.length || trackNames.length > MAX_CALL_TRACKS ||
      trackNames.some((t) => typeof t !== 'string' || !TRACK_NAME.test(t))) {
    return c.json({ error: 'Invalid video subscribe request' }, 400);
  }
  const snap = await room(c.env, eventId).snapshot(actor);
  const publisher = snap.state.call.find((p) => p.sessionId === body.publisherSessionId);
  if (!publisher || trackNames.some((t) => !publisher.tracks.includes(t as string))) {
    return c.json({ error: 'That video is no longer in the room' }, 404);
  }
  try {
    const { sessionId, offer } = await subscribeTracks(c.env, body.publisherSessionId, trackNames as string[]);
    return c.json({ sessionId, offer });
  } catch (err) {
    const { status, body: out } = videoError(err);
    return c.json(out, status);
  }
});

/** Complete a receiving session's offer/answer exchange. */
app.post('/api/events/:id/calls/answer', async (c) => {
  const actor = await actorFor(c.env, c.get('identity'), c.req.param('id'));
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const body = await readJson(c.req.raw);
  if (!sessionIdText(body.sessionId) || !sdpText(body.sdp)) return c.json({ error: 'Invalid video answer' }, 400);
  try {
    await answerSession(c.env, body.sessionId, body.sdp);
    return c.json({ ok: true });
  } catch (err) {
    const { status, body: out } = videoError(err);
    return c.json(out, status);
  }
});

app.post('/api/events/:id/calls/leave', async (c) => {
  const eventId = c.req.param('id');
  const actor = await actorFor(c.env, c.get('identity'), eventId);
  if (!actor) return c.json({ error: 'No access to this event' }, 403);
  const result = await room(c.env, eventId).command(actor, { type: 'CALL_LEAVE' });
  return c.json(result, result.ok ? 200 : errorStatus(result.status ?? 400));
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

export default {
  fetch: app.fetch,
  /** Cron: create sessions for recurring series and keep email campaigns going. */
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
};
