import type { Actor, Role } from '../shared/types';
import type { Env } from './env';

/** Re-read event membership at every command boundary, including existing sockets. */
export async function resolveActor(env: Env, identity: Omit<Actor, 'roles'>, eventId: string): Promise<Actor | null> {
  const row = await env.DB.prepare(
    'SELECT e.join_open, m.roles FROM events e LEFT JOIN members m ON m.event_id = e.id AND m.email = ? WHERE e.id = ?',
  ).bind(identity.email, eventId).first<{ join_open: number; roles: string | null }>();
  if (!row) return null;
  let roles: Role[] = row.roles ? JSON.parse(row.roles) as Role[] : [];
  if (!roles.length) {
    if (!row.join_open) return null;
    roles = ['attendee'];
  }
  return { ...identity, roles };
}
