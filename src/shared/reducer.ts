import {
  LIFECYCLE,
  type Actor,
  type AttendeeType,
  type Breakout,
  type Command,
  type CommandType,
  type EventState,
  type Guest,
  type Role,
  type SignupQuestion,
  type Survey,
  type TalentState,
} from './types';
import { CommandError, parseCommand } from './command';
import { chatScope } from './chat';
import { respondentKey } from './survey';
import {
  CREW_ROLES,
  MAX_BREAKOUT_MESSAGES,
  MAX_BREAKOUTS,
  canReadBreakoutRoom,
  currentBreakout,
  isMember,
} from './breakout';
export { CommandError } from './command';

const ANY = 'any' as const;
type Allowed = Role[] | typeof ANY;

const PROD: Role[] = ['producer'];
const AUDIO: Role[] = ['producer', 'audio'];
const SM: Role[] = ['producer', 'stage_manager'];
const MOD: Role[] = ['producer', 'moderator'];
const FOH: Role[] = ['foh'];

/**
 * Who may issue each command. Organizers may issue every command.
 * 'any' means any signed-in participant of the event, including attendees.
 */
export const PERMISSIONS: Record<CommandType, Allowed> = {
  SET_PREVIEW: PROD,
  TAKE: PROD,
  CUT_TO: PROD,
  SET_AUTO_DIRECTOR: PROD,
  SET_LAYOUT: PROD,
  SET_ON_AIR: PROD,
  SET_HOLD: [...PROD, 'stage_manager', 'moderator'],
  SET_RECORDING: PROD,
  FIRE_NEXT_CUE: SM,
  SKIP_CUE: SM,
  SET_AUTO_RUN: PROD,
  SET_GAIN: AUDIO,
  TOGGLE_MUTE: AUDIO,
  SET_SUBSCRIBER: PROD,
  SET_CONTRIBUTOR: PROD,

  SET_TALENT_STATE: SM,
  STANDBY_CUE: SM,
  PREFLIGHT_REPORT: ['talent', ...SM],

  REACT: ANY,
  POLL_CREATE: MOD,
  POLL_OPEN: MOD,
  POLL_CLOSE: MOD,
  POLL_TO_PROGRAM: MOD,
  VOTE: ANY,
  WORD: ANY,
  ASK: ANY,
  UPVOTE: ANY,
  SET_QUESTION_STATUS: MOD,
  CHAT: ANY,
  CHAT_MODERATE: MOD,
  RAISE_HAND: ANY,
  LOWER_HAND: ANY,
  SET_HAND_STATUS: MOD,

  REGISTER: ANY,
  CHECK_IN: FOH,
  DENY_ENTRY: FOH,
  ORDER: ANY,
  ADVANCE_ORDER: ['vendor', 'foh'],
  VALET_REQUEST: ANY,
  VALET_ADVANCE: ['vendor', 'foh'],

  SIGN_GATE: [],
  ADVANCE_LIFECYCLE: [],
  SET_LIFECYCLE: [],
  ADD_INCIDENT: ['producer', 'stage_manager', 'foh', 'moderator'],
  RESOLVE_INCIDENT: ['producer', 'foh'],
  SET_WORKSTREAM: [],
  SET_TEAM_SIZE: [],
  SET_BUDGET: [],
  RENAME_EVENT: [],

  JOIN_TABLE: ANY,
  LEAVE_TABLE: ANY,
  BRIDGE_MIC: ['producer', 'audio', 'stage_manager', 'moderator', 'talent', 'foh', 'vendor'],
  BRIDGE_LOG: ['producer', 'audio', 'stage_manager', 'moderator', 'talent', 'foh', 'vendor'],

  CREATE_BREAKOUT: CREW_ROLES,
  JOIN_BREAKOUT: CREW_ROLES,
  LEAVE_BREAKOUT: CREW_ROLES,
  END_BREAKOUT: CREW_ROLES,
  BREAKOUT_CHAT: CREW_ROLES,
  SET_BREAKOUT_NOTES: CREW_ROLES,

  CALL_JOIN: ANY,
  CALL_LEAVE: ANY,

  SET_SIGNUP_FORM: [],
  SIGNUP: ANY,
  SET_GUEST_WAITLIST: ['producer', 'foh'],
  IMPORT_GUESTS: ['producer', 'foh'],

  SURVEY_CREATE: MOD,
  SURVEY_SET_STATUS: MOD,
  SURVEY_DELETE: MOD,
  SURVEY_RESPOND: ANY,

  // Who may start a recording is checked in apply(): you must be in the session.
  SET_SESSION_RECORDING: ANY,
};

/** Commands that act on the live production. Production roles must be on WARP to send them. */
export const WARP_COMMANDS = new Set<CommandType>([
  'SET_PREVIEW', 'TAKE', 'CUT_TO', 'SET_AUTO_DIRECTOR', 'SET_LAYOUT', 'SET_ON_AIR', 'SET_RECORDING',
  'FIRE_NEXT_CUE', 'SKIP_CUE', 'SET_AUTO_RUN', 'SET_GAIN', 'TOGGLE_MUTE', 'SET_SUBSCRIBER', 'SET_CONTRIBUTOR',
]);

