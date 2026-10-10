// Domain model shared by the Worker, the EventRoom Durable Object and the React client.
// The Durable Object owns the authoritative EventState; every change is a Command that
// is authorized, applied by the reducer, appended to the journal and broadcast.

export type Role =
  | 'organizer'
  | 'producer'
  | 'audio'
  | 'stage_manager'
  | 'moderator'
  | 'talent'
  | 'foh'
  | 'vendor'
  | 'attendee';

export const ALL_ROLES: Role[] = [
  'organizer', 'producer', 'audio', 'stage_manager', 'moderator', 'talent', 'foh', 'vendor', 'attendee',
];

/** Roles that work in the production zone and must be on a WARP-enrolled device. */
export const PRODUCTION_ROLES: Role[] = ['producer', 'audio', 'stage_manager'];
/** Roles that appear on the always-open bridge. */
export const BRIDGE_ROLES: Role[] = ['organizer', 'producer', 'audio', 'stage_manager', 'moderator', 'talent', 'foh', 'vendor'];

export interface Actor {
  email: string;
  name: string;
  roles: Role[];
  /** True when Cloudflare Access reports the request came through WARP / Gateway. */
  warp: boolean;
  device?: string;
}

export type Lifecycle =
  | 'Proposed' | 'Feasible' | 'Authorized' | 'Committed' | 'Ready'
  | 'Active' | 'Completed' | 'Reconciled' | 'Archived';
export const LIFECYCLE: Lifecycle[] = [
  'Proposed', 'Feasible', 'Authorized', 'Committed', 'Ready', 'Active', 'Completed', 'Reconciled', 'Archived',
];

export type TalentState = 'invited' | 'arrived' | 'preflight' | 'ready' | 'standby' | 'live' | 'off';

export interface Source {
  id: string;
  label: string;
  meta: string;
  kind: 'camera' | 'talent' | 'media' | 'room' | 'graphics';
  talentId?: string;
}

export interface Cue {
  id: string;
  title: string;
  detail: string;
  /** Planned start, ms after the event epoch. */
  at: number;
  durationMs: number;
  /** Fires automatically at `at` while auto-run is on. */
  auto: boolean;
  status: 'pending' | 'live' | 'done' | 'skipped';
  sceneSourceId?: string;
}

export interface Talent {
  id: string;
  name: string;
  email?: string;
  where: string;
  state: TalentState;
  preflight?: { camera: boolean; mic: boolean; network: string; checkedAt: number };
  greenRoom: string;
}

export interface AudioBus { id: string; name: string; gainDb: number; muted: boolean }

export interface Subscriber {
  id: string;
  name: string;
  takes: string;
  adds: string;
  delivery: string;
  viewers: number;
  on: boolean;
}

export interface Contributor {
  id: string;
  name: string;
  device: string;
  meta: string;
  status: 'local' | 'offered' | 'standby' | 'on_bus';
}

export interface Device {
  id: string;
  name: string;
  protocol: string;
  scope: string;
  trust: string;
  rttMs: number;
  cert: 'Proposed' | 'Implemented' | 'Tested' | 'Certified';
  healthy: boolean;
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  status: 'draft' | 'open' | 'closed';
  /** email -> option index. Never sent to non-moderators; see view.ts. */
  votes: Record<string, number>;
  onProgram: boolean;
  kind: 'choice' | 'rating' | 'wordcloud';
  words?: Record<string, number>;
}

export interface Question {
  id: string;
  text: string;
  author: string;
  authorName: string;
  anonymous: boolean;
  where: string;
  upvotes: string[];
  status: 'new' | 'approved' | 'on_stage' | 'answered' | 'dismissed';
  ts: number;
}

export interface ChatMessage {
  id: string;
  channel: 'everyone' | 'room' | 'table' | 'party';
  /** Server-assigned table, party or room identity. Legacy unscoped private messages stay hidden. */
  scopeId?: string;
  author: string;
  authorName: string;
  where: string;
  text: string;
  ts: number;
  held: boolean;
  pinned: boolean;
}

export interface Hand {
  id: string;
  who: string;
  name: string;
  where: string;
  status: 'raised' | 'invited' | 'on_stage' | 'lowered';
  preflightOk: boolean;
}

export type AttendeeType =
  | 'in_person' | 'virtual' | 'vip' | 'sponsor' | 'press' | 'speaker' | 'moderator'
  | 'watch_party' | 'on_demand' | 'interpreter' | 'remote_family' | 'staff' | 'vendor' | 'organizer';

