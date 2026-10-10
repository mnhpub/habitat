import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platform, json } from './fixtures/platform';
import { runScheduled } from '../src/worker/scheduler';
import { materializeSeries } from '../src/worker/series';
import { signUnsubscribe } from '../src/worker/tokens';

const OWNER = 'owner@acme.test';
const body = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function workspace() {
  const p = platform();
  const { id } = await json(await p.request('/api/orgs', body({ name: 'Acme' }), OWNER));
  return { p, id };
}

const follow = (p: ReturnType<typeof platform>, orgId: string, email: string) =>
  p.request(`/api/subscriptions/org/${orgId}`, { method: 'PUT' }, email);

test('a campaign goes to subscribers who have not opted out, with one-click unsubscribe headers', async () => {
  const { p, id } = await workspace();
  await follow(p, id, 'f1@x.test');
  await follow(p, id, 'f2@x.test');
  const token = await signUnsubscribe(p.env.UNSUBSCRIBE_SECRET, 'f2@x.test', id);
  await p.request(`/api/public/unsubscribe?t=${token}`, { method: 'POST' }, 'f2@x.test');

  const created = await p.request(`/api/orgs/${id}/campaigns`, body({
    subject: 'Spring line-up', body: 'Hello everyone.\n\nThe line-up is out.', audience: { kind: 'subscribers' },
  }), OWNER);
  const { id: cid } = await json(created);
  const sent = await p.request(`/api/orgs/${id}/campaigns/${cid}/send`, { method: 'POST' }, OWNER);
  assert.equal(sent.status, 202);
  await p.drain();

  assert.deepEqual(p.outbox.map((m) => m.to), ['f1@x.test'], 'the opted-out person gets nothing');
  const mail = p.outbox[0];
  assert.equal(mail.subject, 'Spring line-up');
  assert.match(mail.text, /The line-up is out\./);
  assert.match(mail.text, /https:\/\/habitat\.test\/api\/public\/unsubscribe\?t=/);
  assert.equal(mail.headers!['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(mail.headers!['List-Unsubscribe'], /^<https:\/\/habitat\.test\/api\/public\/unsubscribe\?t=/);

  const [row] = await json(await p.request(`/api/orgs/${id}/campaigns`, {}, OWNER));
  assert.equal(row.status, 'sent');
  assert.equal(row.total, 1, 'unsubscribing also removed the follow, so they are not in the audience');
  assert.equal(row.sent, 1);
  assert.equal(row.failed, 0);
  assert.equal((await p.request(`/api/orgs/${id}/campaigns/${cid}/send`, { method: 'POST' }, OWNER)).status, 409);
});

test('a bounced address is retried and then marked failed, without stopping the rest', async () => {
  const { p, id } = await workspace();
  await follow(p, id, 'bounce@bounce.test');
  await follow(p, id, 'ok@x.test');
  const { id: cid } = await json(await p.request(`/api/orgs/${id}/campaigns`, body({ subject: 'Hi', body: 'Hello', audience: { kind: 'subscribers' } }), OWNER));
  await p.request(`/api/orgs/${id}/campaigns/${cid}/send`, { method: 'POST' }, OWNER);
  await p.drain();
  assert.deepEqual(p.outbox.map((m) => m.to), ['ok@x.test']);
  for (let i = 0; i < 3; i++) await runScheduled(p.env as never);
  const [row] = await json(await p.request(`/api/orgs/${id}/campaigns`, {}, OWNER));
  assert.equal(row.status, 'sent');
  assert.equal(row.sent, 1);
  assert.equal(row.failed, 1);
});

test('sending refuses clearly until email is configured', async () => {
  const { p, id } = await workspace();
  await follow(p, id, 'f1@x.test');
  const { id: cid } = await json(await p.request(`/api/orgs/${id}/campaigns`, body({ subject: 'Hi', body: 'Hello', audience: { kind: 'subscribers' } }), OWNER));
  const secret = p.env.UNSUBSCRIBE_SECRET;
  delete p.env.UNSUBSCRIBE_SECRET;
  const res = await p.request(`/api/orgs/${id}/campaigns/${cid}/send`, { method: 'POST' }, OWNER);
  p.env.UNSUBSCRIBE_SECRET = secret;
  assert.equal(res.status, 503);
  assert.match((await json(res)).error, /UNSUBSCRIBE_SECRET/);
  assert.equal(p.outbox.length, 0);
});

test('an event audience uses the registered roster, not people who are waitlisted', async () => {
  const { p, id } = await workspace();
  await p.request('/api/events', body({ name: 'Summit', orgId: id, startsAt: Date.now() + 86_400_000 }), OWNER);
  const eventId = (p.db.prepare("SELECT id FROM events WHERE name = 'Summit'").get() as any).id;
  const room = p.room(eventId);
  const organizer = { email: OWNER, name: 'owner', roles: ['organizer'] as const, warp: true };
  const attendee = (email: string) => ({ email, name: email, roles: ['attendee'] as const, warp: true });
  // The seeded demo guests hold seats too, so capacity is set from the current registrations.
  const seated = (await room.snapshot(organizer as any)).state.guests.filter((g) => !g.waitlisted).length;
  await room.command(organizer as any, { type: 'SET_SIGNUP_FORM', open: true, capacity: seated + 2, questions: [] });
  await room.command(attendee('in@x.test') as any, { type: 'SIGNUP', mode: 'online', answers: {} });
  // Registered, but opted out of this workspace: stays on the roster and is suppressed at send time.
  await room.command(attendee('optout@x.test') as any, { type: 'SIGNUP', mode: 'online', answers: {} });
  await p.db.prepare('INSERT INTO email_optouts (email, org_id, at) VALUES (?, ?, ?)').run('optout@x.test', id, Date.now());
  await room.command(attendee('wait@x.test') as any, { type: 'SIGNUP', mode: 'online', answers: {} });

  const { id: cid } = await json(await p.request(`/api/orgs/${id}/campaigns`, body({ subject: 'Summit', body: 'See you there', audience: { kind: 'event', eventId } }), OWNER));
  await p.request(`/api/orgs/${id}/campaigns/${cid}/send`, { method: 'POST' }, OWNER);
  await p.drain();
  assert.deepEqual(p.outbox.map((m) => m.to), ['in@x.test']);
  const rows = (p.db.prepare('SELECT email, status FROM campaign_recipients WHERE campaign_id = ? ORDER BY email').all(cid) as any[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ email: 'in@x.test', status: 'sent' }, { email: 'optout@x.test', status: 'suppressed' }]);
});

test('followers of a series hear about each new session once, and only for sessions created after they followed', async () => {
  const { p, id } = await workspace();
  const made = await json(await p.request(`/api/orgs/${id}/series`, body({
    name: 'Town hall', timezone: 'UTC', timeOfDay: '10:00', freq: 'weekly', interval: 1, byDay: [], startsOn: soon(1), maxOccurrences: 52,
  }), OWNER));
  await p.request(`/api/subscriptions/series/${made.id}`, { method: 'PUT' }, 'fan@x.test');
  const row = p.db.prepare('SELECT * FROM series WHERE id = ?').get(made.id) as any;
  // Move the window forward: sessions beyond the first eight weeks are created now and announced.
  const created = await materializeSeries(p.env as never, { ...row }, Date.now() + 14 * 86_400_000);
  assert.ok(created >= 1, 'later sessions are created');
  await runScheduled(p.env as never);
  await p.drain();
  const notices = p.outbox.filter((m) => m.subject.startsWith('New session: Town hall'));
  assert.equal(notices.length, created);
  assert.ok(notices.every((m) => m.to === 'fan@x.test' && m.text.includes('/e/')));

  // Running the scheduler again does not repeat them.
  await runScheduled(p.env as never);
  await p.drain();
  assert.equal(p.outbox.filter((m) => m.subject.startsWith('New session: Town hall')).length, created);
});

test("workspace admins cannot email an event roster they do not organize", async () => {
  const { p, id } = await workspace();
  await p.request(`/api/orgs/${id}/members`, { method: 'PUT', body: JSON.stringify({ email: 'admin@acme.test', role: 'admin' }) }, OWNER);
  await p.request('/api/events', body({ name: 'Gala', orgId: id, startsAt: Date.now() + 86_400_000 }), OWNER);
  const eventId = (p.db.prepare("SELECT id FROM events WHERE name = 'Gala'").get() as any).id;
  const attempt = { subject: 'Gala', body: 'See you', audience: { kind: 'event', eventId } };
  const refused = await p.request(`/api/orgs/${id}/campaigns`, body(attempt), 'admin@acme.test');
  assert.equal(refused.status, 403);
  // The event's organizer can do it.
  assert.equal((await p.request(`/api/orgs/${id}/campaigns`, body(attempt), OWNER)).status, 201);
});

/** Upload a short recording the way the browser does: one part at a time, in order, then stop. */
async function recordingSetup() {
  const { p, id } = await workspace();
  await p.request('/api/events', body({ name: 'Studio', orgId: id, startsAt: Date.now() + 86_400_000 }), OWNER);
  const eventId = (p.db.prepare("SELECT id FROM events WHERE name = 'Studio'").get() as any).id;
  await p.room(eventId).command({ email: OWNER, name: 'owner', roles: ['organizer'], warp: true }, { type: 'CALL_JOIN', sessionId: 's1', tracks: ['camera'] });
  return { p, id, eventId };
}

const upload = (p: ReturnType<typeof platform>, eventId: string, rid: string, n: number, bytes: number[], email = OWNER) =>
  p.request(`/api/events/${eventId}/recordings/${rid}/parts/${n}`, { method: 'POST', body: new Uint8Array(bytes) }, email);

test('a team session is recorded in ordered parts and downloads as one file once stopped', async () => {
  const { p, id, eventId } = await recordingSetup();
  assert.equal((await p.request(`/api/events/${eventId}/recordings`, body({ consent: false }), OWNER)).status, 400, 'consent is required');
  const started = await p.request(`/api/events/${eventId}/recordings`, body({ consent: true, title: 'Team sync' }), OWNER);
  assert.equal(started.status, 201);
  const { id: rid } = await json(started);

  assert.equal((await upload(p, eventId, rid, 0, [1, 2, 3])).status, 200);
  const skipped = await upload(p, eventId, rid, 2, [9]);
  assert.equal(skipped.status, 409, 'a skipped part is refused');
  assert.equal((await upload(p, eventId, rid, 1, [4, 5])).status, 200);
  assert.equal((await upload(p, eventId, rid, 1, [7])).status, 409, 'a repeated part is refused');
  assert.equal((await upload(p, eventId, rid, 2, [6], 'stranger@x.test')).status, 403, 'only the starter can upload');

  assert.equal((await p.request(`/api/events/${eventId}/recordings/${rid}/media`, {}, OWNER)).status, 409, 'not while recording');
  assert.equal((await p.request(`/api/events/${eventId}/recordings/${rid}/stop`, { method: 'POST' }, OWNER)).status, 200);

  const media = await p.request(`/api/events/${eventId}/recordings/${rid}/media`, {}, OWNER);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'video/webm');
  assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.equal(p.db.prepare('SELECT status, parts FROM recordings WHERE id = ?').get(rid)!.status, 'ready');
});

