import type { Env } from './env';

/** Durable Object for one event. Each event is a separate room with its own clock and state. */
export function roomFor(env: Env, eventId: string) {
  return env.EVENTS.get(env.EVENTS.idFromName(eventId));
}

export interface NewEvent {
  id: string;
  orgId: string;
  name: string;
  kind: 'corporate' | 'social';
  venue: string;
  createdBy: string;
  joinOpen: boolean;
  startsAt: number | null;
  durationMin: number;
  seriesId?: string;
  /** Copy the team from this event (for later occurrences of a series). */
  copyTeamFrom?: string;
}

/**
 * Create an event: its D1 row and team first, then its Durable Object. Returns false when the event
 * already exists for that series occurrence, so a second scheduler run cannot duplicate it.
 */
export async function createEvent(env: Env, e: NewEvent): Promise<boolean> {
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO events (id, name, kind, venue, created_by, created_at, join_open, org_id, starts_at, duration_min, series_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(e.id, e.name, e.kind, e.venue, e.createdBy, now, e.joinOpen ? 1 : 0, e.orgId, e.startsAt, e.durationMin, e.seriesId ?? null).run();
  if (!inserted.meta?.changes) return false;
  const team = [
    env.DB.prepare('INSERT OR IGNORE INTO members (event_id, email, name, roles, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?2, ?5)')
      .bind(e.id, e.createdBy, e.createdBy.split('@')[0], JSON.stringify(['organizer']), now),
  ];
  if (e.copyTeamFrom) {
    team.push(env.DB.prepare(
      `INSERT OR IGNORE INTO members (event_id, email, name, roles, added_by, added_at)
       SELECT ?1, email, name, roles, ?2, ?3 FROM members WHERE event_id = ?4`,
    ).bind(e.id, e.createdBy, now, e.copyTeamFrom));
  }
  await env.DB.batch(team);
  await roomFor(env, e.id).init(e.id, e.name, e.kind, e.createdBy, e.venue, e.startsAt ?? undefined);
  return true;
}

/** Recording files in R2 are removed with the event that owns them. */
export async function purgeRecordings(env: Env, eventId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT p.recording_id, p.part FROM recording_parts p JOIN recordings r ON r.id = p.recording_id WHERE r.event_id = ?',
  ).bind(eventId).all<{ recording_id: string; part: number }>();
  if (env.RECORDINGS) {
    await Promise.all(results.map((p) => env.RECORDINGS!.delete(partKey(p.recording_id, p.part))));
  }
  await env.DB.prepare('DELETE FROM recordings WHERE event_id = ?').bind(eventId).run();
}

export const partKey = (recordingId: string, part: number) => `recordings/${recordingId}/${String(part).padStart(6, '0')}`;
