import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, toast, useEvent, useTick } from '../store';
import { clockTime, Empty, fmtCountdown, Icon, ICONS, money, ROLE_LABEL } from '../lib';
import { Monitor } from './production';
import { ALL_ROLES, LIFECYCLE, type AttendeeType, type EventView, type QuestionView, type Role, type Workstream } from '../../shared/types';

const srcLabel = (s: EventView, id: string) => s.sources.find((x) => x.id === id)?.label ?? id;

function words(t: string) { return new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 3)); }
/** Rough duplicate detection so a small team doesn't triage the same question twice. */
function similarTo(q: QuestionView, all: QuestionView[]): QuestionView | undefined {
  const a = words(q.text);
  return all.find((o) => {
    if (o.id === q.id || o.ts > q.ts) return false;
    const b = words(o.text);
    const inter = [...a].filter((w) => b.has(w)).length;
    return inter >= 3 && inter / Math.min(a.size, b.size) > 0.5;
  });
}

// ======================================================================= Moderator console

export function Moderator() {
  const { snap, send, store } = useEvent();
  const s = snap.state;
  const [tab, setTab] = useState<'new' | 'approved' | 'answered'>('new');
  const [pin, setPin] = useState('');
  const qs = s.questions.filter((q) => (tab === 'answered' ? q.status === 'answered' || q.status === 'on_stage' : q.status === tab)).sort((a, b) => b.votes - a.votes);
  const held = s.chat.filter((m) => m.held);
  const raised = s.hands.filter((h) => h.status !== 'lowered');
  const reactions = Object.values(s.reactions).reduce((a, b) => a + b, 0);

  const announce = async () => {
    if (!pin.trim()) return;
    const text = pin;
    if (!(await send({ type: 'CHAT', channel: 'everyone', text }))) return;
    setPin('');
    setTimeout(() => {
      const m = [...(store.snap?.state.chat ?? [])].reverse().find((x) => x.text === text && x.authorName === snap.me.name);
      if (m) send({ type: 'CHAT_MODERATE', messageId: m.id, action: 'pin' });
    }, 300);
  };

  return (
    <>
      <div className="row between">
        <h1>Moderator console</h1>
        <div className="row small muted"><span><b className="mono" style={{ color: 'var(--text)' }}>{snap.presence.length}</b> connected</span><span><b className="mono" style={{ color: 'var(--text)' }}>{reactions.toLocaleString()}</b> reactions</span><span><b className="mono" style={{ color: 'var(--text)' }}>{s.questions.length}</b> questions</span></div>
      </div>
      <div className="cols">
        <div className="panel" style={{ flex: '3 1 460px', minWidth: 0 }}>
          <div className="row between">
            <span className="label">Question queue</span>
            <div className="seg">{(['new', 'approved', 'answered'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'new' ? `Incoming · ${s.questions.filter((q) => q.status === 'new').length}` : t === 'approved' ? `Approved · ${s.questions.filter((q) => q.status === 'approved').length}` : 'Answered'}</button>)}</div>
          </div>
          {qs.map((q) => {
            const dup = similarTo(q, s.questions);
            return (
              <div key={q.id} className="well stack tight" style={{ borderColor: q.status === 'on_stage' ? 'var(--pgm)' : undefined }}>
                <div className="row between top nowrap-row"><span style={{ lineHeight: 1.4 }}>{q.text}</span><span className="mono small muted nowrap">▲ {q.votes}</span></div>
                <span className={`small ${dup ? 'accent' : 'muted'}`}>{dup ? `Looks like a duplicate of “${dup.text.slice(0, 50)}…”` : `${q.authorName} · ${q.where} · ${clockTime(q.ts)}`}{q.status === 'on_stage' ? ' · ON STAGE' : ''}</span>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm take" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: q.id, status: 'on_stage' })}>Send to stage</button>
                  {q.status === 'new' && <button className="btn sm" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: q.id, status: 'approved' })}>Approve</button>}
                  <button className="btn sm" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: q.id, status: 'answered' })}>Mark answered</button>
                  <button className="btn sm ghost" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: q.id, status: dup ? 'answered' : 'dismissed' })}>{dup ? 'Merge' : 'Dismiss'}</button>
                </div>
              </div>
            );
          })}
          {!qs.length && <Empty>Nothing here.</Empty>}
          <span className="small muted">“Send to stage” shows the question on the host's iPad and queues a lower-third for the director.</span>
        </div>
        <div className="stack" style={{ flex: '2 1 360px', minWidth: 0 }}>
          <div className="panel">
            <span className="label">Raised hands · requests to speak</span>
            <div className="list">
              {raised.map((h) => (
                <div key={h.id} className="row nowrap-row">
                  <div className="stack tight grow" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{h.name}</b><span className={`small ${h.status === 'raised' ? (h.preflightOk ? 'ok' : 'warn') : 'accent'}`}>{h.status === 'raised' ? (h.preflightOk ? 'Preflight passed' : 'In the room · mic runner') : h.status.replace('_', ' ')}</span></div>
                  {h.status === 'raised' && <button className="btn sm accent" onClick={() => send({ type: 'SET_HAND_STATUS', handId: h.id, status: 'invited' })}>Invite</button>}
                  {h.status === 'invited' && <button className="btn sm accent" onClick={() => send({ type: 'SET_HAND_STATUS', handId: h.id, status: 'on_stage' })}>On stage</button>}
                  <button className="btn sm ghost" onClick={() => send({ type: 'SET_HAND_STATUS', handId: h.id, status: 'lowered' })}>Lower</button>
                </div>
              ))}
              {!raised.length && <Empty>No hands up.</Empty>}
            </div>
          </div>
          <PollManager />
          <div className="panel">
            <div className="row between"><span className="label">Chat · {held.length} held</span><span className="small muted">Links are held automatically</span></div>
            {held.map((m) => (
              <div key={m.id} className="panel warnp" style={{ padding: 10 }}>
                <span className="small">{m.authorName}: {m.text}</span>
                <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => send({ type: 'CHAT_MODERATE', messageId: m.id, action: 'allow' })}>Allow</button><button className="btn sm danger" onClick={() => send({ type: 'CHAT_MODERATE', messageId: m.id, action: 'remove' })}>Remove</button></div>
              </div>
            ))}
            <form className="row nowrap-row" onSubmit={(e) => { e.preventDefault(); announce(); }}>
              <input className="field" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Pin an announcement" aria-label="Announcement" /><button className="btn" type="submit">Pin</button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}

