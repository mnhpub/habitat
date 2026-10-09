import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, authorize, CommandError } from '../src/shared/reducer';
import { seedEvent } from '../src/shared/seed';
import { viewFor } from '../src/shared/view';
import type { Actor, Command } from '../src/shared/types';
import { parseCommand } from '../src/shared/command';

const now = Date.UTC(2026, 9, 8, 18);
const fresh = () => seedEvent('ev1', 'Test Summit', 'corporate', 'org@example.com', now);
const actor = (roles: Actor['roles'], email = `${roles[0]}@example.com`, warp = true): Actor => ({ email, name: email.split('@')[0], roles, warp });
const run = (s: ReturnType<typeof fresh>, a: Actor, cmd: Command) => { authorize(a, cmd, true); return apply(s, cmd, a, now); };

test('take swaps preview and program and marks talent live', () => {
  const s = fresh();
  const dir = actor(['producer']);
  run(s, dir, { type: 'SET_PREVIEW', sourceId: 'tal-b' });
  run(s, dir, { type: 'TAKE' });
  assert.equal(s.production.programId, 'tal-b');
  assert.equal(s.production.previewId, 'tal-a');
  assert.equal(s.talent.find((t) => t.id === 't-mori')!.state, 'live');
  assert.equal(s.talent.find((t) => t.id === 't-ruiz')!.state, 'off');
});

test('attendees cannot run production; production needs WARP', () => {
  const s = fresh();
  assert.throws(() => run(s, actor(['attendee']), { type: 'TAKE' }), CommandError);
  assert.throws(() => run(s, actor(['producer'], 'd@example.com', false), { type: 'TAKE' }), /WARP/);
  // Non-production commands work without WARP.
  run(s, actor(['attendee'], 'g@example.com', false), { type: 'REACT', reaction: 'applause' });
});

test('organizer can do everything', () => {
  const s = fresh();
  run(s, actor(['organizer']), { type: 'FIRE_NEXT_CUE' });
  assert.equal(s.cues.find((c) => c.status === 'live')!.id, 'c-panel');
  assert.equal(s.production.programId, 'tal-b');
});

test('votes are one per person and hidden in attendee views', () => {
  const s = fresh();
  const a = actor(['attendee'], 'a@example.com');
  const b = actor(['attendee'], 'b@example.com');
  run(s, a, { type: 'VOTE', pollId: 'p-barrier', option: 0 });
  run(s, a, { type: 'VOTE', pollId: 'p-barrier', option: 2 });
  run(s, b, { type: 'VOTE', pollId: 'p-barrier', option: 2 });
  const v = viewFor(s, a).polls.find((p) => p.id === 'p-barrier')!;
  assert.deepEqual(v.counts, [0, 0, 2, 0]);
  assert.equal(v.myVote, 2);
  assert.equal((v as unknown as { votes?: unknown }).votes, undefined);
});

test('anonymous questions hide the author from other attendees, not moderators', () => {
  const s = fresh();
  const asker = actor(['attendee'], 'ask@example.com');
  run(s, asker, { type: 'ASK', text: 'What about latency?', anonymous: true });
  const q = s.questions[s.questions.length - 1];
  const other = viewFor(s, actor(['attendee'], 'x@example.com')).questions.find((x) => x.id === q.id)!;
  assert.equal(other.authorName, 'Anonymous');
  assert.equal(other.byMe, false);
  assert.equal(viewFor(s, asker).questions.find((x) => x.id === q.id)!.byMe, true);
});

test('chat with links is held for review', () => {
  const s = fresh();
  run(s, actor(['attendee'], 'spam@example.com'), { type: 'CHAT', channel: 'everyone', text: 'see www.example.com' });
  const held = s.chat[s.chat.length - 1];
  assert.equal(held.held, true);
  assert.equal(viewFor(s, actor(['attendee'], 'other@example.com')).chat.some((m) => m.id === held.id), false);
  assert.equal(viewFor(s, actor(['moderator'])).chat.some((m) => m.id === held.id), true);
});

test('orders and valet follow their custody chains', () => {
  const s = fresh();
  const vendor = actor(['vendor']);
  for (const st of ['ready', 'delivered', 'settled']) { run(s, vendor, { type: 'ADVANCE_ORDER', orderId: 'A-118' }); assert.equal(s.orders[0].status, st); }
  assert.throws(() => run(s, vendor, { type: 'ADVANCE_ORDER', orderId: 'A-118' }), /settled/);
  assert.throws(() => run(s, actor(['attendee'], 'stranger@example.com'), { type: 'VALET_REQUEST', ticketId: 'v1' }), /Not your ticket/);
});

test('gates must be signed in order', () => {
  const s = fresh();
  const org = actor(['organizer']);
  assert.throws(() => run(s, org, { type: 'SIGN_GATE', gateId: 'G7' }), /earlier gate/);
  run(s, org, { type: 'SIGN_GATE', gateId: 'G6' });
  assert.equal(s.gates.find((g) => g.id === 'G6')!.signedBy, org.email);
});

