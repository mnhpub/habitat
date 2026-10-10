import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platform, json } from './fixtures/platform';
import { runScheduled } from '../src/worker/scheduler';
import { signUnsubscribe } from '../src/worker/tokens';

const OWNER = 'owner@acme.test';
const ADMIN = 'admin@acme.test';
const STAFF = 'staff@acme.test';
const OUTSIDER = 'owner@beta.test';
const body = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });
const put = (value: unknown) => ({ method: 'PUT', body: JSON.stringify(value) });
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function acme() {
  const p = platform();
  const res = await p.request('/api/orgs', body({ name: 'Acme' }), OWNER);
  assert.equal(res.status, 201);
  const { id } = await json<{ id: string }>(res);
  return { p, id };
}

test('anyone can open a workspace and sees only the workspaces they belong to', async () => {
  const { p, id } = await acme();
  assert.deepEqual((await json(await p.request('/api/orgs', {}, OWNER))).map((o: any) => [o.name, o.role]), [['Acme', 'owner']]);
  assert.deepEqual(await json(await p.request('/api/orgs', {}, OUTSIDER)), []);
  // A stranger can see a workspace's name and public sessions, but not its team.
  const view = await json(await p.request(`/api/orgs/${id}`, {}, OUTSIDER));
  assert.equal(view.name, 'Acme');
  assert.equal(view.role, null);
  assert.equal(view.members, undefined);
});

test('members manage the team by role: admins add people, members cannot, and the last owner stays', async () => {
  const { p, id } = await acme();
  assert.equal((await p.request(`/api/orgs/${id}/members`, put({ email: ADMIN, role: 'admin' }), OWNER)).status, 200);
  assert.equal((await p.request(`/api/orgs/${id}/members`, put({ email: STAFF, role: 'member' }), ADMIN)).status, 200);
  assert.equal((await p.request(`/api/orgs/${id}/members`, put({ email: STAFF, role: 'owner' }), ADMIN)).status, 403, 'admins cannot make owners');
  assert.equal((await p.request(`/api/orgs/${id}/members`, put({ email: OWNER, role: 'admin' }), ADMIN)).status, 403, 'admins cannot demote owners');
  assert.equal((await p.request(`/api/orgs/${id}/members`, put({ email: 'x@acme.test', role: 'member' }), STAFF)).status, 403);
  assert.equal((await p.request(`/api/orgs/${id}/members`, put({ email: OWNER, role: 'admin' }), OWNER)).status, 400, 'the last owner stays');
  assert.equal((await p.request(`/api/orgs/${id}/members/${encodeURIComponent(STAFF)}`, { method: 'DELETE' }, ADMIN)).status, 200);
  const members = (await json(await p.request(`/api/orgs/${id}`, {}, OWNER))).members.map((m: any) => m.email);
  assert.deepEqual(members.sort(), [ADMIN, OWNER].sort());
});

test('events belong to a workspace: outsiders cannot create in it, and a person with no workspace gets their own', async () => {
  const { p, id } = await acme();
  const denied = await p.request('/api/events', body({ name: 'Sneaky', orgId: id }), OUTSIDER);
  assert.equal(denied.status, 403);
  const created = await p.request('/api/events', body({ name: 'Summit', orgId: id, startsAt: Date.now() + 86_400_000 }), OWNER);
  assert.equal(created.status, 201);
  const listed = (await json(await p.request('/api/events', {}, OWNER))).find((e: any) => e.name === 'Summit');
  assert.equal(listed.orgId, id);
  assert.ok(listed.startsAt > Date.now());

  const fresh = await p.request('/api/events', body({ name: 'First' }), 'new@gamma.test');
  assert.equal(fresh.status, 201);
  assert.deepEqual((await json(await p.request('/api/orgs', {}, 'new@gamma.test'))).map((o: any) => o.name), ["new's workspace"]);
  assert.equal((await p.request('/api/events', body({ name: 'Far', orgId: id, startsAt: Date.now() + 40 * 365 * 86_400_000 }), OWNER)).status, 400);
});

test('a recurring series creates its sessions once, and the scheduler does not duplicate them', async () => {
  const { p, id } = await acme();
  const created = await p.request(`/api/orgs/${id}/series`, body({
    name: 'Weekly sync', venue: 'Room 4', durationMin: 45, timezone: 'UTC', timeOfDay: '18:00', freq: 'weekly',
    interval: 1, byDay: [], startsOn: soon(2), maxOccurrences: 3,
  }), OWNER);
  assert.equal(created.status, 201);
  const { id: seriesId, sessions } = await json(created);
  assert.equal(sessions, 3);

  const rows = p.db.prepare('SELECT starts_at, duration_min, join_open FROM events WHERE series_id = ? ORDER BY starts_at').all(seriesId) as any[];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.duration_min === 45 && r.join_open === 1));

  await runScheduled(p.env as never);
  await runScheduled(p.env as never);
  assert.equal((p.db.prepare('SELECT COUNT(*) AS n FROM events WHERE series_id = ?').get(seriesId) as any).n, 3);
  assert.equal((await p.request(`/api/orgs/${id}/series/${seriesId}`, { method: 'DELETE' }, STAFF)).status, 403, 'other members cannot stop it');
  assert.equal((await p.request(`/api/orgs/${id}/series/${seriesId}`, { method: 'DELETE' }, OWNER)).status, 200, 'the creator can stop it');
});

