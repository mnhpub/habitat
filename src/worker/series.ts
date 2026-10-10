import type { Env } from './env';
import { occurrenceStarts, parseRecurrence, type RecurrenceRule } from '../shared/recurrence';
import { createEvent } from './events-db';
import { announce } from './campaigns';

/** How far ahead sessions are created. Sessions are created ahead so people can book and calendars can show them. */
export const HORIZON_MS = 8 * 7 * 86_400_000;

export interface SeriesRow {
  id: string;
  org_id: string;
  name: string;
  kind: 'corporate' | 'social';
  venue: string;
  duration_min: number;
  timezone: string;
  time_of_day: string;
  freq: 'weekly' | 'monthly';
  interval_n: number;
  by_day: string;
  day_of_month: number | null;
  starts_on: string;
  ends_on: string | null;
  max_occurrences: number;
  join_open: number;
  anchor_event_id: string | null;
  active: number;
  created_by: string;
  created_at: number;
}

export function ruleOf(row: SeriesRow): RecurrenceRule {
  return {
    freq: row.freq,
    interval: row.interval_n,
    byDay: JSON.parse(row.by_day) as number[],
    dayOfMonth: row.day_of_month,
    timeOfDay: row.time_of_day,
    timezone: row.timezone,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    maxOccurrences: row.max_occurrences,
  };
}

/**
 * Create sessions for every occurrence in the next eight weeks that doesn't have one yet.
 * Returns the number of new sessions. Safe to run repeatedly.
 */
export async function materializeSeries(env: Env, series: SeriesRow, now = Date.now()): Promise<number> {
  if (!series.active) return 0;
  const starts = occurrenceStarts(ruleOf(series), now, now + HORIZON_MS);
  let created = 0;
  for (const startsAt of starts) {
    const id = crypto.randomUUID();
    const ok = await createEvent(env, {
      id, orgId: series.org_id, name: series.name, kind: series.kind, venue: series.venue,
      createdBy: series.created_by, joinOpen: !!series.join_open, startsAt, durationMin: series.duration_min,
      seriesId: series.id, copyTeamFrom: series.anchor_event_id ?? undefined,
    });
    if (!ok) continue;
    created++;
    // The first session becomes the team template for the rest of the series.
    await env.DB.prepare('UPDATE series SET anchor_event_id = ?1 WHERE id = ?2 AND anchor_event_id IS NULL')
      .bind(id, series.id).run();
    series.anchor_event_id ??= id;
    await announce(env, series, id, startsAt);
  }
  return created;
}

/** Validate a new series from untrusted input. */
export function parseSeriesInput(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) throw new Error('Give the series a name (up to 120 characters)');
  const venue = typeof body.venue === 'string' ? body.venue.slice(0, 120) : '';
  const kind = body.kind === 'social' ? 'social' : 'corporate';
  const duration = body.durationMin === undefined ? 60 : Number(body.durationMin);
  if (!Number.isInteger(duration) || duration < 15 || duration > 1440) throw new Error('Sessions last 15 minutes to 24 hours');
  const rule = parseRecurrence(body);
  return {
    name, venue, kind, durationMin: duration, rule,
    joinOpen: body.joinOpen === false ? 0 : 1,
  };
}
