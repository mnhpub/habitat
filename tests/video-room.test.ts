import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, authorize, CommandError } from '../src/shared/reducer';
import { hydrateState } from '../src/worker/snapshot-storage';
import { seedEvent } from '../src/shared/seed';
import { viewFor } from '../src/shared/view';
import type { Actor, Command } from '../src/shared/types';

const now = Date.UTC(2026, 9, 9, 18);
const fresh = () => seedEvent('ev1', 'Test Summit', 'corporate', 'org@example.com', now);
const actor = (roles: Actor['roles'], email: string): Actor => ({ email, name: email.split('@')[0], roles, warp: true });
const run = (s: ReturnType<typeof fresh>, a: Actor, cmd: Command) => { authorize(a, cmd, true); return apply(s, cmd, a, now); };

const pat = actor(['producer'], 'pat@example.com');
const guest = actor(['attendee'], 'guest@example.com');

test('a member joins the video room with their session and tracks', () => {
  const s = fresh();
  run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['camera', 'mic'] });
  assert.equal(s.call.length, 1);
  assert.deepEqual(s.call[0], { email: 'pat@example.com', name: 'pat', sessionId: 'sess-1', tracks: ['camera', 'mic'], joinedAt: now });
});

test('joining again replaces the previous publication instead of duplicating it', () => {
  const s = fresh();
  run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['camera'] });
  run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-2', tracks: ['camera', 'mic'] });
  assert.equal(s.call.length, 1);
  assert.equal(s.call[0].sessionId, 'sess-2');
});

test('leaving removes the person, and leaving without joining is refused', () => {
  const s = fresh();
  run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['camera'] });
  run(s, pat, { type: 'CALL_LEAVE' });
  assert.equal(s.call.length, 0);
  assert.throws(() => run(s, pat, { type: 'CALL_LEAVE' }), /not in the video room/);
});

test('track names and counts are validated before anything is recorded', () => {
  const s = fresh();
  assert.throws(() => run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['Camera!'] }), /Invalid tracks/);
  assert.throws(() => run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: [] }), /Invalid tracks/);
  assert.throws(() => run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['a', 'b', 'c', 'd', 'e'] }), /Invalid tracks/);
  assert.equal(s.call.length, 0);
});

test('every member, including attendees, can see the roster', () => {
  const s = fresh();
  run(s, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['camera'] });
  assert.equal(viewFor(s, guest).call.length, 1);
  run(s, guest, { type: 'CALL_JOIN', sessionId: 'sess-g', tracks: ['camera'] });
  assert.equal(s.call.length, 2, 'attendees can join the video room');
});

test('an event saved before the video room existed loads with an empty roster', () => {
  const old = fresh() as Partial<ReturnType<typeof fresh>>;
  delete old.call;
  const loaded = hydrateState(old as ReturnType<typeof fresh>);
  assert.deepEqual(loaded.call, []);
  const joined = fresh();
  run(joined, pat, { type: 'CALL_JOIN', sessionId: 'sess-1', tracks: ['camera'] });
  assert.equal(hydrateState(joined).call.length, 1, 'an existing roster is kept');
});