export function can(actor: Actor, type: CommandType): boolean {
  if (!Object.hasOwn(PERMISSIONS, type)) return false;
  if (actor.roles.includes('organizer')) return true;
  const allowed = PERMISSIONS[type];
  if (allowed === ANY) return actor.roles.length > 0;
  return allowed.some((r) => actor.roles.includes(r));
}

export function authorize(actor: Actor, cmd: Command, requireWarp: boolean): void {
  cmd = parseCommand(cmd);
  if (!can(actor, cmd.type)) throw new CommandError(`Your role can't do ${cmd.type}`, 403);
  if (requireWarp && WARP_COMMANDS.has(cmd.type) && !actor.warp) {
    throw new CommandError('This control needs a WARP-enrolled device', 403);
  }
}

let idCounter = 0;
export function newId(prefix: string, now: number): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${now.toString(36)}${idCounter.toString(36)}`;
}

const ORDER_FLOW = ['created', 'accepted', 'preparing', 'ready', 'delivered', 'settled'] as const;
const VALET_FLOW = ['received', 'stored', 'requested', 'released'] as const;

function find<T extends { id: string }>(list: T[], id: string, what: string): T {
  const x = list.find((i) => i.id === id);
  if (!x) throw new CommandError(`Unknown ${what}`, 404);
  return x;
}

function text(s: unknown, max: number, what: string): string {
  if (typeof s !== 'string') throw new CommandError(`${what} is required`);
  const t = s.trim();
  if (!t) throw new CommandError(`${what} is required`);
  if (t.length > max) throw new CommandError(`${what} is too long`);
  return t;
}

const HELD_PATTERN = /(https?:\/\/|www\.|bit\.ly|\.com\b)/i;

/**
 * Apply an authorized command to the state (in place) and return a one-line summary
 * for the journal. Throws CommandError for invalid commands, before changing anything.
 */
export function apply(s: EventState, cmd: Command, actor: Actor, now: number): string {
  cmd = parseCommand(cmd);
  const p = s.production;
  switch (cmd.type) {
    // ---------------------------------------------------------------- production
    case 'SET_PREVIEW': {
      const src = find(s.sources, cmd.sourceId, 'source');
      p.previewId = src.id;
      return `Preview → ${src.label}`;
    }
    case 'TAKE': {
      const prev = p.programId;
      p.programId = p.previewId;
      p.previewId = prev;
      p.autoDirector = false;
      syncTalentOnAir(s);
      return `TAKE ${label(s, p.programId)}`;
    }
    case 'CUT_TO': {
      const src = find(s.sources, cmd.sourceId, 'source');
      if (src.id !== p.programId) p.previewId = p.programId;
      p.programId = src.id;
      syncTalentOnAir(s);
      return `CUT to ${src.label}`;
    }
    case 'SET_AUTO_DIRECTOR':
      p.autoDirector = !!cmd.on;
      return `Auto-director ${cmd.on ? 'on' : 'off'}`;
    case 'SET_LAYOUT': {
      const layouts = ['speaker', 'two', 'panel', 'slides', 'wide', 'slate'];
      if (!layouts.includes(cmd.layout)) throw new CommandError('Unknown layout');
      p.layout = cmd.layout;
      p.autoDirector = false;
      return `Layout → ${cmd.layout}`;
    }
    case 'SET_ON_AIR':
      p.onAir = !!cmd.on;
      return cmd.on ? 'Went on air' : 'Went off air';
    case 'SET_HOLD':
      p.hold = !!cmd.on;
      return cmd.on ? 'EMERGENCY HOLD · holding slate' : 'Hold released';
    case 'SET_RECORDING':
      p.recording = !!cmd.on;
      return cmd.on ? 'Recording started' : 'Recording stopped';
    case 'FIRE_NEXT_CUE':
      return fireNextCue(s, now);
    case 'SKIP_CUE': {
      const cue = find(s.cues, cmd.cueId, 'cue');
      if (cue.status !== 'pending') throw new CommandError('Only pending cues can be skipped');
      cue.status = 'skipped';
      return `Skipped cue: ${cue.title}`;
    }
    case 'SET_AUTO_RUN':
      p.autoRun = !!cmd.on;
      return `Auto-run cues ${cmd.on ? 'on' : 'off'}`;
    case 'SET_GAIN': {
      const bus = find(s.buses, cmd.busId, 'bus');
      const g = Number(cmd.gainDb);
      if (!Number.isFinite(g) || g < -60 || g > 10) throw new CommandError('Gain must be between −60 and +10 dB');
      bus.gainDb = Math.round(g * 10) / 10;
      return `SET_GAIN ${bus.name} ${bus.gainDb} dB`;
    }
    case 'TOGGLE_MUTE': {
      const bus = find(s.buses, cmd.busId, 'bus');
      bus.muted = !bus.muted;
      return `${bus.name} ${bus.muted ? 'muted' : 'unmuted'}`;
    }
    case 'SET_SUBSCRIBER': {
      const sub = find(s.subscribers, cmd.subscriberId, 'subscriber');
      sub.on = !!cmd.on;
      return `${sub.name} ${sub.on ? 'subscribed to' : 'left'} the stream bus`;
    }
    case 'SET_CONTRIBUTOR': {
      const c = find(s.contributors, cmd.contributorId, 'contributor');
      if (!['local', 'offered', 'standby', 'on_bus'].includes(cmd.status)) throw new CommandError('Unknown status');
      c.status = cmd.status;
      return `${c.name} → ${cmd.status.replace('_', ' ')}`;
    }

    // ---------------------------------------------------------------- talent
    case 'SET_TALENT_STATE': {
      const t = find(s.talent, cmd.talentId, 'talent');
      const states: TalentState[] = ['invited', 'arrived', 'preflight', 'ready', 'standby', 'live', 'off'];
      if (!states.includes(cmd.state)) throw new CommandError('Unknown talent state');
      t.state = cmd.state;
      if (cmd.state === 'live') {
        const src = s.sources.find((x) => x.talentId === t.id);
        if (src) { p.previewId = src.id; }
      }
      return `${t.name} → ${cmd.state.toUpperCase()}`;
    }
    case 'STANDBY_CUE': {
      const next = s.cues.find((c) => c.status === 'pending');
      if (!next) throw new CommandError('No pending cue');
      let n = 0;
      for (const t of s.talent) {
        if (next.detail.includes(t.name.split(' ').slice(-1)[0]) && t.state !== 'live') { t.state = 'standby'; n++; }
      }
      return `STANDBY all for "${next.title}" (${n} talent)`;
    }
    case 'PREFLIGHT_REPORT': {
      const t = find(s.talent, cmd.talentId, 'talent');
      if (actor.roles.includes('talent') && !t.email) t.email = actor.email; // first report links the talent to their sign-in
      if (t.email && t.email !== actor.email && !actor.roles.some((r) => ['producer', 'stage_manager', 'organizer'].includes(r))) {
        throw new CommandError('That speaker is linked to someone else', 403);
      }
      t.preflight = { camera: !!cmd.camera, mic: !!cmd.mic, network: String(cmd.network).slice(0, 60), checkedAt: now };
      if (cmd.camera && cmd.mic && ['invited', 'arrived', 'preflight'].includes(t.state)) t.state = 'ready';
      return `Preflight ${cmd.camera && cmd.mic ? 'passed' : 'failed'} · ${t.name}`;
    }

    // ---------------------------------------------------------------- engagement
    case 'REACT': {
      const allowed = ['applause', 'love', 'laugh', 'wow', 'confused'];
      if (!allowed.includes(cmd.reaction)) throw new CommandError('Unknown reaction');
      s.reactions[cmd.reaction] = (s.reactions[cmd.reaction] ?? 0) + 1;
      return `react:${cmd.reaction}`;
    }
    case 'POLL_CREATE': {
      const q = text(cmd.question, 200, 'Question');
      const kind = cmd.kind ?? 'choice';
      const opts = kind === 'wordcloud' ? [] : (cmd.options ?? []).map((o) => text(o, 80, 'Option'));
      if (kind === 'choice' && (opts.length < 2 || opts.length > 6)) throw new CommandError('Give 2 to 6 options');
      const id = newId('p', now);
      s.polls.unshift({ id, question: q, options: kind === 'rating' ? ['1', '2', '3', '4', '5'] : opts, status: 'draft', votes: {}, onProgram: false, kind, words: kind === 'wordcloud' ? {} : undefined });
      return `Poll created: ${q}`;
    }
    case 'POLL_OPEN': {
      const poll = find(s.polls, cmd.pollId, 'poll');
      poll.status = 'open';
      return `Poll opened: ${poll.question}`;
    }
    case 'POLL_CLOSE': {
      const poll = find(s.polls, cmd.pollId, 'poll');
      poll.status = 'closed';
      return `Poll closed: ${poll.question}`;
    }
    case 'POLL_TO_PROGRAM': {
      const poll = find(s.polls, cmd.pollId, 'poll');
      for (const other of s.polls) other.onProgram = false;
      poll.onProgram = !!cmd.on;
      return cmd.on ? `Poll results to program: ${poll.question}` : 'Poll graphic cleared';
    }
    case 'VOTE': {
      const poll = find(s.polls, cmd.pollId, 'poll');
      if (poll.status !== 'open') throw new CommandError('This poll is not open');
      const opt = Number(cmd.option);
      if (!Number.isInteger(opt) || opt < 0 || opt >= poll.options.length) throw new CommandError('Unknown option');
      poll.votes[actor.email] = opt;
      return `vote:${poll.id}`;
    }
    case 'WORD': {
      const poll = find(s.polls, cmd.pollId, 'poll');
      if (poll.status !== 'open' || poll.kind !== 'wordcloud') throw new CommandError('This word cloud is not open');
      const w = text(cmd.word, 24, 'Word').toLowerCase().split(/\s+/)[0];
      if (poll.votes[actor.email] !== undefined) throw new CommandError('You already added a word');
      poll.votes[actor.email] = 0;
      poll.words = poll.words ?? {};
      poll.words[w] = (poll.words[w] ?? 0) + 1;
      return `word:${poll.id}`;
    }
    case 'ASK': {
      const t = text(cmd.text, 280, 'Question');
      s.questions.push({
        id: newId('q', now), text: t, author: actor.email, authorName: cmd.anonymous ? 'Anonymous' : actor.name,
        anonymous: !!cmd.anonymous, where: whereOf(s, actor), upvotes: [], status: 'new', ts: now,
      });
      return `Question asked`;
    }
    case 'UPVOTE': {
      const q = find(s.questions, cmd.questionId, 'question');
      const i = q.upvotes.indexOf(actor.email);
      if (i >= 0) q.upvotes.splice(i, 1); else q.upvotes.push(actor.email);
      return `upvote:${q.id}`;
    }
    case 'SET_QUESTION_STATUS': {
      const q = find(s.questions, cmd.questionId, 'question');
      if (!['new', 'approved', 'on_stage', 'answered', 'dismissed'].includes(cmd.status)) throw new CommandError('Unknown status');
      if (cmd.status === 'on_stage') for (const o of s.questions) if (o.status === 'on_stage') o.status = 'answered';
      q.status = cmd.status;
      return `Question → ${cmd.status.replace('_', ' ')}: ${q.text.slice(0, 60)}`;
    }
    case 'CHAT': {
      const t = text(cmd.text, 500, 'Message');
      if (!['everyone', 'room', 'table', 'party'].includes(cmd.channel)) throw new CommandError('Unknown channel');
      const scopeId = chatScope(s, actor, cmd.channel);
      if (!scopeId) throw new CommandError('Join this room, table or watch party before chatting', 403);
      s.chat.push({ id: newId('m', now), channel: cmd.channel, scopeId, author: actor.email, authorName: actor.name, where: whereOf(s, actor), text: t, ts: now, held: HELD_PATTERN.test(t), pinned: false });
      if (s.chat.length > 500) s.chat.splice(0, s.chat.length - 500);
      return 'chat';
    }
    case 'CHAT_MODERATE': {
      const m = find(s.chat, cmd.messageId, 'message');
      if (cmd.action === 'allow') m.held = false;
      else if (cmd.action === 'remove') s.chat = s.chat.filter((x) => x.id !== m.id);
      else if (cmd.action === 'pin') { for (const x of s.chat) x.pinned = false; m.pinned = true; m.held = false; }
      else if (cmd.action === 'unpin') m.pinned = false;
      else throw new CommandError('Unknown action');
      return `Chat ${cmd.action}`;
    }
    case 'RAISE_HAND': {
      if (s.hands.some((h) => h.who === actor.email && h.status !== 'lowered')) throw new CommandError('Your hand is already up');
      s.hands.push({ id: newId('h', now), who: actor.email, name: actor.name, where: whereOf(s, actor), status: 'raised', preflightOk: false });
      return `${actor.name} raised a hand`;
    }
    case 'LOWER_HAND': {
      const mine = s.hands.filter((h) => (cmd.handId ? h.id === cmd.handId : h.who === actor.email) && h.status !== 'lowered');
      if (cmd.handId && mine[0] && mine[0].who !== actor.email && !actor.roles.some((r) => ['moderator', 'producer', 'organizer'].includes(r))) {
        throw new CommandError('Not your hand', 403);
      }
      for (const h of mine) h.status = 'lowered';
      return 'Hand lowered';
    }
    case 'SET_HAND_STATUS': {
      const h = find(s.hands, cmd.handId, 'hand');
      h.status = cmd.status;
      return `${h.name} → ${cmd.status.replace('_', ' ')}`;
    }

    // ---------------------------------------------------------------- attendees & services
    case 'REGISTER': {
      if (!['in_person', 'online', 'watch_party', 'on_demand'].includes(cmd.mode)) throw new CommandError('Unknown way to attend');
      let g = s.guests.find((x) => x.email === actor.email);
      const type = cmd.mode === 'in_person' ? 'in_person' : cmd.mode === 'online' ? 'virtual' : cmd.mode;
      if (cmd.mode === 'watch_party' && !cmd.partyId) throw new CommandError('Choose a watch party identifier');
      if (!g) {
        g = { id: newId('g', now), name: cmd.name?.trim() || actor.name, email: actor.email, type, mode: cmd.mode, checkedIn: cmd.mode !== 'in_person', checkedInAt: cmd.mode !== 'in_person' ? now : undefined };
        s.guests.push(g);
      } else {
        if (g.mode !== cmd.mode) {
          g.checkedIn = cmd.mode !== 'in_person';
          g.checkedInAt = g.checkedIn ? now : undefined;
          g.verified = undefined;
          g.seat = undefined;
        }
        g.mode = cmd.mode;
        g.type = type;
      }
      if (cmd.mode === 'in_person' && !g.seat) {
        const occupied = new Set(s.guests.map(x => x.seat).filter(Boolean));
        let seat = 1;
        while (occupied.has(`R-${seat}`)) seat++;
        g.seat = `R-${seat}`;
      }
      g.partyId = cmd.mode === 'watch_party' ? cmd.partyId : undefined;
      return `${g.name} registered · ${cmd.mode.replace('_', ' ')}`;
    }
    case 'CHECK_IN': {
      const g = find(s.guests, cmd.guestId, 'guest');
      if (g.checkedIn) throw new CommandError(`${g.name} is already checked in`);
      g.checkedIn = true;
      g.checkedInAt = now;
      g.verified = !!cmd.verified;
      const t = s.talent.find((x) => x.name === g.name);
      if (t && t.state === 'invited') t.state = 'arrived';
      return `Checked in ${g.name}${cmd.verified ? ' · identity verified' : ''}`;
    }
    case 'DENY_ENTRY':
      return `Entry denied · ${text(cmd.reason, 120, 'Reason')}`;
    case 'ORDER': {
      const items = text(cmd.items, 200, 'Items');
      const total = Math.round(Number(cmd.totalCents));
      if (!Number.isFinite(total) || total <= 0 || total > 100_000) throw new CommandError('Invalid total');
      const g = s.guests.find((x) => x.email === actor.email);
      const id = `A-${crypto.randomUUID()}`;
      s.orders.push({ id, guest: g?.id ?? actor.email, guestName: g?.name ?? actor.name, vendor: text(cmd.vendor, 80, 'Vendor'), items, totalCents: total, status: 'created', seat: g?.seat, ts: now });
      return `OrderCreated ${id}`;
    }
    case 'ADVANCE_ORDER': {
      const o = find(s.orders, cmd.orderId, 'order');
      const i = ORDER_FLOW.indexOf(o.status);
      if (i >= ORDER_FLOW.length - 1) throw new CommandError('Order already settled');
      o.status = ORDER_FLOW[i + 1];
      return `Order ${o.id} → ${o.status}`;
    }
    case 'VALET_REQUEST': {
      const v = find(s.valet, cmd.ticketId, 'valet ticket');
      const g = s.guests.find((x) => x.email === actor.email);
      const own = g && v.guest === g.id;
      if (!own && !actor.roles.some((r) => ['foh', 'vendor', 'organizer'].includes(r))) throw new CommandError('Not your ticket', 403);
      if (v.status !== 'stored') throw new CommandError('Car is not in storage');
      v.status = 'requested';
      return `RetrievalRequested ${v.claim}`;
    }
    case 'VALET_ADVANCE': {
      const v = find(s.valet, cmd.ticketId, 'valet ticket');
      const i = VALET_FLOW.indexOf(v.status);
      if (i >= VALET_FLOW.length - 1) throw new CommandError('Vehicle already released');
      v.status = VALET_FLOW[i + 1];
      return `Valet ${v.claim} → ${v.status}`;
    }

    // ---------------------------------------------------------------- organizer
    case 'SIGN_GATE': {
      const g = find(s.gates, cmd.gateId, 'gate');
      if (g.signedBy) throw new CommandError('Gate already signed');
      const idx = s.gates.indexOf(g);
      if (idx > 0 && !s.gates[idx - 1].signedBy) throw new CommandError('Sign the earlier gate first');
      g.signedBy = actor.email;
      g.signedAt = now;
      return `Gate ${g.id} signed`;
    }
    case 'ADVANCE_LIFECYCLE': {
      const i = LIFECYCLE.indexOf(s.lifecycle);
      if (i >= LIFECYCLE.length - 1) throw new CommandError('Event already archived');
      s.lifecycle = LIFECYCLE[i + 1];
      return `Event → ${s.lifecycle}`;
    }
    case 'SET_LIFECYCLE':
      if (!LIFECYCLE.includes(cmd.lifecycle)) throw new CommandError('Unknown state');
      s.lifecycle = cmd.lifecycle;
      return `Event → ${s.lifecycle}`;
    case 'ADD_INCIDENT':
      s.incidents.unshift({ id: newId('i', now), title: text(cmd.title, 120, 'Title'), detail: String(cmd.detail ?? '').slice(0, 300), owner: String(cmd.owner ?? '').slice(0, 60) || actor.name, open: true, ts: now });
      return `Incident opened: ${cmd.title}`;
    case 'RESOLVE_INCIDENT': {
      const inc = find(s.incidents, cmd.incidentId, 'incident');
      inc.open = false;
      return `Incident resolved: ${inc.title}`;
    }
    case 'SET_WORKSTREAM': {
      const w = find(s.workstreams, cmd.workstreamId, 'workstream');
      w.status = cmd.status;
      return `${w.name} → ${cmd.status.replace('_', ' ')}`;
    }
    case 'SET_TEAM_SIZE':
      if (![2, 4, 6, 8].includes(cmd.size)) throw new CommandError('Team size must be 2, 4, 6 or 8');
      s.team.size = cmd.size;
      return `Team size → ${cmd.size}`;
    case 'SET_BUDGET': {
      const vals = [cmd.authorizedCents, cmd.committedCents, cmd.settledCents, cmd.stepUpLimitCents].map(Number);
      if (vals.some((v) => !Number.isFinite(v) || v < 0)) throw new CommandError('Budget values must be positive numbers');
      [s.budget.authorizedCents, s.budget.committedCents, s.budget.settledCents, s.budget.stepUpLimitCents] = vals.map(Math.round);
      return 'Budget updated';
    }
    case 'RENAME_EVENT':
      s.name = text(cmd.name, 120, 'Name');
      s.venue = String(cmd.venue ?? '').slice(0, 120);
      return `Event renamed: ${s.name}`;

    // ---------------------------------------------------------------- networking & bridge
    case 'JOIN_TABLE': {
      const t = find(s.tables, cmd.tableId, 'table');
      if (!t.seats.includes(actor.email) && t.seats.length >= t.capacity) throw new CommandError('That table is full');
      for (const o of s.tables) o.seats = o.seats.filter((x) => x !== actor.email);
      t.seats.push(actor.email);
      return `${actor.name} joined ${t.name}`;
    }
    case 'LEAVE_TABLE':
      for (const o of s.tables) o.seats = o.seats.filter((x) => x !== actor.email);
      return `${actor.name} left their table`;
    case 'BRIDGE_MIC':
      s.bridgeMics[actor.email] = !!cmd.on;
      return `bridge-mic:${cmd.on ? 'on' : 'off'}`;
    case 'BRIDGE_LOG': {
      const t = text(cmd.text, 200, 'Note');
      s.bridgeLog.unshift({ ts: now, who: actor.name, text: t });
      if (s.bridgeLog.length > 100) s.bridgeLog.length = 100;
      return `Bridge: ${t}`;
    }
    // ---------------------------------------------------------------- small-team breakouts
    case 'CREATE_BREAKOUT': {
      if (s.breakouts.length >= MAX_BREAKOUTS) throw new CommandError('This event has reached its breakout limit', 409);
      const b: Breakout = {
        id: newId('bo', now), name: text(cmd.name, 80, 'Breakout name'), topic: cmd.topic ? text(cmd.topic, 200, 'Topic') : '',
        capacity: cmd.capacity, status: 'open', createdBy: actor.email, createdAt: now, members: [], messages: [],
      };
      s.breakouts.unshift(b);
      return `Breakout created: ${b.name}`;
    }
    case 'JOIN_BREAKOUT': {
      const b = find(s.breakouts, cmd.breakoutId, 'breakout');
      if (b.status !== 'open') throw new CommandError('That breakout has ended');
      if (!isMember(b, actor.email)) {
        if (b.members.length >= b.capacity) throw new CommandError('That breakout is full');
        // One breakout at a time: joining one leaves the other.
        for (const o of s.breakouts) o.members = o.members.filter((m) => m.email !== actor.email);
        b.members.push({ email: actor.email, name: actor.name, joinedAt: now });
      }
      return `${actor.name} joined ${b.name}`;
    }
    case 'LEAVE_BREAKOUT': {
      const current = currentBreakout(s.breakouts, actor.email);
      if (!current) throw new CommandError("You're not in a breakout");
      current.members = current.members.filter((m) => m.email !== actor.email);
      return `${actor.name} left ${current.name}`;
    }
    case 'END_BREAKOUT': {
      const b = find(s.breakouts, cmd.breakoutId, 'breakout');
      if (b.status === 'ended') throw new CommandError('That breakout has already ended');
      b.status = 'ended';
      b.endedAt = now;
      b.members = [];
      return `Breakout ended: ${b.name}`;
    }
    case 'BREAKOUT_CHAT': {
      const t = text(cmd.text, 500, 'Message');
      const b = currentBreakout(s.breakouts, actor.email);
      if (!b) throw new CommandError('Join a breakout before chatting', 403);
      b.messages.push({ id: newId('bm', now), author: actor.email, authorName: actor.name, text: t, ts: now });
      if (b.messages.length > MAX_BREAKOUT_MESSAGES) b.messages.splice(0, b.messages.length - MAX_BREAKOUT_MESSAGES);
      return 'breakout chat';
    }
    case 'SET_BREAKOUT_NOTES': {
      const b = find(s.breakouts, cmd.breakoutId, 'breakout');
      if (!canReadBreakoutRoom(b, actor)) throw new CommandError('Only breakout members or hosts can save notes', 403);
      b.notes = { text: text(cmd.text, 8000, 'Notes'), generatedAt: now, by: actor.email };
      return `Notes saved: ${b.name}`;
    }
    // ---------------------------------------------------------------- video room
    case 'CALL_JOIN': {
      // One publication per person: joining again replaces the previous one.
      s.call = s.call.filter((p) => p.email !== actor.email);
      s.call.push({ email: actor.email, name: actor.name, sessionId: cmd.sessionId, tracks: [...cmd.tracks], joinedAt: now });
      return `${actor.name} joined the video room`;
    }
    case 'CALL_LEAVE': {
      if (!s.call.some((p) => p.email === actor.email)) throw new CommandError("You're not in the video room");
      s.call = s.call.filter((p) => p.email !== actor.email);
      return `${actor.name} left the video room`;
    }
    // ---------------------------------------------------------------- sign-up & guest roster
    case 'SET_SIGNUP_FORM': {
      const ids = new Set<string>();
      const questions = cmd.questions.map((q) => {
        if (ids.has(q.id)) throw new CommandError('Each sign-up question needs a unique id');
        ids.add(q.id);
        return { id: q.id, label: text(q.label, 200, 'Question'), required: !!q.required };
      });
      s.signup = { open: !!cmd.open, capacity: cmd.capacity, questions };
      return `Sign-up ${cmd.open ? 'open' : 'closed'}${cmd.capacity ? ` · capacity ${cmd.capacity}` : ''}`;
    }
    case 'SIGNUP': {
      const form = s.signup;
      const answers = cleanAnswers(form.questions, cmd.answers);
      const existing = s.guests.find((x) => x.email === actor.email);
      if (existing) {
        // Changing answers is allowed; a closed form only stops new sign-ups.
        existing.answers = answers;
        return `${existing.name} updated sign-up answers`;
      }
      if (!form.open) throw new CommandError('Sign-up is closed', 403);
      const registered = s.guests.filter((x) => !x.waitlisted).length;
      if (form.capacity !== null && registered >= form.capacity) {
        const name = cmd.name?.trim() || actor.name;
        s.guests.push({ id: newId('g', now), name, email: actor.email, type: typeFor(cmd.mode), mode: cmd.mode, checkedIn: false, waitlisted: true, answers });
        return `${name} waitlisted (sign-up is full)`;
      }
      apply(s, { type: 'REGISTER', mode: cmd.mode, name: cmd.name }, actor, now);
      const g = s.guests.find((x) => x.email === actor.email)!;
      g.answers = answers;
      return `${g.name} signed up · ${cmd.mode.replace('_', ' ')}`;
    }
    case 'SET_GUEST_WAITLIST': {
      const g = find(s.guests, cmd.guestId, 'guest');
      if (!cmd.waitlisted) {
        if (!g.waitlisted) throw new CommandError(`${g.name} is already registered`);
        const registered = s.guests.filter((x) => !x.waitlisted).length;
        if (s.signup.capacity !== null && registered >= s.signup.capacity) throw new CommandError('Sign-up is at capacity', 409);
        admit(s, g, now);
        return `${g.name} approved from the waitlist`;
      }
      if (g.waitlisted) return `${g.name} is already waitlisted`;
      throw new CommandError('Only waitlisted guests can be moved back to the waitlist. Use check-in for registered guests.');
    }
    case 'IMPORT_GUESTS': {
      let added = 0;
      let skipped = 0;
      for (const row of cmd.rows) {
        const email = row.email?.trim().toLowerCase() || undefined;
        if (email && s.guests.some((x) => x.email === email)) { skipped++; continue; }
        const name = text(row.name, 120, 'Name');
        const g: Guest = { id: newId('g', now), name, email, type: typeFor(row.mode), mode: row.mode, checkedIn: false };
        admit(s, g, now);
        s.guests.push(g);
        added++;
      }
      return `Imported ${added} guest${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} already on the roster` : ''}`;
    }

    // ---------------------------------------------------------------- surveys
    case 'SURVEY_CREATE': {
      if (s.surveys.length >= MAX_SURVEYS) throw new CommandError('This event has reached its survey limit', 409);
      const questions = cmd.questions.map((q): Survey['questions'][number] => {
        const prompt = text(q.prompt, 300, 'Question');
        if (q.kind === 'choice') {
          const options = (q.options ?? []).map((o) => text(o, 80, 'Option'));
          if (options.length < 2) throw new CommandError('Give each choice question 2 to 6 options');
          return { id: newId('sq', now), prompt, kind: 'choice', options };
        }
        return { id: newId('sq', now), prompt, kind: q.kind, options: q.kind === 'rating' ? ['1', '2', '3', '4', '5'] : [] };
      });
      s.surveys.unshift({
        id: newId('sv', now), title: text(cmd.title, 120, 'Title'), status: 'draft', anonymous: !!cmd.anonymous,
        questions, responses: [], responded: [], createdBy: actor.email, createdAt: now,
      });
      return `Survey created: ${cmd.title}`;
    }
    case 'SURVEY_SET_STATUS': {
      const sv = find(s.surveys, cmd.surveyId, 'survey');
      if (cmd.status === 'open' && !sv.questions.length) throw new CommandError('Add questions before opening a survey');
      sv.status = cmd.status;
      return `Survey ${cmd.status}: ${sv.title}`;
    }
    case 'SURVEY_DELETE': {
      const sv = find(s.surveys, cmd.surveyId, 'survey');
      s.surveys = s.surveys.filter((x) => x.id !== sv.id);
      return `Survey deleted: ${sv.title}`;
    }
    case 'SURVEY_RESPOND': {
      const sv = find(s.surveys, cmd.surveyId, 'survey');
      if (sv.status !== 'open') throw new CommandError('This survey is not open');
      const key = respondentKey(s.id, actor.email);
      if (sv.responded.includes(key)) throw new CommandError("You've already answered this survey", 409);
      const answers: Record<string, number | string> = {};
      sv.questions.forEach((q) => {
        const v = cmd.answers[q.id];
        if (q.kind === 'text') {
          if (typeof v === 'string' && v.trim()) answers[q.id] = v.trim().slice(0, 1000);
          return;
        }
        if (typeof v !== 'number' || !Number.isInteger(v)) throw new CommandError(`Answer "${q.prompt}"`);
        if (q.kind === 'rating' && (v < 1 || v > 5)) throw new CommandError(`Rate "${q.prompt}" from 1 to 5`);
        if (q.kind === 'choice' && (v < 0 || v >= q.options.length)) throw new CommandError(`Choose an option for "${q.prompt}"`);
        answers[q.id] = v;
      });
      sv.responses.push({
        id: newId('sr', now), by: sv.anonymous ? undefined : actor.email, byName: sv.anonymous ? undefined : actor.name, answers, ts: now,
      });
      sv.responded.push(key);
      return `Survey answered: ${sv.title}`;
    }

    // ---------------------------------------------------------------- session recording
    case 'SET_SESSION_RECORDING': {
      const current = s.sessionRecordings[cmd.key];
      if (cmd.recordingId) {
        if (!s.call.some((p) => p.email === actor.email)) throw new CommandError('Join the video room before recording it', 403);
        if (current) throw new CommandError('This session is already being recorded', 409);
        s.sessionRecordings[cmd.key] = { recordingId: cmd.recordingId, by: actor.email, startedAt: now };
        return 'Recording started · video room';
      }
      if (!current) throw new CommandError('Nothing is being recorded', 409);
      if (current.by !== actor.email && !actor.roles.some((r) => ['organizer', 'producer', 'moderator'].includes(r))) {
        throw new CommandError('Only the person who started this recording can stop it', 403);
      }
      delete s.sessionRecordings[cmd.key];
      return 'Recording stopped · video room';
    }

    default: {
      const never: never = cmd;
      throw new CommandError(`Unknown command ${(never as { type: string }).type}`);
    }
  }
}