function PollManager() {
  const { snap, send } = useEvent();
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState('');
  const [kind, setKind] = useState<'choice' | 'rating' | 'wordcloud'>('choice');
  const create = async () => {
    const ok = await send({ type: 'POLL_CREATE', question: q, options: opts.split(',').map((x) => x.trim()).filter(Boolean), kind });
    if (ok) { setQ(''); setOpts(''); }
  };
  return (
    <div className="panel">
      <span className="label">Polls &amp; activities</span>
      <div className="list">
        {snap.state.polls.map((p) => (
          <div key={p.id} className="stack tight">
            <div className="row between nowrap-row"><b style={{ fontSize: 13 }}>{p.question}</b><span className={`small ${p.status === 'open' ? 'accent' : 'muted'}`}>{p.status.toUpperCase()} · {p.total}</span></div>
            <div className="row" style={{ gap: 6 }}>
              {p.status !== 'open' && <button className="btn sm" onClick={() => send({ type: 'POLL_OPEN', pollId: p.id })}>{p.status === 'closed' ? 'Reopen' : 'Launch'}</button>}
              {p.status === 'open' && <button className="btn sm" onClick={() => send({ type: 'POLL_CLOSE', pollId: p.id })}>Close</button>}
              {p.kind !== 'wordcloud' && <button className={`btn sm ${p.onProgram ? 'take' : 'danger'}`} onClick={() => send({ type: 'POLL_TO_PROGRAM', pollId: p.id, on: !p.onProgram })}>{p.onProgram ? 'On program · clear' : 'Results to program'}</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="divider stack tight" style={{ paddingTop: 10 }}>
        <span className="label">New activity</span>
        <div className="seg">{(['choice', 'rating', 'wordcloud'] as const).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'choice' ? 'Poll' : k === 'rating' ? 'Rating' : 'Word cloud'}</button>)}</div>
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Question" aria-label="Question" />
        {kind === 'choice' && <input className="field" value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="Options, separated by commas" aria-label="Options" />}
        <button className="btn" onClick={create} disabled={!q.trim()}>Create as draft</button>
      </div>
    </div>
  );
}

// ======================================================================= Host (iPad)

export function HostView() {
  const { snap, send, store } = useEvent();
  useTick(500);
  const s = snap.state;
  const live = s.cues.find((c) => c.status === 'live');
  const remaining = live ? live.at + live.durationMs - (store.now() - s.epoch) : 0;
  const ranked = s.questions.filter((q) => q.status === 'approved' || q.status === 'new').sort((a, b) => (a.status === b.status ? b.votes - a.votes : a.status === 'approved' ? -1 : 1));
  const onStage = s.questions.find((q) => q.status === 'on_stage');
  const next = ranked[0];
  const merged = s.questions.filter((q) => q.status === 'answered').length;
  const [talking, setTalking] = useState(false);
  const talk = (on: boolean) => { setTalking(on); send({ type: 'BRIDGE_MIC', on }); };

  return (
    <div className="device tablet">
      <div className="row">
        <span className={`pill ${s.production.onAir ? 'live' : ''}`}>{s.production.onAir ? "YOU'RE ON AIR" : 'OFF AIR'}</span>
        <b style={{ fontSize: 16 }}>{s.name} · host &amp; moderator</b>
        <div className="grow" />
        <span className="small muted">Segment ends in</span>
        <span className="mono warn" style={{ fontSize: 24, fontWeight: 600 }}>{live ? fmtCountdown(remaining) : '—'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <div className="stack">
          <Monitor kind="pgm" label={srcLabel(s, s.production.programId)} />
          <div className="panel"><span className="label">Now</span><b>{live?.title ?? 'Between segments'}</b><span className="muted">{live?.detail}</span><span className="small muted">Next: {s.cues.find((c) => c.status === 'pending')?.title ?? '—'}</span></div>
          {s.bridgeLog[0] && <div className="panel" style={{ background: 'var(--panel-2)' }}><span className="small muted">{s.bridgeLog[0].who} · in your ear</span><span style={{ fontSize: 15 }}>{s.bridgeLog[0].text}</span></div>}
        </div>
        <div className="stack">
          <div className="row between"><span className="label">Questions · ranked for you</span><span className="small muted">{s.questions.length} in · {merged} answered</span></div>
          {onStage && <div className="panel pgmp"><span className="label pgm">On screen now</span><span style={{ fontSize: 18, fontWeight: 600 }}>{onStage.text}</span><button className="btn sm" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: onStage.id, status: 'answered' })}>Done · answered</button></div>}
          {next ? (
            <div className="panel warnp">
              <span className="label warn">Read next</span>
              <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.35 }}>{next.text}</span>
              <span className="small" style={{ color: '#E2D3AE' }}>▲ {next.votes} · {next.authorName}</span>
              <div className="row"><button className="btn lg warn-fill" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: next.id, status: 'on_stage' })}>I'm reading it · show on screen</button><button className="btn lg warn" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: next.id, status: 'dismissed' })}>Skip</button></div>
            </div>
          ) : <Empty>No questions waiting.</Empty>}
          {ranked.slice(1, 5).map((q) => (
            <div key={q.id} className="panel row nowrap-row" style={{ padding: 12 }}>
              <span className="mono small muted" style={{ minWidth: 40 }}>▲ {q.votes}</span><span className="grow" style={{ fontSize: 15 }}>{q.text}</span>
              {q.status === 'new' && <button className="btn sm" aria-label="Approve" onClick={() => send({ type: 'SET_QUESTION_STATUS', questionId: q.id, status: 'approved' })}><Icon d={ICONS.up} size={16} /></button>}
            </div>
          ))}
        </div>
        <div className="stack">
          <div className="panel">
            <span className="label">Launch in one tap</span>
            {s.polls.filter((p) => p.status !== 'closed').map((p) => (
              <button key={p.id} className={`btn lg ${p.status === 'open' ? 'accent' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => send({ type: p.status === 'open' ? 'POLL_CLOSE' : 'POLL_OPEN', pollId: p.id })}>
                {p.status === 'open' ? 'Close · ' : ''}{p.kind === 'wordcloud' ? 'Word cloud' : p.kind === 'rating' ? 'Rating' : 'Poll'} · {p.question.slice(0, 34)}
              </button>
            ))}
          </div>
          <div className="panel">
            <span className="label">Raised hands · {s.hands.filter((h) => h.status === 'raised').length}</span>
            {s.hands.filter((h) => h.status === 'raised').map((h) => <div key={h.id} className="row between"><span>{h.name}</span><button className="btn sm accent" onClick={() => send({ type: 'SET_HAND_STATUS', handId: h.id, status: 'invited' })}>Bring on</button></div>)}
          </div>
          <div className="panel row between"><span>Chat · {s.chat.filter((m) => m.held).length} held</span><Link className="btn sm" to="../moderator">Review</Link></div>
        </div>
      </div>
      <div className="row nowrap-row">
        <button className={`btn xl ${talking ? 'warn-fill' : 'accent'}`} style={{ flex: 1 }} onPointerDown={() => talk(true)} onPointerUp={() => talk(false)} onPointerLeave={() => talking && talk(false)}>Hold to talk · producer</button>
        <button className="btn xl" style={{ flex: 1 }} onClick={() => send({ type: 'BRIDGE_LOG', text: 'Host: I need more time' })}>I need more time</button>
        <button className="btn xl" style={{ flex: 1 }} onClick={() => send({ type: 'BRIDGE_LOG', text: 'Host: wrap me up' })}>Wrap me up</button>
      </div>
    </div>
  );
}

// ======================================================================= Organizer

const WS_LABEL: Record<Workstream['status'], [string, string]> = { on_track: ['On track', 'ok'], live: ['Live', 'accent'], watch: ['Watch', 'warn'], blocked: ['Blocked', 'pgm'] };

export function Organizer() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const cur = LIFECYCLE.indexOf(s.lifecycle);
  const [inc, setInc] = useState({ title: '', detail: '' });
  const [budget, setBudget] = useState({ a: s.budget.authorizedCents / 100, c: s.budget.committedCents / 100, st: s.budget.settledCents / 100, l: s.budget.stepUpLimitCents / 100 });
  const [editName, setEditName] = useState(false);
  const [name, setName] = useState(s.name);
  const [venue, setVenue] = useState(s.venue);
  const revenue = s.orders.reduce((a, o) => a + o.totalCents, 0);
  const b = s.budget;
  const pct = (x: number) => (b.authorizedCents ? Math.min(100, Math.round((x / b.authorizedCents) * 100)) : 0);
  const checkedIn = s.guests.filter((g) => g.checkedIn).length;

  return (
    <>
      <div className="row between">
        {editName ? (
          <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await send({ type: 'RENAME_EVENT', name, venue })) setEditName(false); }}>
            <input className="field" style={{ width: 280 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Event name" />
            <input className="field" style={{ width: 220 }} value={venue} onChange={(e) => setVenue(e.target.value)} aria-label="Venue" />
            <button className="btn primary" type="submit">Save</button>
          </form>
        ) : <div className="stack tight"><h1>{s.name}</h1><span className="muted">{s.kind === 'social' ? 'Social' : 'Corporate'} event · {s.venue} · {s.guests.length} guests · {checkedIn} checked in</span></div>}
        <div className="row"><button className="btn" onClick={() => setEditName(!editName)}>{editName ? 'Cancel' : 'Edit details'}</button><Link className="btn" to="../clock">Audit trail</Link></div>
      </div>

      <div className="panel">
        <span className="label">Event state · every transition signed &amp; journaled</span>
        <div className="row" style={{ gap: 6 }}>
          {LIFECYCLE.map((l, i) => <span key={l} className="pill" style={i < cur ? { borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' } : i === cur ? { background: 'var(--pgm-fill)', borderColor: 'var(--pgm-fill)', color: '#fff', fontWeight: 600 } : { color: 'var(--dim)' }}>{l}{i === cur ? ' · now' : ''}</span>)}
        </div>
        <div className="row"><button className="btn" onClick={() => send({ type: 'ADVANCE_LIFECYCLE' })} disabled={cur >= LIFECYCLE.length - 1}>Advance to {LIFECYCLE[cur + 1] ?? '—'}</button>
          <button className="btn ghost" onClick={() => send({ type: 'SET_LIFECYCLE', lifecycle: 'Active' })} disabled={s.lifecycle === 'Active'}>Back to Active</button></div>
      </div>

      <div className="grid" style={{ '--min': '160px' } as React.CSSProperties}>
        {[['Checked in', `${checkedIn} / ${s.guests.length}`], ['Connected now', String(snap.presence.length)], ['Orders', `${s.orders.length} · ${money(revenue)}`], ['Questions', String(s.questions.length)], ['Poll votes', String(s.polls.reduce((a, p) => a + p.total, 0))], ['Open incidents', String(s.incidents.filter((i) => i.open).length)]].map(([k, v]) => (
          <div key={k} className="panel" style={{ gap: 4 }}><span className="label">{k}</span><span className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{v}</span></div>
        ))}
      </div>

      <div className="cols">
        <div className="panel" style={{ flex: '1 1 420px', minWidth: 0 }}>
          <span className="label">Decision gates</span>
          <div className="list">
            {s.gates.map((g, i) => (
              <div key={g.id} style={{ display: 'grid', gridTemplateColumns: '34px minmax(0,1fr) auto', gap: 10, alignItems: 'center' }}>
                <span className={`mono ${g.signedBy ? 'ok' : 'muted'}`} style={{ fontWeight: 600 }}>{g.id}</span>
                <span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{g.question}</b><span className="small muted">{g.evidence}{g.signedBy ? ` · ${g.signedBy} · ${new Date(g.signedAt!).toLocaleDateString()}` : ''}</span></span>
                {g.signedBy ? <span className="small ok">Passed</span> : <button className="btn sm" disabled={i > 0 && !s.gates[i - 1].signedBy} onClick={() => send({ type: 'SIGN_GATE', gateId: g.id })}>Sign</button>}
              </div>
            ))}
          </div>
        </div>
        <div className="stack" style={{ flex: '2 1 560px', minWidth: 0 }}>
          <span className="label">Workstreams</span>
          <div className="grid" style={{ '--min': '220px' } as React.CSSProperties}>
            {s.workstreams.map((w) => (
              <div key={w.id} className="panel" style={{ gap: 6 }}>
                <div className="row between"><b>{w.name}</b><span className={`small ${WS_LABEL[w.status][1]}`} style={{ fontWeight: 600 }}>{WS_LABEL[w.status][0]}</span></div>
                <span className="small muted">{w.detail}</span>
                <div className="row between"><span className="small">Owner · {w.owner}</span>
                  <select className="field" style={{ width: 'auto', minHeight: 32, padding: '2px 8px' }} value={w.status} aria-label={`${w.name} status`} onChange={(e) => send({ type: 'SET_WORKSTREAM', workstreamId: w.id, status: e.target.value as Workstream['status'] })}>
                    {Object.entries(WS_LABEL).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
                  </select></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="cols">
        <div className="panel" style={{ flex: '1 1 360px', minWidth: 0 }}>
          <span className="label">Budget</span>
          {b.authorizedCents ? (
            <>
              <div className="bar" style={{ height: 14, display: 'flex' }}><span style={{ width: `${pct(b.settledCents)}%` }} /><span style={{ width: `${pct(b.committedCents)}%`, background: '#2B6F8F' }} /></div>
              <span className="small muted">Authorized {money(b.authorizedCents)} · settled {money(b.settledCents)} · committed {money(b.committedCents)} · headroom {money(Math.max(0, b.authorizedCents - b.settledCents - b.committedCents))}</span>
              <span className="small muted">Spend above {money(b.stepUpLimitCents)} per commitment needs step-up approval.</span>
            </>
          ) : <span className="small muted">No budget set yet.</span>}
          <div className="grid" style={{ '--min': '120px' } as React.CSSProperties}>
            {([['a', 'Authorized'], ['c', 'Committed'], ['st', 'Settled'], ['l', 'Step-up limit']] as const).map(([k, l]) => (
              <label key={k} className="fieldlabel">{l} ($)<input className="field" type="number" min={0} value={budget[k]} onChange={(e) => setBudget({ ...budget, [k]: Number(e.target.value) })} /></label>
            ))}
          </div>
          <button className="btn" onClick={() => send({ type: 'SET_BUDGET', authorizedCents: budget.a * 100, committedCents: budget.c * 100, settledCents: budget.st * 100, stepUpLimitCents: budget.l * 100 })}>Save budget</button>
        </div>
        <div className="panel" style={{ flex: '1 1 320px', minWidth: 0 }}>
          <span className="label">Vendors &amp; settlement</span>
          <div className="list">{s.vendors.map((v) => <div key={v.id} className="row between"><span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{v.name}</b><span className="small muted">{v.meta}</span></span><span className="small">{v.status}</span></div>)}</div>
        </div>
        <div className="panel" style={{ flex: '1 1 360px', minWidth: 0 }}>
          <div className="row between"><span className="label">Incident log</span><span className="small muted">{s.incidents.filter((i) => i.open).length} open</span></div>
          <div className="list">
            {s.incidents.map((i) => (
              <div key={i.id} className="row between nowrap-row">
                <span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }} className={i.open ? 'warn' : ''}>{i.open ? 'Open' : 'Resolved'} · {i.title}</b><span className="small muted">{clockTime(i.ts)} · {i.detail} · {i.owner}</span></span>
                {i.open && <button className="btn sm" onClick={() => send({ type: 'RESOLVE_INCIDENT', incidentId: i.id })}>Resolve</button>}
              </div>
            ))}
          </div>
          <form className="stack tight" onSubmit={async (e) => { e.preventDefault(); if (await send({ type: 'ADD_INCIDENT', title: inc.title, detail: inc.detail, owner: '' })) setInc({ title: '', detail: '' }); }}>
            <input className="field" value={inc.title} onChange={(e) => setInc({ ...inc, title: e.target.value })} placeholder="New incident" aria-label="Incident title" />
            <input className="field" value={inc.detail} onChange={(e) => setInc({ ...inc, detail: e.target.value })} placeholder="What happened / what was done" aria-label="Incident detail" />
            <button className="btn" type="submit" disabled={!inc.title.trim()}>Log incident</button>
          </form>
        </div>
      </div>
    </>
  );
}

// ======================================================================= Team & setup

const BUNDLES: Record<2 | 4 | 6 | 8, { role: string; covers: string; screen: string; roles: Role[] }[]> = {
  2: [
    { role: 'Producer', covers: 'Organizer, director, stage manager, tech', screen: 'Simple control room', roles: ['producer', 'audio', 'stage_manager', 'foh'] },
    { role: 'Host', covers: 'On-air host, Q&A, polls, chat', screen: 'Host iPad', roles: ['moderator'] },
  ],
  4: [
    { role: 'Producer-director', covers: 'Director, talent cues', screen: 'Simple control room', roles: ['producer', 'stage_manager'] },
    { role: 'Tech', covers: 'Audio, cameras, stream bus, failover', screen: 'Event clock + bus', roles: ['audio'] },
    { role: 'Host-moderator', covers: 'On-air host, Q&A triage, polls', screen: 'Host iPad', roles: ['moderator'] },
    { role: 'Ops', covers: 'Check-in, guest services, vendors', screen: 'Check-in', roles: ['foh'] },
  ],
  6: [
    { role: 'Producer-director', covers: 'Director', screen: 'Simple control room', roles: ['producer'] },
    { role: 'Tech', covers: 'Audio, cameras, stream bus', screen: 'Event clock + bus', roles: ['audio'] },
    { role: 'Host-moderator', covers: 'On-air host, Q&A, polls', screen: 'Host iPad', roles: ['moderator'] },
    { role: 'Stage manager', covers: 'Talent, green rooms, standby', screen: 'Stage manager', roles: ['stage_manager'] },
    { role: 'Ops', covers: 'Check-in, guest services', screen: 'Check-in', roles: ['foh'] },
    { role: 'Community', covers: 'Chat, networking, socials', screen: 'Moderator console', roles: ['moderator'] },
  ],
  8: [
    { role: 'Director', covers: 'Program, cues, graphics', screen: 'Control room', roles: ['producer'] },
    { role: 'Tech', covers: 'Audio, stream bus, failover', screen: 'Event clock + bus', roles: ['audio'] },
    { role: 'Host-moderator', covers: 'On-air host, Q&A, polls', screen: 'Host iPad', roles: ['moderator'] },
    { role: 'Stage manager', covers: 'Talent, green rooms', screen: 'Stage manager', roles: ['stage_manager'] },
    { role: 'Camera & field', covers: 'Roaming iPhone camera', screen: 'Camera operator', roles: ['stage_manager'] },
    { role: 'Ops', covers: 'Check-in, guest services', screen: 'Check-in', roles: ['foh'] },
    { role: 'Hospitality', covers: 'Orders and valet', screen: 'Orders & valet', roles: ['vendor'] },
    { role: 'Community', covers: 'Chat, networking', screen: 'Moderator console', roles: ['moderator'] },
  ],
};

interface Member { email: string; name: string; roles: Role[]; addedAt: number }

export function Team() {
  const { snap, send, has } = useEvent();
  const s = snap.state;
  const size = s.team.size;
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState<{ email: string; name: string; roles: Role[] }>({ email: '', name: '', roles: [] });
  const load = () => api<Member[]>(`/api/events/${s.id}/members`).then(setMembers).catch(() => undefined);
  useEffect(() => { load(); }, [s.id]);

  const save = async () => {
    try {
      await api(`/api/events/${s.id}/members`, { method: 'PUT', json: form });
      toast(`${form.email} can now work as ${form.roles.map((r) => ROLE_LABEL[r]).join(', ')}`, 'info');
      setForm({ email: '', name: '', roles: [] });
      load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save'); }
  };
  const remove = async (email: string) => {
    try { await api(`/api/events/${s.id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' }); load(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not remove'); }
  };
  const toggleRole = (r: Role) => setForm({ ...form, roles: form.roles.includes(r) ? form.roles.filter((x) => x !== r) : [...form.roles, r] });

  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="stack tight"><h1>How many people are running this show?</h1><span className="muted">Roles are bundled so each person has one job and one screen. Everything else runs automatically.</span></div>
        <div className="row" role="radiogroup" aria-label="Team size">
          {([2, 4, 6, 8] as const).map((n) => (
            <button key={n} role="radio" aria-checked={size === n} className={`choice ${size === n ? 'on' : ''}`} style={{ minWidth: 130, flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', padding: '8px 16px', minHeight: 64 }} onClick={() => send({ type: 'SET_TEAM_SIZE', size: n })} disabled={!has()}>
              <b style={{ fontSize: 20 }}>{n} people</b><span className="small muted">{({ 2: 'Duo', 4: 'Small crew', 6: 'Two pizzas', 8: 'Full small team' } as const)[n]}</span>
            </button>
          ))}
        </div>
        <div className="stack tight">
          <span className="label">Role bundles · click one to fill the form</span>
          <div className="grid" style={{ '--min': '240px' } as React.CSSProperties}>
            {BUNDLES[size].map((bd, i) => (
              <button key={bd.role} className="tile" style={{ padding: 14 }} onClick={() => setForm({ ...form, roles: bd.roles })}>
                <span className="row nowrap-row"><span className="avatar">{i + 1}</span><span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 15 }}>{bd.role}</b><span className="small muted">{bd.roles.map((r) => ROLE_LABEL[r]).join(' + ')}</span></span></span>
                <span className="small" style={{ color: 'var(--text-2)' }}>{bd.covers}</span>
                <span className="small accent">Screen: {bd.screen}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <span className="label">Team for this event</span>
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Person</th><th>Roles</th><th>Online</th><th /></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.email}>
                    <td><b>{m.name || m.email.split('@')[0]}</b><div className="small muted">{m.email}</div></td>
                    <td><div className="row" style={{ gap: 4 }}>{m.roles.map((r) => <span key={r} className="pill accent">{ROLE_LABEL[r]}</span>)}</div></td>
                    <td>{snap.presence.some((p) => p.email === m.email) ? <span className="ok small">● here</span> : <span className="muted small">—</span>}</td>
                    <td style={{ textAlign: 'right' }}>{has() && m.email !== snap.me.email && <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}><button className="btn sm ghost" onClick={() => setForm({ email: m.email, name: m.name, roles: m.roles })}>Edit</button><button className="btn sm danger" onClick={() => remove(m.email)}>Remove</button></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {has() && (
          <div className="panel">
            <span className="label">Add or change a team member</span>
            <div className="row"><input className="field" style={{ flex: '1 1 220px' }} placeholder="email (as they sign in through Access)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /><input className="field" style={{ flex: '1 1 180px' }} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="row" style={{ gap: 6 }}>{ALL_ROLES.map((r) => <button key={r} type="button" className={`btn sm ${form.roles.includes(r) ? 'on' : 'ghost'}`} aria-pressed={form.roles.includes(r)} onClick={() => toggleRole(r)}>{ROLE_LABEL[r]}</button>)}</div>
            <div className="row"><button className="btn primary" onClick={save} disabled={!form.email.includes('@') || !form.roles.length}>Save</button><span className="small muted">Changes reach their open screens immediately. Production roles also need WARP.</span></div>
          </div>
        )}
      </div>
      <div className="side-col stack">
        <div className="panel okp">
          <span className="label ok">Runs automatically</span>
          {[['Auto-director', 'Each cue brings up its shot · one-tap override'], ['Cues from the run of show', 'Auto cues fire on the event clock, even with nobody connected'], ['Self-serve talent', 'Invite → preflight → green room → ready'], ['Assisted Q&A and chat', 'Duplicates flagged, links held'], ['Self check-in', 'Wallet pass at a kiosk'], ['Audit journal', 'Every action, with sequence and τ']].map(([a, b]) => (
            <div key={a} className="row nowrap-row top"><span className="ok"><Icon d={ICONS.check} size={16} stroke={2.6} /></span><span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{a}</b><span className="small muted">{b}</span></span></div>
          ))}
        </div>
        <div className="panel"><span className="label">Starter kit · no switcher needed</span><span className="small" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>2–3 iPhones as cameras · producer's Mac · host iPad · a USB mic per presenter · venue internet plus a phone hotspot as backup</span></div>
        <div className="panel"><span className="label">In Pro, when you grow</span><div className="row" style={{ gap: 6 }}>{['Avid / EUCON', 'DMX lighting', 'PTP / word clock', 'Multiple control rooms', 'Dual approval', 'Vendor payouts'].map((x) => <span key={x} className="pill">{x}</span>)}</div></div>
      </div>
    </div>
  );
}

// ======================================================================= Attendee types

const CAPS = ['Watch', 'Chat', 'Q&A', 'Vote', 'React', 'On stage', 'Breakouts', '1:1s', 'Booths', 'Order', 'Replay'];
const TYPES: { id: AttendeeType; name: string; where: string; cred: string; v: number[] }[] = [
  { id: 'in_person', name: 'In-person guest', where: 'Venue + phone', cred: 'Wallet pass · NFC/QR', v: [2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2] },
  { id: 'virtual', name: 'Virtual attendee', where: 'Browser, Mac, Windows, Linux, iOS', cred: 'Access sign-in · passkey', v: [2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2] },
  { id: 'vip', name: 'VIP / host committee', where: 'Reserved zones', cred: 'Wallet pass + zone', v: [2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2] },
  { id: 'sponsor', name: 'Sponsor / exhibitor', where: 'Booth + theater', cred: 'Organization account', v: [2, 2, 2, 2, 2, 1, 2, 2, 2, 1, 2] },
  { id: 'press', name: 'Press / media', where: 'Press row · clean feed', cred: 'Verified credential', v: [2, 1, 2, 0, 1, 0, 1, 2, 2, 1, 2] },
  { id: 'speaker', name: 'Speaker / talent', where: 'Green room → stage', cred: 'Verify with Wallet + role', v: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2] },
  { id: 'moderator', name: 'Moderator / host', where: 'Stage + console', cred: 'Verify with Wallet + role', v: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2] },
  { id: 'watch_party', name: 'Watch party (group)', where: 'Office or venue screen', cred: 'Group license · host device', v: [2, 2, 2, 2, 2, 1, 0, 0, 1, 0, 2] },
  { id: 'on_demand', name: 'On-demand viewer', where: 'After the event', cred: 'Account or link', v: [2, 0, 1, 0, 1, 0, 0, 0, 2, 0, 2] },
  { id: 'interpreter', name: 'Interpreter / captioner', where: 'Language booth', cred: 'Crew role · WARP', v: [2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1] },
  { id: 'remote_family', name: 'Remote family (social)', where: 'Phone or TV', cred: 'Invite link', v: [2, 2, 1, 1, 2, 1, 0, 0, 0, 0, 2] },
  { id: 'staff', name: 'Staff & volunteers', where: 'Staff app', cred: 'Staff role · badge', v: [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1] },
  { id: 'vendor', name: 'Vendor / concessionaire', where: 'Vendor console + POS', cred: 'Business account', v: [1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0] },
  { id: 'organizer', name: 'Organizer / admin', where: 'Every space', cred: 'Verify with Wallet · step-up', v: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2] },
];