export interface Guest {
  id: string;
  name: string;
  email?: string;
  type: AttendeeType;
  mode: 'in_person' | 'online' | 'watch_party' | 'on_demand';
  seat?: string;
  partyId?: string;
  checkedIn: boolean;
  checkedInAt?: number;
  verified?: boolean;
  grantedRole?: string;
  /** Answers to the event's sign-up questions, keyed by question id. */
  answers?: Record<string, string>;
  /** Signed up after capacity was reached; not counted against capacity until approved. */
  waitlisted?: boolean;
}

export interface SignupQuestion { id: string; label: string; required: boolean }

/** The public sign-up form for an event. Attendees see it; only organizers change it. */
export interface SignupForm {
  open: boolean;
  /** Maximum registered (not waitlisted) guests, or null for no limit. */
  capacity: number | null;
  questions: SignupQuestion[];
}

export interface SurveyQuestion {
  id: string;
  prompt: string;
  kind: 'rating' | 'choice' | 'text';
  /** Choice labels. Rating questions always use 1–5. */
  options: string[];
}

export interface SurveyResponse {
  id: string;
  /** Omitted for anonymous surveys. Never sent to attendees. */
  by?: string;
  byName?: string;
  /** Rating: 1–5. Choice: option index. Text: the answer. */
  answers: Record<string, number | string>;
  ts: number;
}

export interface Survey {
  id: string;
  title: string;
  status: 'draft' | 'open' | 'closed';
  anonymous: boolean;
  questions: SurveyQuestion[];
  responses: SurveyResponse[];
  /** Emails that have answered, so each person answers once. Never projected to viewers. */
  responded: string[];
  createdBy: string;
  createdAt: number;
}

/** A session that is being recorded right now. Keyed by session in EventState.sessionRecordings. */
export interface SessionRecording { recordingId: string; by: string; startedAt: number }

export interface Order {
  id: string;
  guest: string;
  guestName: string;
  vendor: string;
  items: string;
  totalCents: number;
  status: 'created' | 'accepted' | 'preparing' | 'ready' | 'delivered' | 'settled';
  seat?: string;
  ts: number;
}

export interface ValetTicket {
  id: string;
  claim: string;
  guest: string;
  guestName: string;
  vehicle: string;
  status: 'received' | 'stored' | 'requested' | 'released';
}

export interface Gate { id: string; question: string; evidence: string; signedBy?: string; signedAt?: number }
export interface Workstream { id: string; name: string; owner: string; detail: string; status: 'on_track' | 'live' | 'watch' | 'blocked' }
export interface Vendor { id: string; name: string; meta: string; status: string }
export interface Incident { id: string; title: string; detail: string; owner: string; open: boolean; ts: number }

export interface NetTable { id: string; name: string; capacity: number; seats: string[]; note: string }

/** One person's published media in the video room. */
export interface CallParticipant { email: string; name: string; sessionId: string; tracks: string[]; joinedAt: number }

export interface BreakoutMessage { id: string; author: string; authorName: string; text: string; ts: number }

/** An ad hoc small-team breakout. Its chat is the transcript; notes are generated from it. */
export interface Breakout {
  id: string;
  name: string;
  topic: string;
  capacity: number;
  status: 'open' | 'ended';
  createdBy: string;
  createdAt: number;
  endedAt?: number;
  members: { email: string; name: string; joinedAt: number }[];
  /** Visible only to members and hosts (see canReadBreakoutRoom). */
  messages: BreakoutMessage[];
  notes?: { text: string; generatedAt: number; by: string };
}

export interface BridgeEntry { ts: number; who: string; text: string }

export interface JournalEntry {
  seq: number;
  ts: number;
  /** Milliseconds since the event epoch: the event clock τ. */
  tau: number;
  actor: string;
  type: string;
  summary: string;
}

export interface EventState {
  id: string;
  name: string;
  kind: 'corporate' | 'social';
  venue: string;
  createdBy: string;
  lifecycle: Lifecycle;
  /** Event epoch (ms since Unix epoch). τ = now − epoch. */
  epoch: number;
  seq: number;
  team: { size: 2 | 4 | 6 | 8 };

