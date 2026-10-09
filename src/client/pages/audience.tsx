import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useEvent, useTick } from '../store';
import { clockTime, Empty, fmtTau, Icon, ICONS, money, Person } from '../lib';
import { Monitor } from './production';
import { ChatText, LanguagePicker, useTranslateTo } from '../translate';
import type { ChatMessage, EventView, Guest, PollView } from '../../shared/types';

const srcLabel = (s: EventView, id: string) => s.sources.find((x) => x.id === id)?.label ?? id;
const openChoicePoll = (s: EventView) => s.polls.find((p) => p.status === 'open' && p.kind === 'choice');
const myGuest = (s: EventView, email: string): Guest | undefined => s.guests.find((g) => g.email === email);

// ======================================================================= shared pieces

export function PollCard({ poll, big = false }: { poll: PollView; big?: boolean }) {
  const { send } = useEvent();
  const voted = poll.myVote !== null;
  const showResults = voted || poll.status === 'closed';
  return (
    <div className="stack">
      <span style={{ fontSize: big ? 24 : 18, fontWeight: big ? 700 : 600, lineHeight: 1.3 }}>{poll.question}</span>
      {poll.options.map((o, i) => {
        const pct = poll.total ? Math.round((poll.counts[i] / poll.total) * 100) : 0;
        return (
          <button key={i} className={`choice ${poll.myVote === i ? 'on' : ''}`} style={{ minHeight: big ? 60 : 48 }} aria-pressed={poll.myVote === i} aria-disabled={poll.status !== 'open'}
            onClick={() => poll.status === 'open' && poll.myVote !== i && send({ type: 'VOTE', pollId: poll.id, option: i })}>
            <span className="fill" style={{ width: showResults ? `${pct}%` : '0%' }} />
            <span style={{ fontWeight: 600, fontSize: big ? 16 : 14 }}>{o}</span>
            <span className="mono" style={{ color: 'var(--text-2)' }}>{showResults ? `${pct}%` : ''}</span>
          </button>
        );
      })}
      <span className="small muted">
        {poll.status === 'closed' ? `Closed · ${poll.total} votes` : voted ? `Vote counted · ${poll.total} votes so far. You can change it until the poll closes.` : 'Tap an answer to vote. Results show after you vote.'}
      </span>
    </div>
  );
}

export function QuestionList({ limit = 6, showAsk = true }: { limit?: number; showAsk?: boolean }) {
  const { snap, send } = useEvent();
  const qs = [...snap.state.questions].filter((q) => q.status !== 'dismissed').sort((a, b) => b.votes - a.votes).slice(0, limit);
  return (
    <div className="stack">
      {qs.map((q) => (
        <div key={q.id} className="well row nowrap-row top">
          <button className={`btn ${q.mine ? 'on' : 'ghost'}`} style={{ minWidth: 48, minHeight: 48, flexDirection: 'column', gap: 0, padding: 0 }} aria-pressed={q.mine} aria-label="Upvote" onClick={() => send({ type: 'UPVOTE', questionId: q.id })}>
            <Icon d={ICONS.up} size={14} stroke={2.4} /><span style={{ fontSize: 12 }}>{q.votes}</span>
          </button>
          <div className="stack tight" style={{ gap: 4 }}>
            <span style={{ lineHeight: 1.4 }}>{q.text}</span>
            <span className={`small ${q.status === 'on_stage' ? 'pgm' : q.status === 'answered' ? 'ok' : q.status === 'approved' ? 'warn' : 'muted'}`}>
              {q.status === 'on_stage' ? 'On stage now' : q.status === 'answered' ? 'Answered' : q.status === 'approved' ? 'Selected for stage' : `${q.authorName} · ${q.where}`}{q.byMe ? ' · yours' : ''}
            </span>
          </div>
        </div>
      ))}
      {!qs.length && <Empty>No questions yet. Be the first.</Empty>}
      {showAsk && <AskForm />}
    </div>
  );
}

