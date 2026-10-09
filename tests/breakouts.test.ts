import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, authorize, CommandError } from '../src/shared/reducer';
import { seedEvent } from '../src/shared/seed';
import { viewFor } from '../src/shared/view';
import { breakoutTranscript } from '../src/shared/breakout';
import type { Actor, Command } from '../src/shared/types';

const now = Date.UTC(2026, 9, 8, 18);
const fresh = () => seedEvent('ev1', 'Test Summit', 'corporate', 'org@example.com', now);
const actor = (roles: Actor['roles'], email: string): Actor => ({ email, name: email.split('@')[0], roles, warp: true });
const run = (s: ReturnType<typeof fresh>, a: Actor, cmd: Command) => { authorize(a, cmd, true); return apply(s, cmd, a, now); };

const producer = actor(['producer'], 'pat@example.com');
const audio = actor(['audio'], 'ari@example.com');
const foh = actor(['foh'], 'fran@example.com');
const guest = actor(['attendee'], 'guest@example.com');

test('crew can create a breakout, join it and chat in it', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Cue sheet review', topic: 'Tighten the run of show', capacity: 3 });
  const b = s.breakouts[0];
  assert.equal(b.name, 'Cue sheet review');
  assert.equal(b.status, 'open');
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  run(s, audio, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  run(s, audio, { type: 'BREAKOUT_CHAT', text: 'Drop the lower third at 14:10' });
  assert.deepEqual(b.members.map(m => m.email), ['pat@example.com', 'ari@example.com']);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].authorName, 'ari');
});

test('breakouts are crew-only: attendees cannot create, join or chat', () => {
  const s = fresh();
  assert.throws(() => run(s, guest, { type: 'CREATE_BREAKOUT', name: 'x', capacity: 2 }), /can't do CREATE_BREAKOUT/);
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Room', capacity: 2 });
  const id = s.breakouts[0].id;
  assert.throws(() => run(s, guest, { type: 'JOIN_BREAKOUT', breakoutId: id }), /can't do JOIN_BREAKOUT/);
  assert.throws(() => run(s, guest, { type: 'BREAKOUT_CHAT', text: 'hi' }), /can't do BREAKOUT_CHAT/);
});

test('a full breakout refuses new members, and capacity is 2 to 8', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Pair', capacity: 2 });
  const id = s.breakouts[0].id;
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: id });
  run(s, audio, { type: 'JOIN_BREAKOUT', breakoutId: id });
  assert.throws(() => run(s, foh, { type: 'JOIN_BREAKOUT', breakoutId: id }), /full/);
  assert.throws(() => authorize(producer, { type: 'CREATE_BREAKOUT', name: 'Big', capacity: 9 }, true), /Invalid capacity/);
});

test('joining one breakout leaves the other, and LEAVE_BREAKOUT needs a current room', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'A', capacity: 4 });
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'B', capacity: 4 });
  const [b, a] = s.breakouts;
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: a.id });
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  assert.equal(a.members.length, 0);
  assert.equal(b.members.length, 1);
  run(s, producer, { type: 'LEAVE_BREAKOUT' });
  assert.equal(b.members.length, 0);
  assert.throws(() => run(s, producer, { type: 'LEAVE_BREAKOUT' }), /not in a breakout/);
});

test('chat requires membership, and ending a breakout closes it for everyone', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Room', capacity: 4 });
  const b = s.breakouts[0];
  assert.throws(() => run(s, audio, { type: 'BREAKOUT_CHAT', text: 'hello?' }), /Join a breakout/);
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  run(s, producer, { type: 'BREAKOUT_CHAT', text: 'Agenda: three items' });
  run(s, foh, { type: 'END_BREAKOUT', breakoutId: b.id });
  assert.equal(b.status, 'ended');
  assert.equal(b.members.length, 0);
  assert.equal(b.messages.length, 1, 'the transcript survives the end of the breakout');
  assert.throws(() => run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id }), /has ended/);
  assert.throws(() => run(s, producer, { type: 'END_BREAKOUT', breakoutId: b.id }), /already ended/);
});

test('the transcript and chat are visible only to members and hosts', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Private', capacity: 4 });
  const b = s.breakouts[0];
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  run(s, producer, { type: 'BREAKOUT_CHAT', text: 'Budget numbers are in the sheet' });

  const member = viewFor(s, producer).breakouts[0];
  assert.equal(member.messages.length, 1);

  const outsider = viewFor(s, audio).breakouts[0];
  assert.equal(outsider.messages.length, 0, 'crew outside the room do not see its chat');
  assert.equal(outsider.name, 'Private', 'but they can see the breakout exists');

  const host = viewFor(s, actor(['organizer'], 'org@example.com')).breakouts[0];
  assert.equal(host.messages.length, 1, 'hosts can read every room');

  assert.deepEqual(viewFor(s, guest).breakouts, [], 'attendees see no breakouts at all');
});

test('notes can be saved by members and hosts, not by other crew', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Room', capacity: 4 });
  const b = s.breakouts[0];
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  assert.throws(() => run(s, foh, { type: 'SET_BREAKOUT_NOTES', breakoutId: b.id, text: 'notes' }), /members or hosts/);
  run(s, producer, { type: 'SET_BREAKOUT_NOTES', breakoutId: b.id, text: '## Summary\nAgreed on the run of show.' });
  assert.equal(b.notes?.by, 'pat@example.com');
  run(s, actor(['moderator'], 'mo@example.com'), { type: 'SET_BREAKOUT_NOTES', breakoutId: b.id, text: 'Host edit' });
  assert.equal(b.notes?.text, 'Host edit');
});

test('the transcript export is one line per message, in order', () => {
  const s = fresh();
  run(s, producer, { type: 'CREATE_BREAKOUT', name: 'Room', capacity: 4 });
  const b = s.breakouts[0];
  run(s, producer, { type: 'JOIN_BREAKOUT', breakoutId: b.id });
  run(s, producer, { type: 'BREAKOUT_CHAT', text: 'first' });
  run(s, producer, { type: 'BREAKOUT_CHAT', text: 'second' });
  assert.equal(breakoutTranscript(b), '[18:00] pat: first\n[18:00] pat: second');
});