export function AttendeeTypes() {
  const { snap } = useEvent();
  const count = (t: AttendeeType) => snap.state.guests.filter((g) => g.type === t).length;
  const cell = (v: number) => v === 2 ? <span aria-label="Included" style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', background: 'var(--accent)' }} />
    : v === 1 ? <span aria-label="Organizer can enable" style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--muted)' }} />
      : <span aria-label="Not available" style={{ display: 'inline-block', width: 14, height: 2, background: '#4A5562' }} />;
  return (
    <>
      <div className="row between top"><div className="stack tight" style={{ maxWidth: 760 }}><h1>Who attends, and what each person can do</h1><span className="muted">Every attendee type is a set of permissions on one event. People keep one identity as they move between lobby, stages and breakouts.</span></div>
        <div className="row small"><span className="row" style={{ gap: 6 }}>{cell(2)} Included</span><span className="row" style={{ gap: 6 }}>{cell(1)} Organizer can enable</span><span className="row" style={{ gap: 6 }}>{cell(0)} Not available</span></div></div>
      <div className="panel scroll-x" style={{ padding: 0 }}>
        <table className="table" style={{ minWidth: 1240 }}>
          <thead><tr><th style={{ paddingLeft: 14 }}>Attendee type</th><th>Joins via · credential</th><th>Here</th>{CAPS.map((c) => <th key={c} style={{ textAlign: 'center' }}>{c}</th>)}</tr></thead>
          <tbody>
            {TYPES.map((t) => (
              <tr key={t.id}>
                <td style={{ paddingLeft: 14 }}><b>{t.name}</b><div className="small muted">{t.where}</div></td>
                <td className="small" style={{ color: 'var(--text-2)' }}>{t.cred}</td>
                <td className="mono">{count(t.id)}</td>
                {t.v.map((v, i) => <td key={i} className="center">{cell(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid" style={{ '--min': '300px' } as React.CSSProperties}>
        <div className="panel"><span className="label">Access needs follow the person</span><span style={{ color: 'var(--text-2)', lineHeight: 1.45 }}>Captions, interpreted audio, ASL view and step-free seating are set once on a profile and apply everywhere.</span></div>
        <div className="panel"><span className="label">Promotion is time-boxed</span><span style={{ color: 'var(--text-2)', lineHeight: 1.45 }}>An audience member invited on stage gets talent rights only for that segment, after preflight and a moderator's approval.</span></div>
        <div className="panel"><span className="label">Social events use the same types</span><span style={{ color: 'var(--text-2)', lineHeight: 1.45 }}>A wedding maps to host, family, guests, remote relatives, vendors and staff — fewer controls by default.</span></div>
      </div>
    </>
  );
}

// ======================================================================= Check-in (front of house)

export function CheckIn() {
  const { snap, send } = useEvent();
  useTick(1000);
  const s = snap.state;
  const [mode, setMode] = useState<'guest' | 'admin'>('guest');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [verified, setVerified] = useState<null | boolean>(null);
  const [verifying, setVerifying] = useState(false);
  const matches = s.guests.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()) || g.id === q).slice(0, 8);
  const g = s.guests.find((x) => x.id === sel);
  const total = s.guests.length, inCount = s.guests.filter((x) => x.checkedIn).length;
  const recent = s.guests.filter((x) => x.checkedInAt).sort((a, b) => (b.checkedInAt ?? 0) - (a.checkedInAt ?? 0)).slice(0, 5);

  const verify = async () => {
    setVerifying(true);
    await new Promise((r) => setTimeout(r, 900)); // Verify with Wallet request + user consent on their phone
    setVerified(true);
    setVerifying(false);
  };
  const admit = async () => { if (g && await send({ type: 'CHECK_IN', guestId: g.id, verified: !!verified })) { setSel(null); setVerified(null); setQ(''); } };

  return (
    <div className="device">
      <div className="row between"><div className="stack tight" style={{ gap: 2 }}><span className="small muted">Front of house</span><h2 style={{ fontSize: 22 }}>Check-in</h2></div><span className="mono muted">{inCount} / {total}</span></div>
      <div className="seg" role="radiogroup" style={{ alignSelf: 'stretch' }}>
        <button role="radio" aria-checked={mode === 'guest'} className={mode === 'guest' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('guest')}>Guest pass</button>
        <button role="radio" aria-checked={mode === 'admin'} className={mode === 'admin' ? 'on' : ''} style={{ flex: 1 }} onClick={() => setMode('admin')}>Admin pass</button>
      </div>
      <label className="fieldlabel">Scan a pass or search by name<input className="field" value={q} onChange={(e) => { setQ(e.target.value); setSel(null); setVerified(null); }} placeholder="Name or pass id" /></label>
      {!g && q && (
        <div className="panel" style={{ padding: 6, gap: 0 }}>
          {matches.map((m) => <button key={m.id} className="btn ghost" style={{ justifyContent: 'space-between', border: 0 }} onClick={() => setSel(m.id)}><span>{m.name}</span><span className={`small ${m.checkedIn ? 'ok' : 'muted'}`}>{m.checkedIn ? 'in' : m.type.replace('_', ' ')}</span></button>)}
          {!matches.length && <Empty>No one by that name.</Empty>}
        </div>
      )}
      {g && (
        <div className={`panel ${g.checkedIn ? '' : verified || mode === 'guest' ? 'okp' : 'warnp'}`} style={{ borderWidth: 2 }}>
          <div className="stack tight" style={{ gap: 2 }}><b style={{ fontSize: 18 }}>{g.name}</b><span className="small muted">{g.type.replace('_', ' ')}{g.seat ? ` · seat ${g.seat}` : ''} · pass {g.id}</span></div>
          {g.checkedIn ? <span className="ok">Already checked in at {clockTime(g.checkedInAt!)}</span> : mode === 'admin' ? (
            <>
              {verified ? (
                <div className="stack tight small">
                  <div className="row between"><span className="muted">Identity verified with Wallet</span><b className="ok">Yes</b></div>
                  <div className="row between"><span className="muted">Name matches roster</span><b>Yes</b></div>
                  <div className="row between"><span className="muted">Attributes kept</span><b>None · result only</b></div>
                </div>
              ) : <button className="btn accent" onClick={verify} disabled={verifying}>{verifying ? 'Waiting for their consent on iPhone…' : 'Verify with Wallet'}</button>}
              {g.grantedRole && <div className="divider stack tight" style={{ paddingTop: 8 }}><span className="label ok">Role granted by organizer</span><b>{g.grantedRole}</b><span className="small muted">Production consoles also need a WARP device.</span></div>}
            </>
          ) : null}
          {!g.checkedIn && (
            <div className="row nowrap-row">
              <button className="btn lg" style={{ flex: 1 }} onClick={async () => { if (await send({ type: 'DENY_ENTRY', reason: `${g.name} · escalated` })) setSel(null); }}>Escalate</button>
              <button className="btn lg primary" style={{ flex: 2 }} disabled={mode === 'admin' && !verified} onClick={admit}>Admit{mode === 'admin' ? ' & issue badge' : ''}</button>
            </div>
          )}
        </div>
      )}
      <div className="stack tight">
        <span className="label">Recent</span>
        <div className="list small">{recent.map((r) => <div key={r.id} className="row between"><span>{r.name} · {r.type.replace('_', ' ')}</span><span className="ok">{r.verified ? 'Verified · ' : ''}{clockTime(r.checkedInAt!)}</span></div>)}</div>
      </div>
    </div>
  );
}

// ======================================================================= Orders & valet (vendor / FOH)

export function VendorQueue() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const open = s.orders.filter((o) => o.status !== 'settled');
  const next: Record<string, string> = { created: 'Accept', accepted: 'Start preparing', preparing: 'Ready', ready: 'Delivered', delivered: 'Settle' };
  const vNext: Record<string, string> = { received: 'Stored', stored: 'Retrieve', requested: 'Release' };
  return (
    <div className="cols">
      <div className="panel" style={{ flex: '2 1 480px', minWidth: 0 }}>
        <div className="row between"><span className="label">Seat orders · {open.length} open</span><span className="small muted">Settled {money(s.orders.filter((o) => o.status === 'settled').reduce((a, o) => a + o.totalCents, 0))}</span></div>
        <div className="list">
          {s.orders.slice().reverse().map((o) => (
            <div key={o.id} className="row nowrap-row">
              <span className="stack tight grow" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{o.id} · {o.items}</b><span className="small muted">{o.guestName}{o.seat ? ` · seat ${o.seat}` : ''} · {money(o.totalCents)} · {clockTime(o.ts)}</span></span>
              <span className={`pill square ${o.status === 'settled' ? 'ok' : 'warn'}`}>{o.status.toUpperCase()}</span>
              {o.status !== 'settled' && <button className="btn sm" onClick={() => send({ type: 'ADVANCE_ORDER', orderId: o.id })}>{next[o.status]}</button>}
            </div>
          ))}
          {!s.orders.length && <Empty>No orders yet.</Empty>}
        </div>
      </div>
      <div className="panel" style={{ flex: '1 1 340px', minWidth: 0 }}>
        <span className="label">Valet · custody log</span>
        <div className="list">
          {s.valet.map((v) => (
            <div key={v.id} className="row nowrap-row">
              <span className="stack tight grow" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{v.claim} · {v.guestName}</b><span className="small muted">{v.vehicle}</span></span>
              <span className={`pill square ${v.status === 'requested' ? 'warn' : ''}`}>{v.status.toUpperCase()}</span>
              {v.status !== 'released' && <button className="btn sm" onClick={() => send({ type: 'VALET_ADVANCE', ticketId: v.id })}>{vNext[v.status]}</button>}
            </div>
          ))}
        </div>
        <span className="small muted">VehicleReceived → Stored → RetrievalRequested → Released, each step journaled.</span>
      </div>
    </div>
  );
}