export function AskForm() {
  const { send } = useEvent();
  const [text, setText] = useState('');
  const [anon, setAnon] = useState(false);
  return (
    <form className="stack tight" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && await send({ type: 'ASK', text, anonymous: anon })) setText(''); }}>
      <label className="fieldlabel">Ask the speakers<input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a question…" maxLength={280} /></label>
      <div className="row between"><label className="check"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />Post anonymously</label><button className="btn primary" type="submit" disabled={!text.trim()}>Send</button></div>
    </form>
  );
}

const CHANNELS: { id: ChatMessage['channel']; name: string }[] = [
  { id: 'everyone', name: 'Everyone' }, { id: 'room', name: 'In the room' }, { id: 'table', name: 'My table' }, { id: 'party', name: 'Watch party' },
];

export function ChatBox({ height = 280 }: { height?: number }) {
  const { snap, send } = useEvent();
  const [ch, setCh] = useState<ChatMessage['channel']>('everyone');
  const [text, setText] = useState('');
  const [reading, setReading] = useTranslateTo();
  const msgs = snap.state.chat.filter((m) => m.channel === ch);
  const pinned = snap.state.chat.find((m) => m.pinned);
  return (
    <div className="stack">
      <div className="seg" role="tablist">{CHANNELS.map((c) => <button key={c.id} role="tab" aria-selected={ch === c.id} className={ch === c.id ? 'on' : ''} onClick={() => setCh(c.id)}>{c.name}</button>)}</div>
      <LanguagePicker value={reading} onChange={setReading} />
      {pinned && <div className="panel accent" style={{ padding: 8 }}><span className="small accent">Pinned · {pinned.authorName}</span><span>{pinned.text}</span></div>}
      <div className="stack tight" style={{ maxHeight: height, overflowY: 'auto' }}>
        {msgs.filter((m) => !m.pinned).slice(-40).map((m) => (
          <div key={m.id}><b>{m.authorName}</b> <span className="small muted">{m.where} · {clockTime(m.ts)}{m.held ? ' · held for review' : ''}</span><ChatText text={m.text} target={reading} /></div>
        ))}
        {!msgs.length && <Empty>Nothing here yet.</Empty>}
      </div>
      <form className="row nowrap-row" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && await send({ type: 'CHAT', channel: ch, text })) setText(''); }}>
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something…" aria-label="Message" maxLength={500} />
        <button className="btn" type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}

const REACTIONS = [
  { id: 'applause', name: 'Applause', icon: ICONS.applause, color: '#F2B33D' },
  { id: 'love', name: 'Love', icon: ICONS.love, color: '#FF6B70' },
  { id: 'laugh', name: 'Laugh', icon: ICONS.laugh, color: '#3FD98A' },
  { id: 'wow', name: 'Wow', icon: ICONS.wow, color: '#4CC9F0' },
  { id: 'confused', name: 'Confused', icon: ICONS.confused, color: '#A3ACB8' },
];