  production: {
    onAir: boolean;
    hold: boolean;
    recording: boolean;
    programId: string;
    previewId: string;
    autoDirector: boolean;
    layout: 'speaker' | 'two' | 'panel' | 'slides' | 'wide' | 'slate';
    autoRun: boolean;
    cueIndex: number;
  };
  sources: Source[];
  cues: Cue[];
  buses: AudioBus[];
  talent: Talent[];
  subscribers: Subscriber[];
  contributors: Contributor[];
  devices: Device[];

  polls: Poll[];
  questions: Question[];
  chat: ChatMessage[];
  reactions: Record<string, number>;
  hands: Hand[];
  resources: { id: string; title: string; note: string }[];

  guests: Guest[];
  signup: SignupForm;
  surveys: Survey[];
  /** Sessions being recorded now, keyed by session ("call"). Recording files live in R2 and D1. */
  sessionRecordings: Record<string, SessionRecording>;
  orders: Order[];
  valet: ValetTicket[];

  gates: Gate[];
  workstreams: Workstream[];
  vendors: Vendor[];
  incidents: Incident[];
  budget: { authorizedCents: number; committedCents: number; settledCents: number; stepUpLimitCents: number };

  tables: NetTable[];
  breakouts: Breakout[];
  /** Who is in the video room, and where their media is published on the Realtime SFU. */
  call: CallParticipant[];
  bridgeLog: BridgeEntry[];
  /** email -> mic live on the bridge */
  bridgeMics: Record<string, boolean>;

