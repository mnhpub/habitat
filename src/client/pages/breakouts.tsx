import { useState } from 'react';
import type { Breakout, CommandResult } from '../../shared/types';
import { CREW_ROLES, currentBreakout, isMember } from '../../shared/breakout';
import { api, toast, useEvent } from '../store';
import { clockTime, Empty, Person } from '../lib';
import { ChatText, LanguagePicker, useTranslateTo } from '../translate';

/** Small-team breakouts: a members-only room with chat, a saved transcript and generated notes. */
export function Breakouts() {
  const { snap, send, has } = useEvent();
  const s = snap.state;
  const me = snap.me.email;
  // Older or partial records may lack the arrays a room renders; treat them as empty.
  const rooms: Breakout[] = (s.breakouts ?? []).map((b) => ({ ...b, members: b.members ?? [], messages: b.messages ?? [] }));
  const mine = currentBreakout(rooms, me);
  const [viewId, setViewId] = useState<string | null>(null);
  const viewing = rooms.find((b) => b.id === viewId) ?? mine ?? rooms.find((b) => b.status === 'open');
  const open = rooms.filter((b) => b.status === 'open');
  const ended = rooms.filter((b) => b.status === 'ended');

  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="stack tight">
          <h1>Breakouts</h1>
          <span className="muted">Small rooms for the crew. Chat is saved as the transcript, and notes can be written from it when the breakout ends.</span>
        </div>

        <CreateBreakout />

        {viewing ? <Room b={viewing} /> : <div className="panel"><b>No breakouts yet</b><span className="small muted">Create one above, then join it.</span></div>}

        <div className="stack tight">
          <span className="label">Open · {open.length}</span>
          {open.length ? <BreakoutGrid list={open} selected={viewing?.id} onPick={setViewId} /> : <Empty>No open breakouts.</Empty>}
        </div>
        {ended.length > 0 && (
          <div className="stack tight">
            <span className="label">Ended · {ended.length}</span>
            <BreakoutGrid list={ended} selected={viewing?.id} onPick={setViewId} />
          </div>
        )}
      </div>
      <div className="side-col stack">
        <div className="panel">
          <span className="label">Your breakout</span>
          {mine ? <b>{mine.name}</b> : <span className="muted small">You are not in a breakout. Join one to chat.</span>}
          {!has('producer', 'moderator') && <span className="small muted">Hosts can read every breakout. Everyone else sees only the rooms they are in.</span>}
        </div>
      </div>
    </div>
  );
}

function CreateBreakout() {
  const { send } = useEvent();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [capacity, setCapacity] = useState<number>(4);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    const ok = await send({ type: 'CREATE_BREAKOUT', name: name.trim(), topic: topic.trim() || undefined, capacity });
    setBusy(false);
    if (ok) { setName(''); setTopic(''); }
  };
  return (
    <form className="panel stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create(); }} aria-label="New breakout">
      <span className="label">New breakout</span>
      <div className="row nowrap-row">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Cue sheet review" aria-label="Breakout name" maxLength={80} />
        <input className="field" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (optional)" aria-label="Topic" maxLength={200} />
      </div>
      <div className="row between nowrap-row">
        <div className="seg" role="radiogroup" aria-label="Seats">
          {[2, 3, 4, 5, 6, 7, 8].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={capacity === n} className={capacity === n ? 'on' : ''} onClick={() => setCapacity(n)}>{n}</button>
          ))}
        </div>
        <button className="btn primary" type="submit" disabled={!name.trim() || busy}>Create breakout</button>
      </div>
      <span className="small muted">Up to 8 people per breakout.</span>
    </form>
  );
}

