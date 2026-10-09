import type { EventState } from './types';

const MIN = 60_000;

/**
 * A new event starts from this demo content so every screen has something to show.
 * Organizers can clear or change it; everything here is ordinary state.
 */
export function seedEvent(id: string, name: string, kind: 'corporate' | 'social', createdBy: string, now: number): EventState {
  const epoch = now - 64 * MIN; // the show has been running ~1 hour
  return {
    id,
    name,
    kind,
    venue: 'Ballroom B + online',
    createdBy,
    lifecycle: 'Active',
    epoch,
    seq: 0,
    team: { size: 6 },

    production: {
      onAir: true,
      hold: false,
      recording: true,
      programId: 'tal-a',
      previewId: 'tal-b',
      autoDirector: true,
      layout: 'speaker',
      autoRun: true,
      cueIndex: 1,
    },
    sources: [
      { id: 'cam1', label: 'CAM 1 · Wide', meta: 'iPhone · ProDock', kind: 'camera' },
      { id: 'cam2', label: 'CAM 2 · Host', meta: 'iPhone 4K · WARP', kind: 'camera' },
      { id: 'tal-a', label: 'Dr. Ana Ruiz', meta: 'Remote · Lisbon · 38 ms', kind: 'talent', talentId: 't-ruiz' },
      { id: 'tal-b', label: 'Kenji Mori', meta: 'Remote · Osaka · 112 ms', kind: 'talent', talentId: 't-mori' },
      { id: 'tal-c', label: 'Ife Okafor', meta: 'On-site · Ballroom B', kind: 'talent', talentId: 't-okafor' },
      { id: 'slides', label: 'Slides · Deck 3', meta: 'Presenter-synced', kind: 'media' },
      { id: 'vt', label: 'VT · Sponsor roll', meta: 'R2 asset · 0:45', kind: 'media' },
      { id: 'room', label: 'Room · Ballroom B', meta: 'Edge gateway', kind: 'room' },
    ],
    cues: [
      { id: 'c-open', title: 'Opening & welcome', detail: 'Host on CAM 2', at: 0, durationMs: 10 * MIN, auto: false, status: 'done', sceneSourceId: 'cam2' },
      { id: 'c-key', title: 'Keynote interview', detail: 'Ruiz + host', at: 52 * MIN, durationMs: 18 * MIN, auto: false, status: 'live', sceneSourceId: 'tal-a' },
      { id: 'c-panel', title: 'Panel: Building for hybrid audiences', detail: 'Mori + Okafor · lights 40% · music up', at: 70 * MIN, durationMs: 22 * MIN, auto: false, status: 'pending', sceneSourceId: 'tal-b' },
      { id: 'c-vt', title: 'Sponsor VT · 0:45', detail: 'Fires on its own after the panel', at: 92 * MIN, durationMs: 45_000, auto: true, status: 'pending', sceneSourceId: 'vt' },
      { id: 'c-qa', title: 'Audience Q&A', detail: 'Host leads · moderated', at: 93 * MIN, durationMs: 12 * MIN, auto: false, status: 'pending', sceneSourceId: 'cam2' },
      { id: 'c-close', title: 'Close · replay link to everyone', detail: 'Holding slate after', at: 105 * MIN, durationMs: 3 * MIN, auto: true, status: 'pending', sceneSourceId: 'cam1' },
    ],
    buses: [
      { id: 'pgm', name: 'PGM', gainDb: -8, muted: false },
      { id: 'talent', name: 'Talent', gainDb: -12, muted: false },
      { id: 'music', name: 'Music', gainDb: -30, muted: true },
      { id: 'room', name: 'Room', gainDb: -18, muted: false },
    ],
    talent: [
      { id: 't-ruiz', name: 'Dr. Ana Ruiz', where: 'Lisbon · remote', state: 'live', greenRoom: 'Green Room 1', preflight: { camera: true, mic: true, network: '62 Mbps · 38 ms', checkedAt: epoch + 40 * MIN } },
      { id: 't-mori', name: 'Kenji Mori', where: 'Osaka · remote', state: 'standby', greenRoom: 'Green Room 2', preflight: { camera: true, mic: true, network: '84 Mbps · 112 ms', checkedAt: epoch + 58 * MIN } },
      { id: 't-okafor', name: 'Ife Okafor', where: 'Ballroom B · on-site', state: 'ready', greenRoom: 'Green Room 1' },
      { id: 't-lee', name: 'Dana Lee', where: 'Lobby', state: 'arrived', greenRoom: 'Green Room 1' },
    ],
    subscribers: [
      { id: 'main', name: 'Main Stage · virtual', takes: 'Video, program audio, captions, data', adds: 'Q&A and poll overlays, reactions', delivery: 'WebRTC · <300 ms', viewers: 2418, on: true },
      { id: 'overflow', name: 'Overflow · Ballroom C screens', takes: 'Clean video, room audio mix', adds: 'Venue signage frame', delivery: 'Local edge · <80 ms', viewers: 210, on: true },
      { id: 'workshop', name: 'Workshop Room', takes: 'Opening keynote only', adds: 'Own session when off bus', delivery: 'WebRTC · <300 ms', viewers: 612, on: false },
      { id: 'sponsor', name: 'Sponsor Theater', takes: 'Video, program audio', adds: 'Sponsor branding frame', delivery: 'WebRTC · <300 ms', viewers: 140, on: true },
      { id: 'parties', name: 'Watch parties · 22 rooms', takes: 'Video, audio, captions', adds: 'Party leaderboard, group vote', delivery: 'WHEP · ~1 s', viewers: 396, on: true },
      { id: 'lobby', name: 'Lobby ambient screens', takes: 'Video thumbnail, muted', adds: 'Up-next agenda', delivery: 'Edge · 720p', viewers: 0, on: true },
      { id: 'press', name: 'Press clean feed', takes: 'Clean video, program audio', adds: 'None · no graphics', delivery: 'SRT · 1080p60', viewers: 9, on: true },
      { id: 'interp', name: 'Interpreter booths ES / JA', takes: 'Clean program audio', adds: 'Publishes language tracks back', delivery: 'WebRTC · <150 ms', viewers: 4, on: true },
      { id: 'record', name: 'Recording · R2', takes: 'Every track + τ timestamps', adds: 'Chapter markers from cues', delivery: 'Mezzanine', viewers: 0, on: true },
      { id: 'external', name: 'Simulcast · YouTube, LinkedIn', takes: 'Video, audio, EN captions', adds: '7 s safety delay', delivery: 'RTMP/SRT out', viewers: 1240, on: true },
    ],
    contributors: [
      { id: 'austin', name: 'Technical breakout · Austin lab', device: 'Mac app · 3 cams', meta: 'Remote stage running its own show', status: 'offered' },
      { id: 'roamer', name: 'Expo floor roamer', device: 'iPhone · gimbal', meta: 'Field camera · source CAM 9', status: 'on_bus' },
      { id: 'mori', name: 'Kenji Mori · Osaka', device: 'Mac app · Continuity Camera', meta: 'Talent stream · Green Room 2', status: 'standby' },
      { id: 'whiteboard', name: 'Workshop whiteboard', device: 'iPad · Pencil', meta: 'Workshop Room only', status: 'local' },
    ],
    devices: [
      { id: 'd1', name: 'Director workstation', protocol: 'Native app', scope: 'Main Stage · all', trust: 'WARP + posture', rttMs: 9, cert: 'Certified', healthy: true },
      { id: 'd2', name: 'Avid S6 · Room A', protocol: 'EUCON bridge', scope: 'Audio buses 1–8', trust: 'Studio gateway', rttMs: 4, cert: 'Tested', healthy: true },
      { id: 'd3', name: 'X-Touch · OSC', protocol: 'OSC/UDP', scope: 'Scene take, GFX', trust: 'Gateway · device cert', rttMs: 3, cert: 'Implemented', healthy: true },
      { id: 'd4', name: 'ETC lighting gateway', protocol: 'OSC → sACN', scope: 'Cues L-1…L-40', trust: 'Production subnet', rttMs: 2, cert: 'Tested', healthy: true },
      { id: 'd5', name: 'CAM 2 · iPhone', protocol: 'WebRTC · AV1', scope: 'Contribution + tally', trust: 'WARP + user', rttMs: 21, cert: 'Certified', healthy: true },
      { id: 'd6', name: 'SDI edge gateway', protocol: 'SDI → SRT', scope: 'Ballroom B ingest', trust: 'mTLS service', rttMs: 6, cert: 'Tested', healthy: true },
      { id: 'd7', name: 'Mori · talent kit', protocol: 'WebRTC', scope: 'Contribution only', trust: 'Access + passkey', rttMs: 112, cert: 'Certified', healthy: false },
    ],

    polls: [
      {
        id: 'p-barrier', question: "What's the biggest barrier to hybrid events at your company?",
        options: ['Audio and video quality', 'Remote speakers feel distant', 'Running the production', 'Cost and contracts'],
        status: 'open', votes: {}, onProgram: false, kind: 'choice',
      },
      { id: 'p-word', question: 'One word for today', options: [], status: 'open', votes: {}, onProgram: false, kind: 'wordcloud', words: { presence: 9, seamless: 4, immersive: 6, inclusive: 5, calm: 2 } },
      { id: 'p-rate', question: 'Rate this session', options: ['1', '2', '3', '4', '5'], status: 'draft', votes: {}, onProgram: false, kind: 'rating' },
      { id: 'p-city', question: "Where should next year's summit be?", options: ['Austin', 'Lisbon', 'Osaka', 'Online only'], status: 'draft', votes: {}, onProgram: false, kind: 'choice' },
    ],
    questions: [
      { id: 'q1', text: 'How do you keep remote panelists feeling present when latency is above 100 ms?', author: 'seed:sana', authorName: 'Sana K.', anonymous: false, where: 'Ballroom B', upvotes: seedVotes(112), status: 'approved', ts: epoch + 50 * MIN },
      { id: 'q2', text: 'Does one setup serve in-person and online audiences at once?', author: 'seed:alex', authorName: 'Alex R.', anonymous: false, where: 'online · Denver', upvotes: seedVotes(64), status: 'new', ts: epoch + 55 * MIN },
      { id: 'q3', text: 'What does a two-person team need to run a show like this?', author: 'seed:anon', authorName: 'Anonymous', anonymous: true, where: 'Ballroom B', upvotes: seedVotes(41), status: 'new', ts: epoch + 57 * MIN },
      { id: 'q4', text: 'Will the recording include ISO tracks for our editors?', author: 'seed:tom', authorName: 'Tom W.', anonymous: false, where: 'online', upvotes: seedVotes(19), status: 'new', ts: epoch + 60 * MIN },
    ],
    chat: [
      { id: 'm1', channel: 'everyone', author: 'seed:sana', authorName: 'Sana K.', where: 'Ballroom B', text: "The Osaka feed looks like he's in the room.", ts: epoch + 58 * MIN, held: false, pinned: false },
      { id: 'm2', channel: 'everyone', author: 'seed:mod', authorName: 'Moderator', where: 'Crew', text: 'Gala shuttle runs from the north entrance at 6:15.', ts: epoch + 59 * MIN, held: false, pinned: true },
      { id: 'm3', channel: 'everyone', author: 'seed:wei', authorName: 'Wei L.', where: 'Watch party · Singapore', text: '18 of us here, great audio.', ts: epoch + 61 * MIN, held: false, pinned: false },
      { id: 'm4', channel: 'everyone', author: 'seed:spam', authorName: 'Guest 4471', where: 'online', text: 'free tickets at bit.ly/xyz', ts: epoch + 62 * MIN, held: true, pinned: false },
    ],
    reactions: { applause: 1204, love: 388, laugh: 921, wow: 77, confused: 42 },
    hands: [
      { id: 'h1', who: 'seed:lena', name: 'Lena Ortiz · online', where: 'online', status: 'raised', preflightOk: true },
      { id: 'h2', who: 'seed:t12', name: 'Table 12 · Ballroom B', where: 'Ballroom B', status: 'raised', preflightOk: false },
    ],
    resources: [
      { id: 'r1', title: 'Panel slides · PDF', note: 'Pushed by speaker' },
      { id: 'r2', title: 'Hybrid playbook', note: 'Sponsor offer' },
      { id: 'r3', title: 'Book a 1:1 with a speaker', note: '4 slots left' },
    ],

    guests: [
      { id: 'g1', name: 'Jordan Patel', type: 'in_person', mode: 'in_person', seat: 'F-14', checkedIn: true, checkedInAt: epoch - 20 * MIN },
      { id: 'g2', name: 'Priya Natarajan', type: 'staff', mode: 'in_person', checkedIn: false, grantedRole: 'Audio engineer · Control Room A' },
      { id: 'g3', name: 'Ife Okafor', type: 'speaker', mode: 'in_person', checkedIn: true, checkedInAt: epoch - 40 * MIN, grantedRole: 'Talent · Green Room 1' },
      { id: 'g4', name: 'Sana Khan', type: 'in_person', mode: 'in_person', seat: 'C-03', checkedIn: false },
      { id: 'g5', name: 'Marcus Bell', type: 'moderator', mode: 'in_person', checkedIn: true, checkedInAt: epoch - 50 * MIN },
      { id: 'g6', name: 'Lena Ortiz', type: 'virtual', mode: 'online', checkedIn: true, checkedInAt: epoch + 5 * MIN },
      { id: 'g7', name: 'Wei Lim', type: 'watch_party', mode: 'watch_party', checkedIn: true, checkedInAt: epoch },
      { id: 'g8', name: 'Tom Walsh', type: 'press', mode: 'in_person', seat: 'Press row', checkedIn: false },
    ],
    orders: [
      { id: 'A-118', guest: 'g1', guestName: 'Jordan Patel', vendor: 'Riverwalk Catering', items: '2 oat lattes, 1 croissant', totalCents: 1840, status: 'preparing', seat: 'F-14', ts: epoch + 60 * MIN },
    ],
    valet: [
      { id: 'v1', claim: 'V-2207', guest: 'g1', guestName: 'Jordan Patel', vehicle: 'Gray Model Y · level 2', status: 'stored' },
    ],

    gates: [
      { id: 'G1', question: 'Is the event justified?', evidence: 'Approved charter', signedBy: createdBy, signedAt: epoch - 90 * 24 * 60 * MIN },
      { id: 'G2', question: 'Feasible financially and operationally?', evidence: 'Budget and feasibility review', signedBy: createdBy, signedAt: epoch - 70 * 24 * 60 * MIN },
      { id: 'G3', question: 'May resources be committed?', evidence: 'Delegated authority', signedBy: createdBy, signedAt: epoch - 60 * 24 * 60 * MIN },
      { id: 'G4', question: 'Contracts and risks acceptable?', evidence: 'Executed agreements · risk register', signedBy: createdBy, signedAt: epoch - 20 * 24 * 60 * MIN },
      { id: 'G5', question: 'Ready to proceed?', evidence: 'Readiness checklist', signedBy: createdBy, signedAt: epoch - 30 * MIN },
      { id: 'G6', question: 'Can operations close?', evidence: 'Invoices, acceptance, incidents resolved' },
      { id: 'G7', question: 'Were objectives achieved?', evidence: 'Reconciliation and evaluation report' },
    ],
    workstreams: [
      { id: 'w-fin', name: 'Finance', owner: 'Finance lead', detail: '3 deposits released · 2 invoices due', status: 'on_track' },
      { id: 'w-venue', name: 'Venue', owner: 'Convention center', detail: 'Ballroom B 640 / 700', status: 'on_track' },
      { id: 'w-guests', name: 'Guests', owner: 'Front of house', detail: 'Check-in running', status: 'live' },
      { id: 'w-prod', name: 'Production', owner: 'Exec producer', detail: '1 talent link on backup path', status: 'watch' },
      { id: 'w-hosp', name: 'Hospitality', owner: 'Catering lead', detail: 'Seat orders and valet live', status: 'live' },
      { id: 'w-risk', name: 'Risk', owner: 'Safety officer', detail: 'Permits, insurance, security on file', status: 'on_track' },
      { id: 'w-people', name: 'Personnel', owner: 'Ops manager', detail: '41 staff · 12 volunteers', status: 'on_track' },
      { id: 'w-comms', name: 'Communications', owner: 'Marketing', detail: 'Gala reminder queued', status: 'live' },
    ],
    vendors: [
      { id: 'vn1', name: 'Riverwalk Catering', meta: 'Per-order split', status: 'Settling live' },
      { id: 'vn2', name: 'Alamo Valet Co.', meta: 'Custody log', status: 'Settles at close' },
      { id: 'vn3', name: 'Hotel Emma block', meta: 'Room block', status: 'Attrition review' },
      { id: 'vn4', name: 'Stagecraft AV', meta: 'Fixed fee · deposit paid', status: 'Invoice due' },
    ],
    incidents: [
      { id: 'i1', title: 'Osaka talent link degraded', detail: 'TD switched to backup path B', owner: 'Production', open: true, ts: epoch + 56 * MIN },
      { id: 'i2', title: 'Accessible seating swap, row C', detail: 'Guest confirmed', owner: 'FOH', open: false, ts: epoch - 30 * MIN },
    ],
    budget: { authorizedCents: 0, committedCents: 0, settledCents: 0, stepUpLimitCents: 0 },

    tables: [
      { id: 'tb1', name: 'Producing for remote speakers', capacity: 6, seats: ['seed:priya', 'seed:wei', 'seed:tom', 'seed:sana'], note: 'Mixed room + online' },
      { id: 'tb2', name: 'Accessibility in live events', capacity: 6, seats: ['seed:a', 'seed:b', 'seed:c', 'seed:d'], note: 'Mixed room + online' },
      { id: 'tb3', name: 'AV procurement', capacity: 6, seats: ['seed:e', 'seed:f', 'seed:g', 'seed:h', 'seed:i', 'seed:j'], note: 'Full' },
      { id: 'tb4', name: 'Weddings & social events', capacity: 6, seats: ['seed:k', 'seed:l'], note: 'Online only' },
      { id: 'tb5', name: 'Audio for broadcast', capacity: 6, seats: ['seed:m', 'seed:n', 'seed:o', 'seed:p', 'seed:q'], note: 'Avid users' },
      { id: 'tb6', name: 'First-time attendees', capacity: 6, seats: ['seed:r', 'seed:s', 'seed:t'], note: 'Hosted by a volunteer' },
    ],
    bridgeLog: [
      { ts: epoch + 62 * MIN, who: 'Austin lab', text: 'Breakout ready to offer to the bus at 2:30' },
      { ts: epoch + 60 * MIN, who: 'Stage manager', text: 'Mori moved bridge → Green Room 2' },
      { ts: epoch + 57 * MIN, who: 'Catering', text: 'Break service 1:45, 6 carts' },
    ],
    bridgeMics: {},
    breakouts: [],
    recent: [],
  };
}

function seedVotes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `seed:v${i}`);
}
