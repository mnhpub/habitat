import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, organizer } from './fixtures/room';
import type { Actor, Command, EventView } from '../src/shared/types';

const ann: Actor = { email: 'ann@example.com', name: 'Ann', roles: ['attendee'], warp: true };
const ben: Actor = { email: 'ben@example.com', name: 'Ben', roles: ['attendee'], warp: true };
const producer: Actor = { email: 'prod@example.com', name: 'Prod', roles: ['producer'], warp: true };

async function event() {
  const f = fixture();
  await f.room.init('ev1', 'Summit', 'corporate', organizer.email, 'Hall');
  const run = (actor: Actor, cmd: Command) => f.room.command(actor, cmd);
  const view = async (actor: Actor): Promise<EventView> => (await f.room.snapshot(actor)).state;
  return { f, run, view };
}

const openForm = (capacity: number | null = 1) => ({
  type: 'SET_SIGNUP_FORM' as const, open: true, capacity,
  questions: [{ id: 'company', label: 'Company', required: true }, { id: 'diet', label: 'Dietary needs', required: false }],
});

test('sign-up is refused until an organizer opens it, and only organizers change the form', async () => {
  const { run } = await event();
  const refused = await run(ann, { type: 'SIGNUP', mode: 'online', answers: { company: 'Acme' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal((await run(ann, openForm())).status, 403);
  assert.equal((await run(organizer, openForm())).ok, true);
});

test('required questions are enforced; a full event waitlists people, and approval respects capacity', async () => {
  const { run, view } = await event();
  // The seeded demo guests already hold seats, so capacity is counted from the current registrations.
  const registered = (await view(organizer)).guests.filter((g) => !g.waitlisted).length;
  await run(organizer, openForm(registered + 1));

  const missing = await run(ann, { type: 'SIGNUP', mode: 'online', answers: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /Company is required/);

  assert.equal((await run(ann, { type: 'SIGNUP', mode: 'online', answers: { company: 'Acme' } })).ok, true);
  assert.equal((await run(ben, { type: 'SIGNUP', mode: 'online', answers: { company: 'Bolt' } })).ok, true);

  const guests = (await view(organizer)).guests;
  assert.equal(guests.find((g) => g.email === ben.email)!.waitlisted, true);
  assert.equal(guests.find((g) => g.email === ann.email)!.answers!.company, 'Acme');

  const benId = guests.find((g) => g.email === ben.email)!.id;
  const full = await run(organizer, { type: 'SET_GUEST_WAITLIST', guestId: benId, waitlisted: false });
  assert.equal(full.status, 409);

  await run(organizer, openForm(registered + 2));
  assert.equal((await run(organizer, { type: 'SET_GUEST_WAITLIST', guestId: benId, waitlisted: false })).ok, true);
  assert.equal((await view(organizer)).guests.find((g) => g.email === ben.email)!.waitlisted, false);
});

test('attendees see only their own guest record and cannot approve the waitlist', async () => {
  const { run, view } = await event();
  await run(organizer, openForm(5));
  await run(ann, { type: 'SIGNUP', mode: 'online', answers: { company: 'Acme' } });
  await run(ben, { type: 'SIGNUP', mode: 'online', answers: { company: 'Bolt' } });
  assert.deepEqual((await view(ben)).guests.map((g) => g.email), [ben.email]);
  const id = (await view(organizer)).guests.find((g) => g.email === ann.email)!.id;
  assert.equal((await run(ben, { type: 'SET_GUEST_WAITLIST', guestId: id, waitlisted: false })).status, 403);
});

test('the roster import adds guests, skips duplicates by email, and seats in-person guests', async () => {
  const { run, view } = await event();
  const first = await run(producer, {
    type: 'IMPORT_GUESTS',
    rows: [{ name: 'Cy', email: 'Cy@Example.com', mode: 'in_person' }, { name: 'Dee', mode: 'online' }],
  });
  assert.equal(first.ok, true);
  const guests = (await view(organizer)).guests;
  const cy = guests.find((g) => g.name === 'Cy')!;
  assert.equal(cy.email, 'cy@example.com');
  assert.match(cy.seat!, /^R-\d+$/);
  assert.equal(guests.find((g) => g.name === 'Dee')!.checkedIn, true);

  await run(producer, { type: 'IMPORT_GUESTS', rows: [{ name: 'Cy again', email: 'cy@example.com', mode: 'online' }] });
  assert.equal((await view(organizer)).guests.filter((g) => g.email === 'cy@example.com').length, 1);
  assert.equal((await run(ann, { type: 'IMPORT_GUESTS', rows: [{ name: 'x', mode: 'online' }] })).status, 403);
});

test('a survey stays hidden while drafted, takes one answer per person, and anonymous answers have no authors', async () => {
  const { f, run, view } = await event();
  await run(organizer, {
    type: 'SURVEY_CREATE', title: 'Feedback', anonymous: true,
    questions: [
      { prompt: 'Overall', kind: 'rating', options: [] },
      { prompt: 'Format', kind: 'choice', options: ['Talks', 'Workshops'] },
      { prompt: 'Anything else?', kind: 'text', options: [] },
    ],
  });
  assert.equal((await view(ann)).surveys.length, 0, 'draft hidden from attendees');
  const sv = (await view(organizer)).surveys[0];
  const [rating, choice, text] = sv.questions.map((q) => q.id);

  assert.equal((await run(ann, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [rating]: 4 } })).ok, false, 'not open yet');
  await run(organizer, { type: 'SURVEY_SET_STATUS', surveyId: sv.id, status: 'open' });

  assert.equal((await run(ann, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [rating]: 0, [choice]: 0 } })).ok, false, 'rating must be 1 to 5');
  const answered = await run(ann, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [rating]: 4, [choice]: 1, [text]: 'More demos' } });
  assert.equal(answered.ok, true);
  assert.equal((await run(ann, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [rating]: 5, [choice]: 0 } })).status, 409);

  const attendee = (await view(ben)).surveys[0];
  assert.equal(attendee.answered, false);
  assert.deepEqual(attendee.summary.find((x) => x.questionId === rating)!.average, 4);
  assert.deepEqual(attendee.summary.find((x) => x.questionId === choice)!.optionCounts, [0, 1]);
  assert.deepEqual(attendee.summary.find((x) => x.questionId === text)!.texts, ['More demos']);
  assert.deepEqual(attendee.responses, [], 'attendees never see individual responses');

  const crew = (await view(organizer)).surveys[0];
  assert.equal(crew.responses.length, 1);
  assert.equal(crew.responses[0].by, undefined, 'anonymous responses are not attributed');

  // Nothing that names a respondent is stored: only hashes of who answered.
  const stored = JSON.stringify((f.room as any).state.surveys[0].responded);
  assert.doesNotMatch(stored, /ann@example\.com/);
  assert.equal((f.room as any).state.surveys[0].responded.length, 1);

  await run(organizer, { type: 'SURVEY_SET_STATUS', surveyId: sv.id, status: 'closed' });
  assert.equal((await run(ben, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [rating]: 3, [choice]: 0 } })).ok, false);
});