test('tables respect capacity and seat each person once', () => {
  const s = fresh();
  const a = actor(['attendee'], 'net@example.com');
  run(s, a, { type: 'JOIN_TABLE', tableId: 'tb4' });
  run(s, a, { type: 'JOIN_TABLE', tableId: 'tb1' });
  assert.equal(s.tables.filter((t) => t.seats.includes(a.email)).length, 1);
  assert.throws(() => run(s, a, { type: 'JOIN_TABLE', tableId: 'tb3' }), /full/);
});

test('table chat is visible only to participants at the same table', () => {
  const s = fresh();
  const sender = actor(['attendee'], 'sender@example.com');
  const neighbor = actor(['attendee'], 'neighbor@example.com');
  const outsider = actor(['attendee'], 'outsider@example.com');
  run(s, sender, { type: 'JOIN_TABLE', tableId: 'tb4' });
  run(s, neighbor, { type: 'JOIN_TABLE', tableId: 'tb4' });
  run(s, outsider, { type: 'JOIN_TABLE', tableId: 'tb1' });
  run(s, sender, { type: 'CHAT', channel: 'table', text: 'Private table plans' });
  const message = s.chat[s.chat.length - 1];
  assert.equal(viewFor(s, sender).chat.some((m) => m.id === message.id), true);
  assert.equal(viewFor(s, neighbor).chat.some((m) => m.id === message.id), true);
  assert.equal(viewFor(s, outsider).chat.some((m) => m.id === message.id), false);
  assert.equal(viewFor(s, actor(['attendee'], 'unseated@example.com')).chat.some((m) => m.id === message.id), false);
});

test('leaving a table removes access to its chat', () => {
  const s = fresh();
  const sender = actor(['attendee'], 'sender@example.com');
  const neighbor = actor(['attendee'], 'neighbor@example.com');
  run(s, sender, { type: 'JOIN_TABLE', tableId: 'tb4' });
  run(s, neighbor, { type: 'JOIN_TABLE', tableId: 'tb4' });
  run(s, sender, { type: 'CHAT', channel: 'table', text: 'Private table plans' });
  const message = s.chat[s.chat.length - 1];
  run(s, neighbor, { type: 'LEAVE_TABLE' });
  assert.equal(viewFor(s, neighbor).chat.some((m) => m.id === message.id), false);
});

test('unseated attendees cannot post table chat', () => {
  const s = fresh();
  const before = structuredClone(s);
  assert.throws(() => run(s, actor(['attendee']), { type: 'CHAT', channel: 'table', text: 'No table' }), CommandError);
  assert.deepEqual(s, before);
});

test('room chat is restricted to in-person attendees', () => {
  const s = fresh();
  const sender = actor(['attendee'], 'onsite@example.com');
  const neighbor = actor(['attendee'], 'onsite-neighbor@example.com');
  const remote = actor(['attendee'], 'remote@example.com');
  for (const a of [sender, neighbor]) {
    run(s, a, { type: 'REGISTER', mode: 'in_person' });
    run(s, actor(['foh']), { type: 'CHECK_IN', guestId: s.guests.find((g) => g.email === a.email)!.id });
  }
  run(s, remote, { type: 'REGISTER', mode: 'online' });
  run(s, sender, { type: 'CHAT', channel: 'room', text: 'Meet at the room entrance' });
  const message = s.chat[s.chat.length - 1];
  assert.equal(viewFor(s, neighbor).chat.some((m) => m.id === message.id), true);
  assert.equal(viewFor(s, remote).chat.some((m) => m.id === message.id), false);
});

test('online attendees cannot post room chat', () => {
  const s = fresh();
  const remote = actor(['attendee'], 'remote@example.com');
  run(s, remote, { type: 'REGISTER', mode: 'online' });
  const before = structuredClone(s);
  assert.throws(() => run(s, remote, { type: 'CHAT', channel: 'room', text: 'Remote room message' }), CommandError);
  assert.deepEqual(s, before);
});

test('watch-party registration requires a party identifier', () => {
  const s = fresh();
  const before = structuredClone(s);
  assert.throws(() => run(s, actor(['attendee']), { type: 'REGISTER', mode: 'watch_party' }), CommandError);
  assert.deepEqual(s, before);
});