test('recordings are private to crew, the starter and workspace admins', async () => {
  const { p, id, eventId } = await recordingSetup();
  const { id: rid } = await json(await p.request(`/api/events/${eventId}/recordings`, body({ consent: true }), OWNER));
  await upload(p, eventId, rid, 0, [1]);
  await p.request(`/api/events/${eventId}/recordings/${rid}/stop`, { method: 'POST' }, OWNER);

  assert.equal((await json(await p.request(`/api/events/${eventId}/recordings`, {}, 'guest@x.test'))).length, 0);
  assert.equal((await json(await p.request(`/api/events/${eventId}/recordings`, {}, OWNER))).length, 1);
  assert.equal((await json(await p.request(`/api/orgs/${id}/recordings`, {}, OWNER))).length, 1);
  assert.equal((await p.request(`/api/events/${eventId}/recordings/${rid}/media`, {}, 'guest@x.test')).status, 403);
});

test('deleting an event removes its recordings', async () => {
  const { p, eventId } = await recordingSetup();
  const { id: rid } = await json(await p.request(`/api/events/${eventId}/recordings`, body({ consent: true }), OWNER));
  await upload(p, eventId, rid, 0, [1, 2]);
  assert.equal(p.parts.size, 1);
  assert.equal((await p.request(`/api/events/${eventId}`, { method: 'DELETE' }, OWNER)).status, 200);
  assert.equal(p.parts.size, 0);
  assert.equal((p.db.prepare('SELECT COUNT(*) AS n FROM recordings').get() as any).n, 0);
});
