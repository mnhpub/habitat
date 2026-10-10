import type { Actor, Survey, SurveySummary, SurveyView } from './types';
import { sha256Hex } from './hash';

const CREW_VIEW = ['organizer', 'producer', 'moderator'] as const;

/**
 * One viewer's view of a survey. Attendees see totals and text answers with no authors;
 * crew see individual responses, with the author removed when the survey is anonymous.
 */
export function surveyView(sv: Survey, a: Actor, eventId: string): SurveyView {
  const crew = a.roles.some((r) => (CREW_VIEW as readonly string[]).includes(r));
  const summary: SurveySummary[] = sv.questions.map((q) => {
    if (q.kind === 'rating') {
      const counts = [0, 0, 0, 0, 0];
      let total = 0;
      let sum = 0;
      for (const r of sv.responses) {
        const v = r.answers[q.id];
        if (typeof v === 'number' && v >= 1 && v <= 5) { counts[v - 1]++; total++; sum += v; }
      }
      return { questionId: q.id, average: total ? Math.round((sum / total) * 10) / 10 : undefined, counts };
    }
    if (q.kind === 'choice') {
      const optionCounts = q.options.map(() => 0);
      for (const r of sv.responses) {
        const v = r.answers[q.id];
        if (typeof v === 'number' && v >= 0 && v < optionCounts.length) optionCounts[v]++;
      }
      return { questionId: q.id, optionCounts };
    }
    const texts = sv.responses.map((r) => r.answers[q.id]).filter((v): v is string => typeof v === 'string');
    return { questionId: q.id, texts };
  });

  const responses = crew
    ? sv.responses.map((r) => (sv.anonymous ? { ...r, by: undefined, byName: undefined } : r))
    : [];

  return {
    id: sv.id,
    title: sv.title,
    status: sv.status,
    anonymous: sv.anonymous,
    questions: sv.questions,
    responseCount: sv.responses.length,
    answered: sv.responded.includes(respondentKey(eventId, a.email)),
    summary,
    responses,
  };
}

/**
 * What the survey stores instead of an email: a SHA-256 of the event and the address. It is enough to stop a
 * second answer, and it cannot be read back as an address. The event id keeps it from matching across events.
 */
export function respondentKey(eventId: string, email: string): string {
  return sha256Hex(`survey:${eventId}:${email}`);
}
