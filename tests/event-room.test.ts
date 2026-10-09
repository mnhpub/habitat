import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, organizer } from './fixtures/room';
import { seedEvent } from '../src/shared/seed';
import { snapshotChunks, MAX_SNAPSHOT_BYTES } from '../src/worker/snapshot-storage';

test('removing a member closes the socket and rejects subsequent commands', async () => {
  const f = fixture();
  await f.room.init('ev', 'Original', 'corporate', organizer.email);
  const ws = f.socket(organizer);
  f.members.delete(organizer.email);
  await f.room.refreshRoles(organizer.email, []);
  assert.equal(ws.closed, true);
  ws.sent.length = 0;
  await f.room.onMessage(ws as never, JSON.stringify({ type: 'cmd', id: 'revoked', cmd: { type: 'REACT', reaction: 'love' } }));
  assert.equal(ws.sent.some(m => m.type === 'ack' && m.result.ok), false);
});

test('production socket commands cannot reuse cached WARP trust', async () => {
  const f = fixture();
  await f.room.init('ev', 'Original', 'corporate', organizer.email);
  const ws = f.socket(organizer);
  await f.room.onMessage(ws as never, JSON.stringify({ type: 'cmd', id: 'take', cmd: { type: 'TAKE' } }));
  assert.equal(ws.sent.find(m => m.type === 'ack')?.result.ok, false);
  assert.equal((await f.room.snapshot(organizer)).state.seq, 0);
});

test('snapshot write failure rolls back both memory and journal', async () => {
  const f = fixture();
  await f.room.init('ev', 'Original', 'corporate', organizer.email);
  const before = await f.room.snapshot(organizer);
  f.setFailSnapshot(true);
  await assert.rejects(f.room.command(organizer, { type: 'REACT', reaction: 'love' }));
  const after = await f.room.snapshot(organizer);
  assert.deepEqual(after.state, before.state);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM journal').get()!.count, 0);
});

test('large snapshots survive persistence and eviction without oversized SQL rows', async () => {
  const f = fixture();
  await f.room.init('ev', 'Original', 'corporate', organizer.email);
  // Construct an existing large event to test the storage boundary without quadratic command setup.
  const state = (f.room as any).state;
  for (let i = 0; i < 5000; i++) state.questions.push({
    id: `q-${i}`, text: 'X'.repeat(280), author: organizer.email, authorName: 'Organizer',
    anonymous: false, where: 'Crew', upvotes: [], status: 'new', ts: Date.now(),
  });
  assert.equal((await f.room.command(organizer, { type: 'REACT', reaction: 'love' })).ok, true);
  const rows = f.db.prepare('SELECT json FROM snapshot_chunks').all();
  assert.ok(rows.every(row => Buffer.byteLength(String(row.json)) < 2_000_000));
  // Constructor reloads the same real SQLite storage.
  const { EventRoom } = await import('../src/worker/event-room');
  const loaded = new EventRoom((f.room as any).ctx, (f.room as any).env);
  assert.equal((await loaded.snapshot(organizer)).state.questions.length, 5004);
});

test('renaming updates the catalog and a failed D1 update is retried by an alarm', async () => {
  const f = fixture();
  await f.room.init('ev', 'Original', 'corporate', organizer.email);
  f.setFailMetadata(true);
  const result = await f.room.command(organizer, { type: 'RENAME_EVENT', name: 'Renamed', venue: 'New venue' });
  assert.equal(result.ok, true);
  assert.equal((await f.room.metadata()).name, 'Renamed');
  f.setFailMetadata(false);
  await f.room.alarm();
  assert.deepEqual(f.metadata(), { name: 'Renamed', venue: 'New venue' });
});

test('legacy single-row state is migrated without losing its sequence or Unicode content', async () => {
  const f = fixture();
  const state = seedEvent('ev', '😀 Summit', 'corporate', organizer.email, Date.now());
  state.seq = 42;
  f.db.prepare('INSERT INTO snapshot (id, json) VALUES (1, ?)').run(JSON.stringify(state));
  const { EventRoom } = await import('../src/worker/event-room');
  const migrated = new EventRoom((f.room as any).ctx, (f.room as any).env);
  const snap = await migrated.snapshot(organizer);
  assert.equal(snap.state.seq, 42);
  assert.equal(snap.state.name, '😀 Summit');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM snapshot').get()!.count, 0);
});

test('snapshot chunks preserve surrogate pairs and reject unbounded state', () => {
  const state = seedEvent('ev', 'Test', 'corporate', organizer.email, Date.now());
  state.questions[0].text = '😀'.repeat(100_000);
  const chunks = snapshotChunks(state);
  const sqliteEncoded = chunks.map(chunk => Buffer.from(chunk).toString('utf8')).join('');
  assert.deepEqual(JSON.parse(sqliteEncoded), JSON.parse(JSON.stringify(state)));
  state.questions[0].text = 'x'.repeat(MAX_SNAPSHOT_BYTES);
  assert.throws(() => snapshotChunks(state), /capacity/);
});

test('socket commands consult current membership even if the refresh notification was lost', async () => {
  const f = fixture();
  await f.room.init('ev', 'Test', 'corporate', organizer.email);
  const ws = f.socket(organizer);
  f.members.delete(organizer.email);
  await f.room.onMessage(ws as never, JSON.stringify({ type: 'cmd', id: 'stale', cmd: { type: 'ASK', text: 'Stale member', anonymous: false } }));
  assert.equal(ws.closed, true);
  assert.equal((await f.room.snapshot(organizer)).state.seq, 0);
});

test('expired socket sessions cannot receive snapshots or apply commands', async () => {
  const f = fixture();
  await f.room.init('ev', 'Test', 'corporate', organizer.email);
  const ws = f.socket(organizer);
  const meta = ws.state;
  meta.expiresAt = Date.now() - 1;
  ws.setState(meta);
  await f.room.onMessage(ws as never, JSON.stringify({ type: 'cmd', id: 'expired', cmd: { type: 'REACT', reaction: 'love' } }));
  assert.equal(ws.closed, true);
  assert.equal((await f.room.snapshot(organizer)).state.seq, 0);
});

test('new submissions stop at capacity while production controls retain headroom', async () => {
  const f = fixture();
  await f.room.init('ev', 'Test', 'corporate', organizer.email);
  (f.room as any).state.questions[0].text = 'x'.repeat(7 * 1024 * 1024);
  const rejected = await f.room.command(organizer, { type: 'ASK', text: 'More content', anonymous: false });
  assert.equal(rejected.status, 409);
  assert.equal((await f.room.command(organizer, { type: 'TAKE' })).ok, true);
  assert.equal((await f.room.snapshot(organizer)).state.seq, 1);
});

test('deleting an event disconnects its sockets and leaves no room state behind', async () => {
  const f = fixture();
  await f.room.init('ev', 'Test', 'corporate', organizer.email);
  const ws = f.socket(organizer);
  await f.room.destroy();
  assert.equal(ws.closed, true);
  await assert.rejects(f.room.snapshot(organizer), /not initialized/);
});
