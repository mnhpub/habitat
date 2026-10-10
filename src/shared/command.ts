import { LIFECYCLE, type Command, type CommandType } from './types';
import { MAX_CALL_TRACKS, TRACK_NAME } from './call';

export class CommandError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Rule = (value: unknown) => boolean;
const str = (max: number): Rule => (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const bool: Rule = (v) => typeof v === 'boolean';
const num = (min: number, max: number, integer = false): Rule => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isSafeInteger(v));
const oneOf = (values: readonly unknown[]): Rule => (v) => values.includes(v);
const optional = (rule: Rule): Rule => (v) => v === undefined || rule(v);
const id = str(128);
const on = { on: bool };
const money = num(0, Number.MAX_SAFE_INTEGER, true);
const list = (min: number, max: number, rule: Rule): Rule => (v) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(rule);
const shape = (spec: Record<string, Rule>): Rule => (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(spec).every(([key, rule]) => rule((v as Record<string, unknown>)[key]));
const email: Rule = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const nullable = (rule: Rule): Rule => (v) => v === null || rule(v);
const modes = ['in_person', 'online', 'on_demand'] as const;
const answerValue: Rule = (v) => typeof v === 'string' ? v.length <= 1000 : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5;
const answers: Rule = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 20
  && Object.entries(v).every(([k, val]) => k.length <= 64 && answerValue(val));
const fields = {
  SET_PREVIEW: { sourceId: id }, TAKE: {}, CUT_TO: { sourceId: id },
  SET_AUTO_DIRECTOR: on, SET_LAYOUT: { layout: oneOf(['speaker', 'two', 'panel', 'slides', 'wide', 'slate']) },
  SET_ON_AIR: on, SET_HOLD: on, SET_RECORDING: on, FIRE_NEXT_CUE: {},
  SKIP_CUE: { cueId: id }, SET_AUTO_RUN: on,
  SET_GAIN: { busId: id, gainDb: num(-60, 10) }, TOGGLE_MUTE: { busId: id },
  SET_SUBSCRIBER: { subscriberId: id, ...on },
  SET_CONTRIBUTOR: { contributorId: id, status: oneOf(['local', 'offered', 'standby', 'on_bus']) },
  SET_TALENT_STATE: { talentId: id, state: oneOf(['invited', 'arrived', 'preflight', 'ready', 'standby', 'live', 'off']) },
  STANDBY_CUE: {}, PREFLIGHT_REPORT: { talentId: id, camera: bool, mic: bool, network: str(60) },
  REACT: { reaction: oneOf(['applause', 'love', 'laugh', 'wow', 'confused']) },
  POLL_CREATE: {
    question: str(200),
    options: (v: unknown) => Array.isArray(v) && v.length <= 6 && v.every(str(80)),
    kind: optional(oneOf(['choice', 'rating', 'wordcloud'])),
  },
  POLL_OPEN: { pollId: id }, POLL_CLOSE: { pollId: id }, POLL_TO_PROGRAM: { pollId: id, ...on },
  VOTE: { pollId: id, option: num(0, 5, true) }, WORD: { pollId: id, word: str(24) },
  ASK: { text: str(280), anonymous: bool }, UPVOTE: { questionId: id },
  SET_QUESTION_STATUS: { questionId: id, status: oneOf(['new', 'approved', 'on_stage', 'answered', 'dismissed']) },
  CHAT: { channel: oneOf(['everyone', 'room', 'table', 'party']), text: str(500) },
  CHAT_MODERATE: { messageId: id, action: oneOf(['allow', 'remove', 'pin', 'unpin']) },
  RAISE_HAND: {}, LOWER_HAND: { handId: optional(id) },
  SET_HAND_STATUS: { handId: id, status: oneOf(['raised', 'invited', 'on_stage', 'lowered']) },
  REGISTER: {
    mode: oneOf(['in_person', 'online', 'watch_party', 'on_demand']), name: optional(str(120)),
    partyId: optional((v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)),
  },
  CHECK_IN: { guestId: id, verified: optional(bool) }, DENY_ENTRY: { reason: str(120) },
  ORDER: { items: str(200), totalCents: num(1, 100_000, true), vendor: str(80) },
  ADVANCE_ORDER: { orderId: id }, VALET_REQUEST: { ticketId: id }, VALET_ADVANCE: { ticketId: id },
  SIGN_GATE: { gateId: id }, ADVANCE_LIFECYCLE: {}, SET_LIFECYCLE: { lifecycle: oneOf(LIFECYCLE) },
  ADD_INCIDENT: { title: str(120), detail: optional((v: unknown) => typeof v === 'string' && v.length <= 300), owner: optional((v: unknown) => typeof v === 'string' && v.length <= 60) },
  RESOLVE_INCIDENT: { incidentId: id },
  SET_WORKSTREAM: { workstreamId: id, status: oneOf(['on_track', 'live', 'watch', 'blocked']) },
  SET_TEAM_SIZE: { size: oneOf([2, 4, 6, 8]) },
  SET_BUDGET: { authorizedCents: money, committedCents: money, settledCents: money, stepUpLimitCents: money },
  RENAME_EVENT: { name: str(120), venue: (v: unknown) => typeof v === 'string' && v.length <= 120 },
  JOIN_TABLE: { tableId: id }, LEAVE_TABLE: {}, BRIDGE_MIC: on, BRIDGE_LOG: { text: str(200) },
  CREATE_BREAKOUT: { name: str(80), topic: optional(str(200)), capacity: num(2, 8, true) },
  JOIN_BREAKOUT: { breakoutId: id }, LEAVE_BREAKOUT: {}, END_BREAKOUT: { breakoutId: id },
  BREAKOUT_CHAT: { text: str(500) }, SET_BREAKOUT_NOTES: { breakoutId: id, text: str(8000) },
  CALL_JOIN: {
    sessionId: id,
    tracks: (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= MAX_CALL_TRACKS && v.every((t) => typeof t === 'string' && TRACK_NAME.test(t)),
  },
  CALL_LEAVE: {},
  SET_SIGNUP_FORM: {
    open: bool,
    capacity: nullable(num(1, 10_000, true)),
    questions: list(0, 20, shape({ id: id, label: str(200), required: bool })),
  },
  SIGNUP: { mode: oneOf(modes), name: optional(str(120)), answers: (v: unknown) => answers(v) && Object.values(v as object).every((x) => typeof x === 'string') },
  SET_GUEST_WAITLIST: { guestId: id, waitlisted: bool },
  IMPORT_GUESTS: { rows: list(1, 500, shape({ name: str(120), email: optional(email), mode: oneOf(modes) })) },
  SURVEY_CREATE: {
    title: str(120),
    anonymous: bool,
    questions: list(1, 20, shape({ prompt: str(300), kind: oneOf(['rating', 'choice', 'text']), options: list(0, 6, str(80)) })),
  },
  SURVEY_SET_STATUS: { surveyId: id, status: oneOf(['draft', 'open', 'closed']) },
  SURVEY_DELETE: { surveyId: id },
  SURVEY_RESPOND: { surveyId: id, answers },
  SET_SESSION_RECORDING: { key: oneOf(['call']), recordingId: nullable(id) },
} satisfies Record<CommandType, Record<string, Rule>>;

/** Validate untrusted JSON and copy only the fields defined by the command contract. */
export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommandError('Malformed command');
  const input = value as Record<string, unknown>;
  if (typeof input.type !== 'string' || !Object.hasOwn(fields, input.type)) throw new CommandError('Unknown command');
  const schema: Record<string, Rule> = fields[input.type as CommandType];
  const output: Record<string, unknown> = { type: input.type };
  for (const [key, rule] of Object.entries(schema)) {
    if (!rule(input[key])) throw new CommandError(`Invalid ${key}`);
    if (input[key] !== undefined) output[key] = input[key];
  }
  return output as Command;
}
