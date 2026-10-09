import type { Actor, Breakout, Role } from './types';

/** Crew work breakouts. Attendees never see or use them. */
export const CREW_ROLES: Role[] = ['producer', 'audio', 'stage_manager', 'moderator', 'talent', 'foh', 'vendor', 'organizer'];
/** Roles that can read any breakout's transcript and save its notes, without being in the room. */
export const HOST_ROLES: Role[] = ['organizer', 'producer', 'moderator'];

export const MAX_BREAKOUTS = 60;
export const MAX_BREAKOUT_MESSAGES = 300;
export const MAX_BREAKOUT_CAPACITY = 8;

export function isMember(b: Breakout, email: string): boolean {
  return b.members.some(m => m.email === email);
}

/** The breakout this person is currently in, if it is still open. */
export function currentBreakout(breakouts: Breakout[], email: string): Breakout | undefined {
  return breakouts.find(b => b.status === 'open' && isMember(b, email));
}

/** Members see the room's chat, transcript and notes; hosts see every room. */
export function canReadBreakoutRoom(b: Breakout, a: Actor): boolean {
  return isMember(b, a.email) || a.roles.some(r => HOST_ROLES.includes(r));
}

/** Plain-text transcript: the chat is the transcript. Times are shown in UTC. */
export function breakoutTranscript(b: Breakout): string {
  return b.messages
    .map(m => `[${new Date(m.ts).toISOString().slice(11, 16)}] ${m.authorName}: ${m.text}`)
    .join('\n');
}