function BreakoutGrid({ list, selected, onPick }: { list: Breakout[]; selected?: string; onPick: (id: string) => void }) {
  const { snap } = useEvent();
  return (
    <div className="grid" style={{ '--min': '220px' } as React.CSSProperties}>
      {list.map((b) => {
        const here = isMember(b, snap.me.email);
        return (
          <button key={b.id} className={`tile ${b.id === selected ? 'pvw' : ''}`} style={{ padding: 12 }} onClick={() => onPick(b.id)} aria-pressed={b.id === selected}>
            <b>{b.name}</b>
            <span className="small muted">{b.topic || 'No topic'}</span>
            <span className="row" style={{ gap: 4 }}>
              {Array.from({ length: b.capacity }, (_, i) => (
                <span key={i} style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid #39424E', background: i < b.members.length ? 'var(--accent)' : 'transparent' }} />
              ))}
            </span>
            <span className="small muted">
              {b.status === 'ended' ? 'Ended' : here ? 'You are here' : b.members.length >= b.capacity ? 'Full' : `${b.capacity - b.members.length} open`}
              {b.notes ? ' · notes' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Room({ b }: { b: Breakout }) {
  const { snap, send, has } = useEvent();
  const me = snap.me.email;
  const mine = isMember(b, me);
  // The server projects messages and notes only for members and hosts; mirror that to pick the right copy.
  const canSee = mine || has('producer', 'moderator');
  const full = b.members.length >= b.capacity;
  const onlineNow = (email: string) => snap.presence.some((p) => p.email === email);
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);
  const [reading, setReading] = useTranslateTo();

  const join = () => send({ type: 'JOIN_BREAKOUT', breakoutId: b.id });
  const leave = () => send({ type: 'LEAVE_BREAKOUT' });
  const end = () => {
    if (window.confirm(`End “${b.name}”? Members will be removed, but the chat stays as the transcript.`)) send({ type: 'END_BREAKOUT', breakoutId: b.id });
  };
  const post = async () => {
    if (text.trim() && await send({ type: 'BREAKOUT_CHAT', text })) setText('');
  };

  const generate = async () => {
    setWorking(true);
    try {
      const r = await api<CommandResult>(`/api/events/${snap.state.id}/breakouts/${b.id}/notes`, { method: 'POST' });
      if (!r.ok) toast(r.error ?? 'Notes could not be saved');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Notes could not be generated');
    } finally {
      setWorking(false);
    }
  };

  const download = () => {
    const lines = [
      `${b.name}${b.topic ? ` — ${b.topic}` : ''}`,
      `Transcript (times UTC)`,
      '',
      ...b.messages.map((m) => `[${new Date(m.ts).toISOString().slice(11, 16)}] ${m.authorName}: ${m.text}`),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${b.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`panel ${mine ? 'accent' : ''} stack`}>
      <div className="row between nowrap-row">
        <div className="stack tight" style={{ gap: 2 }}>
          <b style={{ fontSize: 16 }}>{b.name}</b>
          <span className="small muted">{b.topic || 'No topic'} · {b.members.length} of {b.capacity} seats{b.status === 'ended' ? ' · ended' : ''}</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {b.status === 'open' && (mine
            ? <button className="btn" onClick={leave}>Leave</button>
            : <button className="btn accent" onClick={join} disabled={full}>{full ? 'Full' : 'Join'}</button>)}
          {b.status === 'open' && has(...CREW_ROLES) && (
            <button className="btn danger" onClick={end}>End</button>
          )}
        </div>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {b.members.map((m) => (
          <span key={m.email} className="row" style={{ gap: 6 }}>
            <Person size={22} /> <span>{m.email === me ? 'You' : m.name}</span>
            {onlineNow(m.email) && <span className="ok small"><span className="dot" /></span>}
          </span>
        ))}
        {!b.members.length && <span className="small muted">Nobody here yet.</span>}
      </div>

      {canSee ? (
        <>
          <LanguagePicker value={reading} onChange={setReading} />
          <div className="stack tight" style={{ maxHeight: 320, overflowY: 'auto' }} aria-label="Transcript">
            {b.messages.map((m) => (
              <div key={m.id}><b>{m.authorName}</b> <span className="small muted">{clockTime(m.ts)}</span><ChatText text={m.text} target={reading} /></div>
            ))}
            {!b.messages.length && <Empty>{mine ? 'Say hello to start the transcript.' : 'Nothing said yet.'}</Empty>}
          </div>
          {mine && b.status === 'open' && (
            <form className="row nowrap-row" onSubmit={(e) => { e.preventDefault(); post(); }}>
              <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message this breakout…" aria-label="Breakout message" maxLength={500} />
              <button className="btn" type="submit" disabled={!text.trim()}>Send</button>
            </form>
          )}

          <div className="stack tight">
            <div className="row between nowrap-row">
              <span className="label">Notes</span>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={download} disabled={!b.messages.length}>Download transcript</button>
                <button className="btn sm primary" onClick={generate} disabled={working || !b.messages.length}>
                  {working ? 'Writing notes…' : b.notes ? 'Regenerate notes' : 'Generate notes'}
                </button>
              </div>
            </div>
            {b.notes
              ? <div className="stack tight" style={{ whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{b.notes.text}<span className="small muted">Written {clockTime(b.notes.generatedAt)}</span></div>
              : <Empty>{b.messages.length ? 'No notes yet.' : 'Notes appear once the breakout has some chat.'}</Empty>}
          </div>
        </>
      ) : (
        <Empty>{b.status === 'open' ? 'Join this breakout to see its chat.' : 'Only members and hosts can read this breakout.'}</Empty>
      )}
    </div>
  );
}
