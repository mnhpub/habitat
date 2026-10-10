import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceStarts, parseRecurrence, RecurrenceError, type RecurrenceRule } from '../src/shared/recurrence';

const base: RecurrenceRule = {
  freq: 'weekly', interval: 1, byDay: [2], dayOfMonth: null, timeOfDay: '18:00', timezone: 'America/New_York',
  startsOn: '2026-03-01', endsOn: null, maxOccurrences: 52,
};
const window = (from: string, to: string) => [Date.parse(from), Date.parse(to)] as const;

test('a weekly session keeps its wall-clock time across the daylight-saving change', () => {
  const [from, to] = window('2026-03-01T00:00:00Z', '2026-03-20T00:00:00Z');
  const starts = occurrenceStarts(base, from, to);
  // 18:00 Eastern is 23:00Z before the change on 8 March, and 22:00Z after it.
  assert.deepEqual(starts, [
    Date.UTC(2026, 2, 3, 23, 0),
    Date.UTC(2026, 2, 10, 22, 0),
    Date.UTC(2026, 2, 17, 22, 0),
  ]);
});

test('an empty weekday list repeats on the weekday of the first date', () => {
  // 4 March 2026 is a Wednesday.
  const starts = occurrenceStarts({ ...base, byDay: [], startsOn: '2026-03-04' }, Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 12));
  assert.deepEqual(starts, [Date.UTC(2026, 2, 4, 23), Date.UTC(2026, 2, 11, 22)]);
});

test('a monthly session every two months on a fixed day', () => {
  const rule: RecurrenceRule = { ...base, freq: 'monthly', interval: 2, byDay: [], dayOfMonth: 15, timeOfDay: '09:00', timezone: 'UTC', startsOn: '2026-01-15' };
  const [from, to] = window('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
  assert.deepEqual(occurrenceStarts(rule, from, to), [Date.UTC(2026, 0, 15, 9), Date.UTC(2026, 2, 15, 9), Date.UTC(2026, 4, 15, 9)]);
});

test('the series stops at its last date (inclusive) and at its occurrence cap', () => {
  const [from, to] = window('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  assert.equal(occurrenceStarts({ ...base, endsOn: '2026-03-10' }, from, to).length, 2);
  assert.equal(occurrenceStarts({ ...base, maxOccurrences: 3 }, from, to).length, 3);
});

test('only occurrences inside the requested window are returned, in order', () => {
  const [from, to] = window('2026-03-09T00:00:00Z', '2026-03-11T00:00:00Z');
  assert.deepEqual(occurrenceStarts(base, from, to), [Date.UTC(2026, 2, 10, 22)]);
});

test('rules from untrusted input are checked before anything is stored', () => {
  const good = { freq: 'weekly', interval: 1, byDay: [2], timezone: 'Europe/London', timeOfDay: '18:30', startsOn: '2026-03-01' };
  assert.equal(parseRecurrence(good).timezone, 'Europe/London');
  const bad: [string, Record<string, unknown>][] = [
    ['unknown zone', { ...good, timezone: 'Mars/Olympus' }],
    ['bad time', { ...good, timeOfDay: '25:00' }],
    ['day 31 monthly', { ...good, freq: 'monthly', dayOfMonth: 31 }],
    ['end before start', { ...good, endsOn: '2026-02-01' }],
    ['weekday 9', { ...good, byDay: [9] }],
    ['too many occurrences', { ...good, maxOccurrences: 500 }],
    ['daily', { ...good, freq: 'daily' }],
  ];
  for (const [label, input] of bad) assert.throws(() => parseRecurrence(input), RecurrenceError, label);
});