test('a named survey shows who answered to crew, and a choice needs a valid option', async () => {
  const { run, view } = await event();
  await run(organizer, { type: 'SURVEY_CREATE', title: 'Quick', anonymous: false, questions: [{ prompt: 'Pick', kind: 'choice', options: ['A', 'B'] }] });
  const sv = (await view(organizer)).surveys[0];
  await run(organizer, { type: 'SURVEY_SET_STATUS', surveyId: sv.id, status: 'open' });
  const q = sv.questions[0].id;
  assert.equal((await run(ann, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [q]: 5 } })).ok, false, 'option 5 does not exist');
  assert.equal((await run(ann, { type: 'SURVEY_RESPOND', surveyId: sv.id, answers: { [q]: 0 } })).ok, true);
  assert.equal((await view(organizer)).surveys[0].responses[0].by, ann.email);
  assert.equal((await view(ben)).surveys[0].responses.length, 0);
});

test('a session is recorded only by people in it, one recording at a time, and stopped by its starter or crew', async () => {
  const { run, view } = await event();
  const join = (actor: Actor) => run(actor, { type: 'CALL_JOIN', sessionId: `s-${actor.email}`, tracks: ['camera'] });
  assert.equal((await run(organizer, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: 'rec1' })).status, 403);

  await join(organizer);
  assert.equal((await run(organizer, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: 'rec1' })).ok, true);
  assert.equal((await view(ben)).sessionRecordings.call.recordingId, 'rec1', 'everyone sees that it is recording');

  assert.equal((await run(organizer, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: 'rec2' })).status, 409);
  await join(ben);
  assert.equal((await run(ben, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: null })).status, 403, 'not the starter');
  assert.equal((await run(producer, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: null })).ok, true, 'crew can stop it');
  assert.equal((await run(producer, { type: 'SET_SESSION_RECORDING', key: 'call', recordingId: null })).status, 409);
  assert.equal((await view(ben)).sessionRecordings.call, undefined);
});