/** Advance to the next pending cue: mark the live one done, take its scene. */
export function fireNextCue(s: EventState, now: number): string {
  const live = s.cues.find((c) => c.status === 'live');
  const next = s.cues.find((c) => c.status === 'pending');
  if (!next) throw new CommandError('No more cues');
  if (live) live.status = 'done';
  next.status = 'live';
  s.production.cueIndex = s.cues.indexOf(next);
  // Re-anchor the plan: the cue starts now on the event clock.
  const tau = now - s.epoch;
  const drift = tau - next.at;
  for (const c of s.cues) if (c.status === 'pending') c.at += drift;
  next.at = tau;
  if (next.sceneSourceId && s.sources.some((x) => x.id === next.sceneSourceId)) {
    if (next.sceneSourceId !== s.production.programId) s.production.previewId = s.production.programId;
    s.production.programId = next.sceneSourceId;
    syncTalentOnAir(s);
  }
  return `FIRE_CUE ${next.title}`;
}

/** The talent whose source is on program is LIVE; anyone who was live and isn't goes back to ready. */
function syncTalentOnAir(s: EventState) {
  const prog = s.sources.find((x) => x.id === s.production.programId);
  for (const t of s.talent) {
    const onAir = prog?.talentId === t.id;
    if (onAir) t.state = 'live';
    else if (t.state === 'live') t.state = 'off';
  }
}

