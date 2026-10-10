// Recurring sessions. A series describes its rule in wall-clock terms in one IANA time zone,
// so "every Tuesday at 18:00 New York" stays at 18:00 across daylight-saving changes.

export interface RecurrenceRule {
  freq: 'weekly' | 'monthly';
  /** Every N weeks or every N months. */
  interval: number;
  /** Weekly: weekdays 0 (Sunday) to 6 (Saturday). */
  byDay: number[];
  /** Monthly: day of the month, 1 to 28. */
  dayOfMonth: number | null;
  /** Wall clock "HH:MM" in `timezone`. */
  timeOfDay: string;
  timezone: string;
  /** First date, "YYYY-MM-DD" in `timezone`. */
  startsOn: string;
  /** Last date, inclusive, or null. */
  endsOn: string | null;
  maxOccurrences: number;
}

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Milliseconds that `zone` is ahead of UTC at instant `at`. */
export function zoneOffsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallAsUtc - Math.floor(at / 1000) * 1000;
}

/** The instant at which the wall clock in `zone` reads `day` (midnight UTC of a date) plus HH:MM. */
function zonedInstant(day: number, hour: number, minute: number, zone: string): number {
  const naive = day + (hour * 60 + minute) * 60_000;
  // Two passes: the first guess can land on the wrong side of a daylight-saving change.
  const guess = naive - zoneOffsetMs(naive, zone);
  return naive - zoneOffsetMs(guess, zone);
}

function parseDate(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Start instants of every occurrence in [from, to), in order. */
export function occurrenceStarts(rule: RecurrenceRule, from: number, to: number): number[] {
  const [hour, minute] = rule.timeOfDay.split(':').map(Number);
  const start = parseDate(rule.startsOn);
  const end = rule.endsOn ? parseDate(rule.endsOn) : Infinity;
  const step = Math.max(1, rule.interval);
  const days: number[] = [];

  if (rule.freq === 'weekly') {
    const weekStart = start - new Date(start).getUTCDay() * DAY_MS;
    const weekdays = rule.byDay.length ? [...new Set(rule.byDay)].sort((a, b) => a - b) : [new Date(start).getUTCDay()];
    for (let week = 0; week < 1000; week++) {
      const base = weekStart + week * step * 7 * DAY_MS;
      if (base > end) break;
      for (const weekday of weekdays) {
        const day = base + weekday * DAY_MS;
        if (day >= start && day <= end) days.push(day);
      }
      if (days.length >= rule.maxOccurrences) break;
    }
  } else {
    const first = new Date(start);
    const dayOfMonth = rule.dayOfMonth ?? first.getUTCDate();
    for (let month = 0; month < 1000 && days.length < rule.maxOccurrences; month++) {
      const day = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + month * step, dayOfMonth);
      if (day > end) break;
      if (day >= start) days.push(day);
    }
  }

  const starts: number[] = [];
  for (const day of days.slice(0, rule.maxOccurrences)) {
    const at = zonedInstant(day, hour, minute, rule.timezone);
    if (at >= from && at < to) starts.push(at);
  }
  return starts;
}

/** Check and normalise a rule from untrusted input. Throws with a message a person can act on. */
export function parseRecurrence(input: Record<string, unknown>): RecurrenceRule {
  const fail = (message: string): never => { throw new RecurrenceError(message); };
  if (input.freq !== 'weekly' && input.freq !== 'monthly') fail('Repeat weekly or monthly');
  const freq = input.freq as RecurrenceRule['freq'];
  const interval = Number(input.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) fail('Repeat every 1 to 12 weeks or months');
  const timezone = typeof input.timezone === 'string' ? input.timezone : '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { fail('Choose a valid time zone'); }
  const timeOfDay = typeof input.timeOfDay === 'string' ? input.timeOfDay : '';
  if (!TIME.test(timeOfDay)) fail('Start time must look like 18:30');
  const startsOn = typeof input.startsOn === 'string' ? input.startsOn : '';
  if (!DATE.test(startsOn) || Number.isNaN(parseDate(startsOn))) fail('Choose a valid first date');
  const endsOn = input.endsOn === undefined || input.endsOn === null || input.endsOn === '' ? null : String(input.endsOn);
  if (endsOn !== null && (!DATE.test(endsOn) || Number.isNaN(parseDate(endsOn)) || parseDate(endsOn) < parseDate(startsOn))) {
    fail('The last date must be on or after the first date');
  }
  let byDay: number[] = [];
  let dayOfMonth: number | null = null;
  if (freq === 'weekly') {
    if (input.byDay !== undefined && (!Array.isArray(input.byDay) || input.byDay.length > 7 ||
        input.byDay.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6))) fail('Choose weekdays');
    byDay = Array.isArray(input.byDay) ? [...new Set(input.byDay as number[])] : [];
  } else {
    dayOfMonth = input.dayOfMonth === undefined || input.dayOfMonth === null ? new Date(parseDate(startsOn)).getUTCDate() : Number(input.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) fail('Monthly sessions can fall on days 1 to 28');
  }
  const maxOccurrences = input.maxOccurrences === undefined ? 52 : Number(input.maxOccurrences);
  if (!Number.isInteger(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 104) fail('A series can have up to 104 sessions');
  return { freq, interval, byDay, dayOfMonth, timeOfDay, timezone, startsOn, endsOn, maxOccurrences };
}

export class RecurrenceError extends Error {}