  /** Most recent journal entries (the full journal lives in the DO's SQLite table). */
  recent: JournalEntry[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  // production
  | { type: 'SET_PREVIEW'; sourceId: string }
  | { type: 'TAKE' }
  | { type: 'CUT_TO'; sourceId: string }
  | { type: 'SET_AUTO_DIRECTOR'; on: boolean }
  | { type: 'SET_LAYOUT'; layout: EventState['production']['layout'] }
  | { type: 'SET_ON_AIR'; on: boolean }
  | { type: 'SET_HOLD'; on: boolean }
  | { type: 'SET_RECORDING'; on: boolean }
  | { type: 'FIRE_NEXT_CUE' }
  | { type: 'SKIP_CUE'; cueId: string }
  | { type: 'SET_AUTO_RUN'; on: boolean }
  | { type: 'SET_GAIN'; busId: string; gainDb: number }
  | { type: 'TOGGLE_MUTE'; busId: string }
  | { type: 'SET_SUBSCRIBER'; subscriberId: string; on: boolean }
  | { type: 'SET_CONTRIBUTOR'; contributorId: string; status: Contributor['status'] }
  // talent
  | { type: 'SET_TALENT_STATE'; talentId: string; state: TalentState }
  | { type: 'STANDBY_CUE' }
  | { type: 'PREFLIGHT_REPORT'; talentId: string; camera: boolean; mic: boolean; network: string }
  // engagement
  | { type: 'REACT'; reaction: string }
  | { type: 'POLL_CREATE'; question: string; options: string[]; kind?: Poll['kind'] }
  | { type: 'POLL_OPEN'; pollId: string }
  | { type: 'POLL_CLOSE'; pollId: string }
  | { type: 'POLL_TO_PROGRAM'; pollId: string; on: boolean }
  | { type: 'VOTE'; pollId: string; option: number }
  | { type: 'WORD'; pollId: string; word: string }
  | { type: 'ASK'; text: string; anonymous: boolean }
  | { type: 'UPVOTE'; questionId: string }
  | { type: 'SET_QUESTION_STATUS'; questionId: string; status: Question['status'] }
  | { type: 'CHAT'; channel: ChatMessage['channel']; text: string }
  | { type: 'CHAT_MODERATE'; messageId: string; action: 'allow' | 'remove' | 'pin' | 'unpin' }
  | { type: 'RAISE_HAND' }
  | { type: 'LOWER_HAND'; handId?: string }
  | { type: 'SET_HAND_STATUS'; handId: string; status: Hand['status'] }
  // attendees & services
  | { type: 'REGISTER'; mode: Guest['mode']; name?: string; partyId?: string }
  | { type: 'CHECK_IN'; guestId: string; verified?: boolean }
  | { type: 'DENY_ENTRY'; reason: string }
  | { type: 'ORDER'; items: string; totalCents: number; vendor: string }
  | { type: 'ADVANCE_ORDER'; orderId: string }
  | { type: 'VALET_REQUEST'; ticketId: string }
  | { type: 'VALET_ADVANCE'; ticketId: string }
  // organizer
  | { type: 'SIGN_GATE'; gateId: string }
  | { type: 'ADVANCE_LIFECYCLE' }
  | { type: 'SET_LIFECYCLE'; lifecycle: Lifecycle }
  | { type: 'ADD_INCIDENT'; title: string; detail: string; owner: string }
  | { type: 'RESOLVE_INCIDENT'; incidentId: string }
  | { type: 'SET_WORKSTREAM'; workstreamId: string; status: Workstream['status'] }
  | { type: 'SET_TEAM_SIZE'; size: 2 | 4 | 6 | 8 }
  | { type: 'SET_BUDGET'; authorizedCents: number; committedCents: number; settledCents: number; stepUpLimitCents: number }
  | { type: 'RENAME_EVENT'; name: string; venue: string }
  // networking & bridge
  | { type: 'JOIN_TABLE'; tableId: string }
  | { type: 'LEAVE_TABLE' }
  | { type: 'BRIDGE_MIC'; on: boolean }
  | { type: 'BRIDGE_LOG'; text: string }
  // small-team breakouts (crew only)
  | { type: 'CREATE_BREAKOUT'; name: string; topic?: string; capacity: number }
  | { type: 'JOIN_BREAKOUT'; breakoutId: string }
  | { type: 'LEAVE_BREAKOUT' }
  | { type: 'END_BREAKOUT'; breakoutId: string }
  | { type: 'BREAKOUT_CHAT'; text: string }
  | { type: 'SET_BREAKOUT_NOTES'; breakoutId: string; text: string }
  // video room (Cloudflare Realtime)
  | { type: 'CALL_JOIN'; sessionId: string; tracks: string[] }
  | { type: 'CALL_LEAVE' }
  // sign-up, guest roster
  | { type: 'SET_SIGNUP_FORM'; open: boolean; capacity: number | null; questions: SignupQuestion[] }
  | { type: 'SIGNUP'; mode: Guest['mode']; name?: string; answers: Record<string, string> }
  | { type: 'SET_GUEST_WAITLIST'; guestId: string; waitlisted: boolean }
  | { type: 'IMPORT_GUESTS'; rows: { name: string; email?: string; mode: 'in_person' | 'online' | 'on_demand' }[] }
  // surveys
  | { type: 'SURVEY_CREATE'; title: string; anonymous: boolean; questions: Omit<SurveyQuestion, 'id'>[] }
  | { type: 'SURVEY_SET_STATUS'; surveyId: string; status: Survey['status'] }
  | { type: 'SURVEY_DELETE'; surveyId: string }
  | { type: 'SURVEY_RESPOND'; surveyId: string; answers: Record<string, number | string> }
  // session recording (team video)
  | { type: 'SET_SESSION_RECORDING'; key: string; recordingId: string | null };

export type CommandType = Command['type'];

export interface CommandResult {
  ok: boolean;
  error?: string;
  status?: number;
  seq?: number;
}

/** What a client receives: the state projected for that viewer, plus who they are. */
export interface ClientSnapshot {
  state: EventView;
  me: Actor;
  serverTime: number;
  presence: PresenceEntry[];
}

export interface PresenceEntry { email: string; name: string; roles: Role[]; device: string; since: number }

/** Polls in a view carry counts instead of who voted for what. */
export interface PollView extends Omit<Poll, 'votes'> {
  counts: number[];
  total: number;
  myVote: number | null;
}

export interface QuestionView extends Omit<Question, 'upvotes' | 'author'> {
  votes: number;
  mine: boolean;
  byMe: boolean;
}

/** A survey as one viewer may see it. Attendees get summaries; only crew get individual responses. */
export interface SurveyView {
  id: string;
  title: string;
  status: Survey['status'];
  anonymous: boolean;
  questions: SurveyQuestion[];
  responseCount: number;
  /** Whether this viewer has already answered. */
  answered: boolean;
  summary: SurveySummary[];
  /** Crew only. Authors are removed from anonymous surveys. */
  responses: SurveyResponse[];
}

export interface SurveySummary {
  questionId: string;
  /** Rating: average over answers, and counts for 1–5. */
  average?: number;
  counts?: number[];
  /** Choice: count per option. */
  optionCounts?: number[];
  /** Text: answers with no author attached. */
  texts?: string[];
}

export interface EventView extends Omit<EventState, 'polls' | 'questions' | 'surveys'> {
  polls: PollView[];
  questions: QuestionView[];
  surveys: SurveyView[];
}
