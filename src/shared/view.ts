import type { Actor, EventState, EventView, PollView, QuestionView, Role } from './types';
import { canReadChat } from './chat';
import { canReadBreakoutRoom } from './breakout';
import { surveyView } from './survey';

const has = (a: Actor, ...roles: Role[]) => a.roles.includes('organizer') || roles.some((r) => a.roles.includes(r));

/**
 * Project the authoritative state for one viewer.
 * Attendees never see who voted for what, who wrote an anonymous question,
 * other guests' details, other people's orders, or the budget.
 */
export function viewFor(s: EventState, a: Actor): EventView {
  const crew = a.roles.some((r) => r !== 'attendee');
  const moderator = has(a, 'moderator', 'producer');
  const ops = has(a, 'foh', 'vendor');

  const polls: PollView[] = s.polls
    .filter((p) => moderator || p.status !== 'draft')
    .map((p) => {
      const counts = p.options.map(() => 0);
      let total = 0;
      for (const v of Object.values(p.votes)) {
        if (v >= 0 && v < counts.length) counts[v]++;
        total++;
      }
      const { votes, ...rest } = p;
      return { ...rest, counts, total, myVote: votes[a.email] ?? null };
    });

  const questions: QuestionView[] = s.questions
    .filter((q) => moderator || q.status !== 'dismissed' || q.author === a.email)
    .map((q) => {
      const { upvotes, author, ...rest } = q;
      return {
        ...rest,
        authorName: q.anonymous && !moderator ? 'Anonymous' : q.authorName,
        votes: upvotes.length,
        mine: upvotes.includes(a.email),
        byMe: author === a.email,
      };
    });

  // Drafts are for the people building the survey; everyone else sees it once it opens.
  const surveys = s.surveys.filter((sv) => moderator || sv.status !== 'draft').map((sv) => surveyView(sv, a, s.id));

  const chat = s.chat.filter((m) => canReadChat(s, a, m) && (!m.held || moderator || m.author === a.email));

  const guests = crew ? s.guests : s.guests.filter((g) => g.email === a.email);
  const myGuest = s.guests.find((g) => g.email === a.email);
  const orders = ops ? s.orders : s.orders.filter((o) => o.guest === myGuest?.id || o.guest === a.email);
  const valet = ops ? s.valet : s.valet.filter((v) => v.guest === myGuest?.id);
  // Breakouts are crew-only. Chat, transcript and notes go only to members and hosts.
  const breakouts = crew ? s.breakouts.map((b) => {
    const room = canReadBreakoutRoom(b, a);
    return { ...b, messages: room ? b.messages : [], notes: room ? b.notes : undefined };
  }) : [];
  const budget = has(a) ? s.budget : { authorizedCents: 0, committedCents: 0, settledCents: 0, stepUpLimitCents: 0 };

  return {
    ...s,
    polls,
    questions,
    surveys,
    chat,
    guests,
    orders,
    valet,
    budget,
    breakouts,
    bridgeLog: crew ? s.bridgeLog : [],
    devices: crew ? s.devices : [],
    recent: crew ? s.recent : [],
  };
}
