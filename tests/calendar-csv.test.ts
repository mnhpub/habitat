import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCsv, parseCsv } from '../src/shared/csv';
import { icsCalendar } from '../src/shared/ics';

test('CSV handles quoted commas, doubled quotes, CRLF and blank lines', () => {
  const rows = parseCsv('name,email\r\n"Smith, Ann","a""b@x.com"\n\nBob,\n');
  assert.deepEqual(rows, [['name', 'email'], ['Smith, Ann', 'a"b@x.com'], ['Bob', '']]);
});

test('CSV export quotes what needs quoting and round-trips', () => {
  const out = formatCsv([['name', 'note'], ['Ann, Jr', 'said "hi"\nthen left']]);
  assert.deepEqual(parseCsv(out), [['name', 'note'], ['Ann, Jr', 'said "hi"\nthen left']]);
});

test('calendar text is escaped and times are written in UTC', () => {
  const ics = icsCalendar('Team; A', [{
    uid: 'e1@habitat', title: 'Kickoff, Q1', start: Date.UTC(2026, 2, 3, 23), durationMin: 90, location: 'Hall\nB', url: 'https://x/e',
  }], Date.UTC(2026, 0, 1));
  assert.ok(ics.includes('X-WR-CALNAME:Team\\; A'));
  assert.match(ics, /SUMMARY:Kickoff\\, Q1/);
  assert.match(ics, /LOCATION:Hall\\nB/);
  assert.match(ics, /DTSTART:20260303T230000Z/);
  assert.match(ics, /DTEND:20260304T003000Z/);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
});

test('long calendar lines are folded at 75 octets', () => {
  const ics = icsCalendar('Cal', [{ uid: 'e@h', title: 'x'.repeat(200), start: 0, durationMin: 60, location: '', url: '' }], 0);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});