export const MAX_SURVEYS = 20;

function typeFor(mode: Guest['mode']): AttendeeType {
  return mode === 'in_person' ? 'in_person' : mode === 'online' ? 'virtual' : mode;
}

/** Let a registered guest in: in-person guests get a seat, everyone else is checked in. */
function admit(s: EventState, g: Guest, now: number) {
  g.waitlisted = false;
  if (g.mode === 'in_person') {
    if (!g.seat) {
      const occupied = new Set(s.guests.map((x) => x.seat).filter(Boolean));
      let seat = 1;
      while (occupied.has(`R-${seat}`)) seat++;
      g.seat = `R-${seat}`;
    }
  } else {
    g.checkedIn = true;
    g.checkedInAt = now;
  }
}

/** Answers must cover every required question. Unknown keys are dropped. */
function cleanAnswers(questions: SignupQuestion[], input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const value = Object.hasOwn(input, q.id) && typeof input[q.id] === 'string' ? input[q.id].trim() : '';
    if (q.required && !value) throw new CommandError(`${q.label} is required`);
    if (value) out[q.id] = value.slice(0, 1000);
  }
  return out;
}

function label(s: EventState, id: string): string {
  return s.sources.find((x) => x.id === id)?.label ?? id;
}

function whereOf(s: EventState, actor: Actor): string {
  const g = s.guests.find((x) => x.email === actor.email);
  if (!g) return actor.roles.some((r) => r !== 'attendee') ? 'Crew' : 'online';
  if (g.mode === 'in_person') return 'In the room';
  if (g.mode === 'watch_party') return 'Watch party';
  return 'online';
}
