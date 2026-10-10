import { test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/worker/index';
import { devCookie } from '../src/worker/auth';
import { fixture } from './fixtures/room';
import { d1, migratedDatabase } from './fixtures/platform';

function apiFixture() {
  const db = migratedDatabase();
  const rooms = new Map<string, ReturnType<typeof fixture>>();
  const env = {
    DEV_AUTH: 'true', REQUIRE_WARP_FOR_PRODUCTION: 'true',
    DB: d1(db),
    EVENTS: {
      idFromName: (id: string) => id,
      get(id: string) {
        if (!rooms.has(id)) {
          const f = fixture();
          (f.room as any).env = env;
          rooms.set(id, f);
        }
        return rooms.get(id)!.room;
      },
    },
  };
  const request = (path: string, init: RequestInit = {}, email = 'org@example.com', warp = true) => app.fetch(new Request(`http://localhost${path}`, {
    ...init, headers: { cookie: devCookie(email, email, warp).split(';')[0], ...init.headers },
  }), env as never, { waitUntil: (_promise: Promise<unknown>) => {} } as never);
  return { request, rooms, db };
}

test('API command validation returns structured 400 errors without changing state', async () => {
  const f = apiFixture();
  const created = await f.request('/api/events', { method: 'POST', body: JSON.stringify({ name: 'Test', venue: 'Hall', joinOpen: false }) });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  for (const body of [JSON.stringify({ type: 'constructor' }), JSON.stringify({ type: 'SET_HAND_STATUS', handId: 'h1', status: 'bad' }), '{']) {
    const response = await f.request(`/api/events/${id}/commands`, { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json() as { error: string }).error, 'string');
  }
  const snapshot = await f.request(`/api/events/${id}/snapshot`);
  assert.equal((await snapshot.json() as any).state.seq, 0);
});

test('production HTTP commands recheck device trust and preserve 403 status', async () => {
  const f = apiFixture();
  const created = await f.request('/api/events', { method: 'POST', body: JSON.stringify({ name: 'Test' }) });
  const { id } = await created.json() as { id: string };
  const response = await f.request(`/api/events/${id}/commands`, { method: 'POST', body: JSON.stringify({ type: 'TAKE' }) }, 'org@example.com', false);
  assert.equal(response.status, 403);
});

test('event listing reads authoritative names and member deletion denies private event access', async () => {
  const f = apiFixture();
  const created = await f.request('/api/events', { method: 'POST', body: JSON.stringify({ name: 'Original', venue: 'Hall', joinOpen: false }) });
  const { id } = await created.json() as { id: string };
  await f.request(`/api/events/${id}/members`, { method: 'PUT', body: JSON.stringify({ email: 'crew@example.com', roles: ['producer'] }) });
  assert.equal((await f.request(`/api/events/${id}/snapshot`, {}, 'crew@example.com')).status, 200);
  const rename = await f.request(`/api/events/${id}/commands`, { method: 'POST', body: JSON.stringify({ type: 'RENAME_EVENT', name: 'New name', venue: 'Stage' }) });
  assert.equal(rename.status, 200);
  const listed = await (await f.request('/api/events')).json() as any[];
  assert.equal(listed[0].name, 'New name');
  assert.equal(listed[0].venue, 'Stage');
  const row = f.db.prepare('SELECT name, venue FROM events WHERE id = ?').get(id);
  assert.equal(row!.name, 'New name');
  await f.request(`/api/events/${id}/members/crew%40example.com`, { method: 'DELETE' });
  assert.equal((await f.request(`/api/events/${id}/snapshot`, {}, 'crew@example.com')).status, 403);
});

test('API rejects oversized request bodies before writing event state', async () => {
  const f = apiFixture();
  const response = await f.request('/api/events', { method: 'POST', body: JSON.stringify({ name: 'Test', excess: 'x'.repeat(20_000) }) });
  assert.equal(response.status, 413);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count, 0);
});