export function Reactions() {
  const { snap, send } = useEvent();
  return (
    <div className="row">
      {REACTIONS.map((r) => (
        <button key={r.id} className="btn" style={{ borderRadius: 999 }} aria-label={r.name} onClick={() => send({ type: 'REACT', reaction: r.id })}>
          <Icon d={r.icon} color={r.color} /><span className="small">{r.name}</span><span className="mono small muted">{(snap.state.reactions[r.id] ?? 0).toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

function HandButton() {
  const { snap, send } = useEvent();
  const mine = snap.state.hands.find((h) => h.who === snap.me.email && h.status !== 'lowered');
  if (!mine) return <button className="btn accent" onClick={() => send({ type: 'RAISE_HAND' })}>Raise hand to speak</button>;
  return (
    <div className="row">
      <span className="pill warn">{mine.status === 'invited' ? 'Invited to the green room' : mine.status === 'on_stage' ? 'You are on stage' : 'Hand raised'}</span>
      {mine.status === 'invited' && <Link className="btn sm accent" to="../green-room">Go to green room</Link>}
      <button className="btn sm ghost" onClick={() => send({ type: 'LOWER_HAND' })}>Lower</button>
    </div>
  );
}

function WordCloud({ poll }: { poll: PollView }) {
  const { send } = useEvent();
  const [w, setW] = useState('');
  const words = Object.entries(poll.words ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const max = Math.max(1, ...words.map(([, n]) => n));
  const palette = ['#4CC9F0', '#ECEEF1', '#F2B33D', '#C9CFD6', '#6BE3A2'];
  return (
    <div className="stack">
      <span className="label">Word cloud · {poll.question}</span>
      <div className="row" style={{ gap: '4px 12px', alignItems: 'baseline' }}>
        {words.map(([word, n], i) => <span key={word} style={{ fontSize: 13 + (n / max) * 20, fontWeight: n === max ? 700 : 500, color: palette[i % palette.length] }}>{word}</span>)}
        {!words.length && <Empty>No words yet.</Empty>}
      </div>
      {poll.myVote === null && poll.status === 'open' && (
        <form className="row nowrap-row" onSubmit={async (e) => { e.preventDefault(); if (w.trim() && await send({ type: 'WORD', pollId: poll.id, word: w })) setW(''); }}>
          <input className="field" value={w} onChange={(e) => setW(e.target.value)} placeholder="One word" maxLength={24} aria-label="Your word" /><button className="btn" type="submit">Add</button>
        </form>
      )}
    </div>
  );
}

// ======================================================================= How to attend (iPhone)

const MODES = [
  { id: 'in_person', name: 'In person', sub: 'Seat, meals, guest services', inc: ['Assigned seat', 'Order to seat', 'Valet & shuttle', 'Vote & Q&A on phone', 'Replays'] },
  { id: 'online', name: 'Online · live', sub: 'Every stage, broadcast quality', inc: ['All stages live', 'Chat, Q&A, polls', 'Raise hand', 'Breakouts', '1:1 meetings', 'Replays'] },
  { id: 'watch_party', name: 'Watch party', sub: 'For a team in one room', inc: ['Big-screen player', 'Group voting', 'Shared chat', 'Party leaderboard', 'Replays'] },
  { id: 'on_demand', name: 'On demand', sub: 'Watch later', inc: ['Session replays', 'Transcripts', 'Slides', 'Sponsor hall'] },
] as const;

function icsFor(s: EventView): string {
  const start = new Date(s.epoch);
  const end = new Date(s.epoch + 3 * 3_600_000);
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Habitat//Event//EN', 'BEGIN:VEVENT', `UID:${s.id}@habitat`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(start)}`, `DTEND:${f(end)}`, `SUMMARY:${s.name}`, `LOCATION:${s.venue}`, `URL:${location.origin}/e/${s.id}/lobby`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

export function Join() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const g = myGuest(s, snap.me.email);
  const [mode, setMode] = useState<(typeof MODES)[number]['id']>(g?.mode ?? 'online');
  const [partyId, setPartyId] = useState(g?.partyId ?? '');
  const m = MODES.find((x) => x.id === mode)!;
  const download = () => {
    const url = URL.createObjectURL(new Blob([icsFor(s)], { type: 'text/calendar' }));
    const a = document.createElement('a'); a.href = url; a.download = `${s.name}.ics`; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="device">
      <div className="stack tight"><span className="small muted">{s.name}</span><h1 style={{ fontSize: 26 }}>How will you attend?</h1></div>
      <div className="stack" role="radiogroup">
        {MODES.map((x) => (
          <button key={x.id} role="radio" aria-checked={mode === x.id} className={`choice ${mode === x.id ? 'on' : ''}`} style={{ minHeight: 60 }} onClick={() => setMode(x.id)}>
            <span className="stack tight" style={{ gap: 2 }}><b style={{ fontSize: 16 }}>{x.name}</b><span className="small muted">{x.sub}</span></span>
            <span className="mono small muted">[PRICE]</span>
          </button>
        ))}
      </div>
      <div className="panel accent"><span className="label accent">Included</span><div className="row" style={{ gap: 6 }}>{m.inc.map((i) => <span key={i} className="pill accent">{i}</span>)}</div></div>
      {g && <div className="panel okp"><span className="label ok">You're registered</span><span>{g.name} · {g.mode.replace('_', ' ')}{g.seat ? ` · seat ${g.seat}` : ''} · {g.checkedIn ? 'checked in' : 'not checked in yet'}</span></div>}
      {mode === 'watch_party' && <label className="fieldlabel">Watch party code
        <input className="field" value={partyId} onChange={e => setPartyId(e.target.value.toLowerCase())} maxLength={64} placeholder="Code shared by your party host" />
        <span className="small muted">Use the same code as the other people in your watch party.</span>
      </label>}
      <button className="btn xl primary" disabled={mode === 'watch_party' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(partyId)} onClick={() => send({ type: 'REGISTER', mode, ...(mode === 'watch_party' ? { partyId } : {}) })}>{g ? 'Update how I attend' : 'Register'}</button>
      <div className="row"><button className="btn" onClick={download}>Add to Calendar (.ics)</button><span className="small muted">Apple Wallet passes need your Pass Type ID — see the README.</span></div>
    </div>
  );
}

// ======================================================================= Lobby & stage (desktop)

export function Lobby() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const live = s.cues.find((c) => c.status === 'live');
  const g = myGuest(s, snap.me.email);
  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="cols">
          <div className="stack" style={{ flex: '999 1 520px', minWidth: 0 }}>
            <Monitor kind={s.production.onAir ? 'pgm' : undefined} big label={srcLabel(s, s.production.programId)} caption="4K · captions" />
            <div className="row">
              <div className="stack tight grow"><b style={{ fontSize: 17 }}>{live?.title ?? 'Starting soon'}</b><span className="small muted">{live?.detail ?? ''}</span></div>
              <HandButton />
            </div>
            <Reactions />
          </div>
          <div className="panel" style={{ flex: '1 1 300px', minWidth: 0 }}><span className="label">Q&amp;A · {s.questions.length}</span><QuestionList limit={4} /></div>
        </div>
        <div className="stack tight">
          <span className="label">All stages · switch without rejoining</span>
          <div className="grid" style={{ '--min': '220px' } as React.CSSProperties}>
            {s.subscribers.filter((x) => !['record', 'interp', 'press', 'external', 'lobby'].includes(x.id)).map((x) => (
              <div key={x.id} className="panel" style={{ padding: 10 }}>
                <div className="monitor"><span className={`tag tl pill square ${x.on ? '' : 'warn'}`} style={x.on ? { background: 'var(--pgm-fill)', color: '#fff' } : {}}>{x.on ? 'LIVE' : 'OWN SESSION'}</span></div>
                <b>{x.name}</b><span className="small muted">{x.viewers.toLocaleString()} watching</span>
              </div>
            ))}
          </div>
        </div>
        <Services />
      </div>
      <div className="side-col stack">
        <div className="panel">
          <span className="label">You</span>
          {g ? <><b>{g.name}</b><span className={`small ${g.checkedIn ? 'ok' : 'warn'}`}>{g.checkedIn ? 'Checked in' : 'Not checked in'}{g.seat ? ` · seat ${g.seat}` : ''}</span></> : <><span className="muted small">You haven't said how you're attending.</span><Link className="btn sm" to="../join">Choose how to attend</Link></>}
        </div>
        <div className="panel">
          <span className="label">Up next</span>
          <div className="list small">{s.cues.filter((c) => c.status === 'pending').map((c) => <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '70px minmax(0,1fr)', gap: 8 }}><span className="mono accent">{fmtTau(c.at)}</span><span>{c.title}</span></div>)}</div>
        </div>
        <div className="panel"><span className="label">Chat</span><ChatBox height={240} /></div>
      </div>
    </div>
  );
}

function Services() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const myValet = s.valet[0];
  return (
    <div className="panel">
      <div className="row between"><span className="label">Guest services · Apple Pay</span><span className="small muted">Charges land on one event folio</span></div>
      <div className="grid" style={{ '--min': '220px' } as React.CSSProperties}>
        <button className="tile" style={{ flexDirection: 'row', padding: 12 }} onClick={() => send({ type: 'ORDER', items: '1 oat latte', totalCents: 650, vendor: 'Riverwalk Catering' })}>
          <Icon d={ICONS.coffee} color="#4CC9F0" /><span className="stack tight" style={{ gap: 2 }}><b>Order to seat</b><span className="small muted">Oat latte · {money(650)}</span></span>
        </button>
        <button className="tile" style={{ flexDirection: 'row', padding: 12 }} disabled={!myValet || myValet.status !== 'stored'} onClick={() => myValet && send({ type: 'VALET_REQUEST', ticketId: myValet.id })}>
          <Icon d={ICONS.car} color="#4CC9F0" /><span className="stack tight" style={{ gap: 2 }}><b>Valet</b><span className="small muted">{myValet ? `${myValet.claim} · ${myValet.status}` : 'No ticket'}</span></span>
        </button>
        <div className="tile" style={{ flexDirection: 'row', padding: 12, cursor: 'default' }}><Icon d={ICONS.bed} color="#4CC9F0" /><span className="stack tight" style={{ gap: 2 }}><b>Lodging</b><span className="small muted">Event-rate partner hotel</span></span></div>
        <div className="tile" style={{ flexDirection: 'row', padding: 12, cursor: 'default' }}><Icon d={ICONS.bus} color="#4CC9F0" /><span className="stack tight" style={{ gap: 2 }}><b>Shuttle</b><span className="small muted">Gala run · 6:15</span></span></div>
      </div>
      {s.orders.length > 0 && <div className="list small">{s.orders.slice(-3).map((o) => <div key={o.id} className="row between"><span>{o.id} · {o.items}</span><span className="warn">{o.status}</span></div>)}</div>}
    </div>
  );
}

// ======================================================================= Engage (desktop)

export function Engage() {
  const { snap } = useEvent();
  const s = snap.state;
  const poll = openChoicePoll(s);
  const cloud = s.polls.find((p) => p.kind === 'wordcloud' && p.status !== 'draft');
  const rating = s.polls.find((p) => p.kind === 'rating' && p.status === 'open');
  return (
    <>
      <div className="cols">
        <div className="stack" style={{ flex: '3 1 520px', minWidth: 0 }}>
          <Monitor kind="pgm" big label={srcLabel(s, s.production.programId)} caption="Live captions · EN" />
          <div className="row"><Reactions /><div className="grow" /><HandButton /></div>
        </div>
        <div className="panel accent" style={{ flex: '2 1 360px', minWidth: 0 }}>
          <span className="label accent">Live poll</span>
          {poll ? <PollCard poll={poll} /> : <Empty>No poll open right now.</Empty>}
        </div>
      </div>
      <div className="grid" style={{ '--min': '300px' } as React.CSSProperties}>
        <div className="panel"><span className="label">Q&amp;A · vote up</span><QuestionList /></div>
        <div className="panel"><span className="label">Chat</span><ChatBox /></div>
        <div className="panel">
          {cloud ? <WordCloud poll={cloud} /> : <Empty>No word cloud yet.</Empty>}
          {rating && <div className="divider stack" style={{ paddingTop: 10 }}><span className="label">Rate this session</span><PollCard poll={rating} /></div>}
        </div>
        <div className="panel">
          <span className="label">Resources · speaker-pushed</span>
          <div className="stack tight">{s.resources.map((r) => <div key={r.id} className="well row between"><span>{r.title}</span><span className="small muted">{r.note}</span></div>)}</div>
          <span className="label">Access</span>
          <div className="row" style={{ gap: 6 }}><span className="pill ok">Live captions</span><span className="pill">Transcript</span><span className="pill">ASL window</span><span className="pill">Audio description</span><span className="pill">Low-bandwidth mode</span></div>
        </div>
      </div>
    </>
  );
}

// ======================================================================= Vote (iPhone)

export function Vote() {
  const { snap } = useEvent();
  const s = snap.state;
  const open = s.polls.filter((p) => p.status === 'open');
  const poll = openChoicePoll(s) ?? open[0];
  return (
    <div className="device">
      <div className="row between"><span className="label accent"><span className="dot" style={{ marginRight: 6 }} />Live poll</span><span className="small muted">{open.length} open</span></div>
      {poll ? (poll.kind === 'wordcloud' ? <WordCloud poll={poll} /> : <PollCard poll={poll} big />) : <div className="panel"><Empty>Nothing to vote on right now. You'll see polls here as soon as the host opens them.</Empty></div>}
      {open.filter((p) => p.id !== poll?.id).map((p) => <div key={p.id} className="panel">{p.kind === 'wordcloud' ? <WordCloud poll={p} /> : <PollCard poll={p} />}</div>)}
    </div>
  );
}

// ======================================================================= Q&A + chat (iPhone)

export function QAChat() {
  const { snap } = useEvent();
  const [tab, setTab] = useState<'qa' | 'chat' | 'people'>('qa');
  const mine = snap.state.questions.filter((q) => q.byMe);
  return (
    <div className="device">
      <div className="row between"><h2 style={{ fontSize: 22 }}>Main Stage</h2>{snap.state.production.onAir && <span className="pill live">LIVE</span>}</div>
      <div className="seg" role="tablist" style={{ alignSelf: 'stretch', justifyContent: 'stretch' }}>
        {(['qa', 'chat', 'people'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} style={{ flex: 1 }} onClick={() => setTab(t)}>{t === 'qa' ? 'Q&A' : t === 'chat' ? 'Chat' : 'People'}</button>)}
      </div>
      {tab === 'qa' && (
        <>
          {mine.length > 0 && (
            <div className="panel accent">
              <span className="label accent">Your questions</span>
              <div className="list">{mine.map((q) => <div key={q.id} className="stack tight" style={{ gap: 2 }}><span>{q.text}</span><span className={`small ${q.status === 'answered' ? 'ok' : q.status === 'dismissed' ? 'muted' : 'warn'}`}>{({ new: 'Waiting for the moderator', approved: 'Approved · in the queue', on_stage: 'On stage now', answered: 'Answered live', dismissed: 'Not selected' } as const)[q.status]}</span></div>)}</div>
            </div>
          )}
          <QuestionList />
        </>
      )}
      {tab === 'chat' && <ChatBox height={460} />}
      {tab === 'people' && (
        <div className="panel"><span className="label">Here now · {snap.presence.length}</span><div className="list">{snap.presence.map((p) => <div key={p.email} className="row between"><span>{p.name}</span><span className="small muted">{p.device}</span></div>)}</div></div>
      )}
    </div>
  );
}

// ======================================================================= My event (iPhone)

function PassCode({ seed }: { seed: string }) {
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const cells: [number, number][] = [];
  for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) {
    const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
    if (finder) continue;
    h = (h * 1103515245 + 12345) >>> 0;
    if (h & 0x10000) cells.push([x, y]);
  }
  const finderAt = (x: number, y: number) => <g key={`${x}${y}`}><rect x={x} y={y} width="7" height="7" fill="#0A0C0F" /><rect x={x + 1} y={y + 1} width="5" height="5" fill="#fff" /><rect x={x + 2} y={y + 2} width="3" height="3" fill="#0A0C0F" /></g>;
  return (
    <svg width="92" height="92" viewBox="0 0 21 21" role="img" aria-label="Pass code" style={{ background: '#fff', borderRadius: 8, padding: 6, flexShrink: 0 }}>
      {finderAt(0, 0)}{finderAt(14, 0)}{finderAt(0, 14)}
      {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#0A0C0F" />)}
    </svg>
  );
}

const ORDER_STEPS = ['accepted', 'preparing', 'ready', 'delivered'] as const;

export function GuestHome() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const g = myGuest(s, snap.me.email);
  const order = [...s.orders].reverse().find((o) => o.status !== 'settled');
  const valet = s.valet[0];
  return (
    <div className="device">
      <div className="row between"><div className="stack tight" style={{ gap: 2 }}><span className="small muted">{s.name}</span><h1 style={{ fontSize: 26 }}>Hi, {snap.me.name.split(' ')[0]}</h1></div>
        {g && <span className={`pill ${g.checkedIn ? 'ok' : 'warn'}`}>{g.checkedIn ? 'Checked in' : 'Not checked in'}</span>}</div>
      {g ? (
        <div className="panel accent row nowrap-row">
          <div className="stack tight grow"><span className="label accent">{g.mode === 'in_person' ? 'In person' : g.mode.replace('_', ' ')}</span><b style={{ fontSize: 17 }}>{g.seat ? `Seat ${g.seat}` : 'Online pass'}</b><span className="small muted">{s.venue}</span><span className="small mono muted">Pass {g.id}</span></div>
          <PassCode seed={g.id} />
        </div>
      ) : <div className="panel"><span className="muted">You're not registered yet.</span><Link className="btn primary" to="../join">Choose how to attend</Link></div>}
      <div className="panel">
        <div className="row between"><b>{order ? `${order.vendor.split(' ')[0]} · order ${order.id}` : 'Order to your seat'}</b>{order && <span className="warn small">{order.status}</span>}</div>
        {order ? (
          <>
            <span className="small muted">{order.items} · {money(order.totalCents)} on folio</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 4 }}>
              {ORDER_STEPS.map((st) => { const idx = ['created', ...ORDER_STEPS, 'settled'].indexOf(order.status); const mineIdx = ['created', ...ORDER_STEPS, 'settled'].indexOf(st); return <span key={st} style={{ height: 4, borderRadius: 2, background: mineIdx < idx ? 'var(--ok)' : mineIdx === idx ? 'var(--warn)' : '#262C34' }} />; })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 4 }} className="small muted">{ORDER_STEPS.map((st) => <span key={st}>{st}</span>)}</div>
          </>
        ) : <button className="btn" onClick={() => send({ type: 'ORDER', items: '1 oat latte', totalCents: 650, vendor: 'Riverwalk Catering' })}>Order an oat latte · {money(650)}</button>}
      </div>
      {valet && (
        <div className="panel row nowrap-row">
          <div className="stack tight grow" style={{ gap: 2 }}><b>Valet · claim {valet.claim}</b><span className="small muted">{valet.vehicle} · {valet.status}</span></div>
          <button className="btn primary" disabled={valet.status !== 'stored'} onClick={() => send({ type: 'VALET_REQUEST', ticketId: valet.id })}>{valet.status === 'requested' ? 'On its way' : valet.status === 'released' ? 'Picked up' : 'Request car'}</button>
        </div>
      )}
      <div className="panel">
        <div className="row">{s.production.onAir && <span className="pill live">LIVE</span>}<b>{s.cues.find((c) => c.status === 'live')?.title ?? 'Main Stage'}</b></div>
        <span className="small muted">In the room? Captions, Q&amp;A and voting are on your phone.</span>
        <div className="row"><Link className="btn sm" to="../vote">Vote</Link><Link className="btn sm" to="../qa">Q&amp;A</Link><Link className="btn sm" to="../networking">Networking</Link></div>
      </div>
    </div>
  );
}

// ======================================================================= Networking (desktop)

export function Networking() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const myTable = s.tables.find((t) => t.seats.includes(snap.me.email));
  const nameFor = (email: string) => (email === snap.me.email ? 'You' : snap.presence.find((p) => p.email === email)?.name ?? (email.startsWith('seed:') ? email.slice(5).replace(/^./, (c) => c.toUpperCase()) : email.split('@')[0]));
  return (
    <div className="cols">
      <div className="main-col stack loose">
        {myTable ? (
          <div className="panel accent">
            <div className="row between"><b style={{ fontSize: 16 }}>{myTable.name}</b><span className="small accent">{myTable.seats.length} of {myTable.capacity} seats · spatial audio</span></div>
            <div className="grid" style={{ '--min': '160px' } as React.CSSProperties}>
              {Array.from({ length: myTable.capacity }, (_, i) => myTable.seats[i]).map((e, i) => (
                <div key={i} className="monitor" style={{ aspectRatio: '4 / 3', borderColor: e === snap.me.email ? 'var(--accent)' : undefined, borderWidth: 2 }}>{e && <Person size={44} />}<span className="tag bl">{e ? nameFor(e) : 'Open seat'}</span></div>
              ))}
            </div>
            <div className="row"><button className="btn">Mute</button><button className="btn">Camera</button><button className="btn">Swap contact cards</button><div className="grow" /><button className="btn danger" onClick={() => send({ type: 'LEAVE_TABLE' })}>Leave table</button></div>
          </div>
        ) : <div className="panel"><b>Pick a table to join the conversation</b><span className="small muted">Tables mix people in the room and online. Your seat is saved for everyone.</span></div>}
        <div className="stack tight">
          <span className="label">Lounge · join any open seat</span>
          <div className="grid" style={{ '--min': '220px' } as React.CSSProperties}>
            {s.tables.map((t) => {
              const full = t.seats.length >= t.capacity;
              const here = t.id === myTable?.id;
              return (
                <button key={t.id} className={`tile ${here ? 'pvw' : ''}`} style={{ padding: 12 }} disabled={full && !here} onClick={() => !here && send({ type: 'JOIN_TABLE', tableId: t.id })}>
                  <b>{t.name}</b>
                  <span className="row" style={{ gap: 4 }}>{Array.from({ length: t.capacity }, (_, i) => <span key={i} style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid #39424E', background: i < t.seats.length ? 'var(--accent)' : 'transparent' }} />)}</span>
                  <span className="small muted">{here ? 'You are here' : full ? 'Full' : `${t.capacity - t.seats.length} open · ${t.note}`}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="side-col stack">
        <div className="panel"><span className="label">Speed networking · 3-min rounds</span><span className="muted">Matched on your interests. Next round starts at the break.</span><button className="btn primary" onClick={() => { const open = s.tables.find((t) => t.seats.length < t.capacity && t.id !== myTable?.id); if (open) send({ type: 'JOIN_TABLE', tableId: open.id }); }}>Match me to a table now</button></div>
        <div className="panel"><span className="label">Breakouts</span><div className="list small">{s.subscribers.filter((x) => ['workshop', 'sponsor'].includes(x.id)).map((x) => <div key={x.id} className="row between"><span>{x.name}</span><span className={x.on ? 'ok' : 'warn'}>{x.on ? 'On main program' : 'Own session'}</span></div>)}</div></div>
        <div className="panel"><span className="label">People here now</span><div className="list small">{snap.presence.slice(0, 12).map((p) => <div key={p.email} className="row between"><span>{p.name}</span><span className="muted">{p.device}</span></div>)}</div></div>
      </div>
    </div>
  );
}

// ======================================================================= Watch party (iPhone)

export function WatchParty() {
  const { snap, send } = useEvent();
  useTick(1000);
  const s = snap.state;
  const poll = openChoicePoll(s);
  const party = s.guests.filter((g) => g.mode === 'watch_party').length;
  const myHand = s.hands.find((h) => h.who === snap.me.email && h.status !== 'lowered');
  return (
    <div className="device">
      <div className="stack tight" style={{ gap: 2 }}><span className="small muted">Watch party host</span><h2 style={{ fontSize: 22 }}>Your room</h2></div>
      <div className="panel row nowrap-row"><Icon d={ICONS.screen} color="#4CC9F0" /><div className="stack tight grow" style={{ gap: 2 }}><b>Playing on the room screen</b><span className="small muted">{srcLabel(s, s.production.programId)} · captions on screen</span></div>{s.production.onAir && <span className="pill live">LIVE</span>}</div>
      <div className="panel">
        <div className="row between"><b>{party} watch-party guests registered</b><span className="small muted">QR on the big screen</span></div>
        <span className="small muted">Each person votes and asks from their own phone; results count for the party and for them.</span>
        {poll && <><div className="row between small"><span>{poll.question}</span><span className="mono">{poll.total} votes</span></div><div className="bar"><span style={{ width: `${Math.min(100, poll.total ? 60 : 0)}%` }} /></div></>}
      </div>
      <div className={`panel ${myHand?.status === 'invited' ? 'warnp' : ''}`}>
        <b>{myHand?.status === 'invited' ? 'The moderator invited your room to ask a question' : 'Want your room to ask a question on stage?'}</b>
        <span className="small muted">{myHand ? `Request ${myHand.status}` : 'Raise a hand for the whole room.'}</span>
        {myHand ? (myHand.status === 'invited' ? <Link className="btn lg warn-fill" to="../green-room">Choose speaker & join green room</Link> : <button className="btn" onClick={() => send({ type: 'LOWER_HAND' })}>Cancel request</button>)
          : <button className="btn lg accent" onClick={() => send({ type: 'RAISE_HAND' })}>Raise the room's hand</button>}
      </div>
      <div className="row nowrap-row"><Link className="btn lg" style={{ flex: 1 }} to="../qa">Party chat</Link><Link className="btn lg" style={{ flex: 1 }} to="../lobby">Switch stage</Link></div>
    </div>
  );
}