test('party chat is visible only within the registered watch party', () => {
  const s = fresh();
  const sender = actor(['attendee'], 'party-sender@example.com');
  const neighbor = actor(['attendee'], 'party-neighbor@example.com');
  const outsider = actor(['attendee'], 'other-party@example.com');
  run(s, sender, { type: 'REGISTER', mode: 'watch_party', partyId: 'austin' } as Command);
  run(s, neighbor, { type: 'REGISTER', mode: 'watch_party', partyId: 'austin' } as Command);
  run(s, outsider, { type: 'REGISTER', mode: 'watch_party', partyId: 'lisbon' } as Command);
  run(s, sender, { type: 'CHAT', channel: 'party', text: 'Austin watch party plans' });
  const message = s.chat[s.chat.length - 1];
  assert.equal(viewFor(s, neighbor).chat.some((m) => m.id === message.id), true);
  assert.equal(viewFor(s, outsider).chat.some((m) => m.id === message.id), false);
  assert.equal(viewFor(s, actor(['attendee'], 'no-party@example.com')).chat.some((m) => m.id === message.id), false);
});

test('attendees without a watch-party registration cannot post party chat', () => {
  const s = fresh();
  const a = actor(['attendee']);
  run(s, a, { type: 'REGISTER', mode: 'online' });
  const before = structuredClone(s);
  assert.throws(() => run(s, a, { type: 'CHAT', channel: 'party', text: 'No watch party' }), CommandError);
  assert.deepEqual(s, before);
});

test('switching from online to in-person requires a new verified check-in and assigns a seat', () => {
  const s = fresh();
  const a = actor(['attendee'], 'changing@example.com');
  run(s, a, { type: 'REGISTER', mode: 'online' });
  const guest = s.guests.find((g) => g.email === a.email)!;
  guest.verified = true;
  run(s, a, { type: 'REGISTER', mode: 'in_person' });
  assert.equal(guest.checkedIn, false);
  assert.equal(guest.checkedInAt, undefined);
  assert.equal(Boolean(guest.verified), false);
  assert.ok(guest.seat);
  run(s, actor(['foh']), { type: 'CHECK_IN', guestId: guest.id, verified: true });
  assert.equal(guest.checkedIn, true);
  assert.equal(guest.verified, true);
});

test('switching from in-person to online checks in the guest and clears the seat', () => {
  const s = fresh();
  const a = actor(['attendee'], 'changing@example.com');
  run(s, a, { type: 'REGISTER', mode: 'in_person' });
  const guest = s.guests.find((g) => g.email === a.email)!;
  assert.ok(guest.seat);
  run(s, a, { type: 'REGISTER', mode: 'online' });
  assert.equal(guest.checkedIn, true);
  assert.equal(guest.checkedInAt, now);
  assert.equal(guest.seat, undefined);
});

test('new order IDs remain unique alongside seeded orders', () => {
  const s = fresh();
  for (let i = 0; i < 20; i++) {
    run(s, actor(['attendee'], `buyer-${i}@example.com`), { type: 'ORDER', items: `Meal ${i}`, totalCents: 1200, vendor: 'Catering' });
  }
  assert.equal(new Set(s.orders.map((o) => o.id)).size, s.orders.length);
});

test('advancing a new order cannot advance the seeded order instead', () => {
  const s = fresh();
  const seededOrder = s.orders.find((o) => o.id === 'A-118')!;
  for (let i = 0; i < 20; i++) {
    run(s, actor(['attendee'], `buyer-${i}@example.com`), { type: 'ORDER', items: `Meal ${i}`, totalCents: 1200, vendor: 'Catering' });
  }
  const target = s.orders.find((o) => o.items === 'Meal 16')!;
  run(s, actor(['vendor']), { type: 'ADVANCE_ORDER', orderId: target.id });
  assert.equal(target.status, 'accepted');
  assert.equal(seededOrder.status, 'preparing');
});

for (const type of ['UNKNOWN_COMMAND', 'constructor', '__proto__']) {
  test(`unknown command ${type} is rejected as a CommandError for all roles`, () => {
    for (const roles of [['attendee'], ['organizer']] as Actor['roles'][]) {
      assert.throws(() => authorize(actor(roles), { type } as unknown as Command, true), CommandError);
    }
  });
}

test('an unknown hand status is rejected without modifying state', () => {
  const s = fresh();
  const before = structuredClone(s);
  assert.throws(() => run(s, actor(['moderator']), { type: 'SET_HAND_STATUS', handId: 'h1', status: 'unexpected' } as unknown as Command), CommandError);
  assert.deepEqual(s, before);
});

test('command envelopes reject malformed booleans, arrays, enums and numeric values', () => {
  for (const value of [
    null, [], { type: 'SET_ON_AIR', on: 'false' },
    { type: 'POLL_CREATE', question: 'Which?', options: 'not an array' },
    { type: 'POLL_CREATE', question: 'Which?', options: ['A', 'B'], kind: 'bad' },
    { type: 'SET_GAIN', busId: 'pgm', gainDb: Infinity },
    { type: 'ORDER', items: 'Latte', totalCents: 100.5, vendor: 'Cafe' },
    { type: 'SET_WORKSTREAM', workstreamId: 'w-plan', status: 'bad' },
  ]) assert.throws(() => parseCommand(value), CommandError);
  assert.deepEqual(parseCommand({ type: 'TAKE', excess: 'ignored' }), { type: 'TAKE' });
});
