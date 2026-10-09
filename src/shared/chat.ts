import type { Actor, ChatMessage, EventState } from './types';

const moderator = (a: Actor) => a.roles.some(r => ['organizer', 'moderator', 'producer'].includes(r));

/** Scope comes from server-owned registration/seating, never from a chat command. */
export function chatScope(s: EventState, a: Actor, channel: ChatMessage['channel']): string | null {
  const guest = s.guests.find(g => g.email === a.email);
  if (channel === 'everyone') return s.id;
  if (channel === 'table') return s.tables.find(t => t.seats.includes(a.email))?.id ?? null;
  if (channel === 'party') return guest?.mode === 'watch_party' ? guest.partyId ?? null : null;
  if (channel === 'room') return moderator(a) || (guest?.mode === 'in_person' && guest.checkedIn) ? s.id : null;
  return null;
}

export function canReadChat(s: EventState, a: Actor, m: ChatMessage): boolean {
  if (moderator(a)) return true;
  if (m.channel === 'everyone') return true;
  const scope = chatScope(s, a, m.channel);
  return scope !== null && m.scopeId === scope;
}