test('followers get a calendar feed of public sessions only, and private sessions never leak', async () => {
  const { p, id } = await acme();
  await p.request(`/api/orgs/${id}/series`, body({ name: 'Open talk', timezone: 'UTC', timeOfDay: '12:00', freq: 'weekly', interval: 1, byDay: [], startsOn: soon(1), maxOccurrences: 2 }), OWNER);
  await p.request('/api/events', body({ name: 'Board private', orgId: id, joinOpen: false, startsAt: Date.now() + 86_400_000 }), OWNER);

  assert.equal((await p.request(`/api/subscriptions/org/${id}`, { method: 'PUT' }, 'fan@x.test')).status, 200);
  const subs = await json(await p.request('/api/subscriptions', {}, 'fan@x.test'));
  const path = new URL(subs[0].feedUrl).pathname;
  const feed = await p.request(path, {}, 'anyone@nowhere.test');
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type')!, /text\/calendar/);
  const ics = await feed.text();
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2, 'only the two series sessions; the private session is excluded');
  assert.doesNotMatch(ics, /Board private/);
  assert.equal((await p.request('/api/public/feeds/not-a-token.ics', {}, 'x')).status, 404);
});

test('a private series cannot be followed, and unsubscribing stops email and following for that workspace', async () => {
  const { p, id } = await acme();
  const series = await json(await p.request(`/api/orgs/${id}/series`, body({ name: 'Private', timezone: 'UTC', timeOfDay: '09:00', freq: 'monthly', dayOfMonth: 1, startsOn: soon(1), joinOpen: false }), OWNER));
  assert.equal((await p.request(`/api/subscriptions/series/${series.id}`, { method: 'PUT' }, 'fan@x.test')).status, 404);

  await p.request(`/api/subscriptions/org/${id}`, { method: 'PUT' }, 'fan@x.test');
  const token = await signUnsubscribe(p.env.UNSUBSCRIBE_SECRET, 'fan@x.test', id);
  const page = await p.request(`/api/public/unsubscribe?t=${encodeURIComponent(token)}`, {}, 'anyone@nowhere.test');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post"/);
  assert.equal((await p.request(`/api/public/unsubscribe?t=${token}`, { method: 'POST' }, 'anyone@nowhere.test')).status, 200);
  assert.deepEqual(await json(await p.request('/api/subscriptions', {}, 'fan@x.test')), []);
  assert.equal((p.db.prepare('SELECT COUNT(*) AS n FROM email_optouts WHERE email = ? AND org_id = ?').get('fan@x.test', id) as any).n, 1);

  // Change the signed payload itself. (Editing the last signature character can leave the decoded bytes unchanged.)
  const forged = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  assert.equal((await p.request(`/api/public/unsubscribe?t=${forged}`, {}, 'x')).status, 400, 'a changed token is refused');
});

test('workspace admins only: campaigns cannot be read or written by other tenants', async () => {
  const { p, id } = await acme();
  await p.request(`/api/orgs/${id}/campaigns`, body({ subject: 'Hi', body: 'Hello', audience: { kind: 'subscribers' } }), OWNER);
  assert.equal((await p.request(`/api/orgs/${id}/campaigns`, {}, OUTSIDER)).status, 403);
  assert.equal((await p.request(`/api/orgs/${id}/campaigns`, body({ subject: 'x', body: 'y', audience: { kind: 'subscribers' } }), OUTSIDER)).status, 403);
  assert.equal((await p.request(`/api/orgs/${id}/recordings`, {}, OUTSIDER)).status, 403);
});

test('an audience can only name sessions and series from its own workspace', async () => {
  const { p, id } = await acme();
  const other = await json(await p.request('/api/orgs', body({ name: 'Beta' }), OUTSIDER));
  await p.request('/api/events', body({ name: 'Acme only', orgId: id, startsAt: Date.now() + 86_400_000 }), OWNER);
  const acmeEvent = (p.db.prepare("SELECT id FROM events WHERE name = 'Acme only'").get() as any).id;
  const res = await p.request(`/api/orgs/${other.id}/campaigns`, body({ subject: 'x', body: 'y', audience: { kind: 'event', eventId: acmeEvent } }), OUTSIDER);
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /not in this workspace/);
});
