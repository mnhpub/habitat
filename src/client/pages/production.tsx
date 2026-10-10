import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useEvent, useTick } from '../store';
import { clockTime, Empty, fmtCountdown, fmtTau, Gate, initials, Person, ROLE_LABEL, Switch, Tau } from '../lib';
import type { Cue, EventView, JournalEntry, Role } from '../../shared/types';
import { BRIDGE_ROLES } from '../../shared/types';
import * as Video from './video';

const srcLabel = (s: EventView, id: string) => s.sources.find((x) => x.id === id)?.label ?? id;

function liveCue(s: EventView) { return s.cues.find((c) => c.status === 'live'); }
function nextCue(s: EventView) { return s.cues.find((c) => c.status === 'pending'); }

/** Simulated program meters: shaped by gain and mute, wobbling over time. */
function level(gainDb: number, muted: boolean, seed: number) {
  if (muted) return 0;
  const base = Math.max(0, Math.min(1, (gainDb + 40) / 45));
  const wob = 0.18 * Math.sin(Date.now() / 180 + seed * 1.7) + 0.08 * Math.sin(Date.now() / 53 + seed);
  return Math.max(0, Math.min(1, base + wob));
}

export function Monitor({ label, kind, caption, big }: { label: string; kind?: 'pgm' | 'pvw'; caption?: string; big?: boolean }) {
  const { snap } = useEvent();
  const hold = kind === 'pgm' && snap.state.production.hold;
  return (
    <div className={`monitor ${kind ?? ''}`}>
      <Person size={big ? 110 : 80} />
      {kind && <span className={`tag tl label ${kind === 'pgm' ? 'pgm' : 'ok'}`}>{kind === 'pgm' ? 'Program' : 'Preview'}</span>}
      <span className="tag bl" style={{ fontWeight: 600 }}>{label}</span>
      {caption && <span className="tag br mono">{caption}</span>}
      {hold && <div className="slate">HOLDING · WE'LL BE RIGHT BACK</div>}
    </div>
  );
}

// ======================================================================= Control room

export function ControlRoom() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const p = s.production;
  useTick(150);

  return (
    <div className="cols">
      <div className="main-col stack">
        <div className="row">
          <div className="half" style={{ flex: '1 1 320px', minWidth: 0 }}><Monitor kind="pvw" label={srcLabel(s, p.previewId)} /></div>
          <div className="half" style={{ flex: '1 1 320px', minWidth: 0 }}><Monitor kind="pgm" label={srcLabel(s, p.programId)} caption={p.onAir ? '1080p59.94 · on air' : 'off air'} /></div>
        </div>

        <div className="panel">
          <div className="row">
            <button className="btn lg" onClick={() => send({ type: 'CUT_TO', sourceId: p.previewId })}>CUT</button>
            <button className="btn lg" onClick={() => send({ type: 'TAKE' })}>AUTO · MIX</button>
            <button className="btn lg take" onClick={() => send({ type: 'TAKE' })}>TAKE</button>
            <span className="small muted">Preview ↔ program swap, confirmed by the event server.</span>
            <div className="grow" />
            <button className={`btn lg ${p.hold ? 'warn-fill' : 'warn'}`} onClick={() => send({ type: 'SET_HOLD', on: !p.hold })}>{p.hold ? 'RELEASE HOLD' : 'EMERGENCY HOLD'}</button>
          </div>
          <div className="row small">
            <label className="row" style={{ gap: 8 }}><Switch on={p.onAir} onChange={(v) => send({ type: 'SET_ON_AIR', on: v })} label="On air" />On air</label>
            <label className="row" style={{ gap: 8 }}><Switch on={p.recording} onChange={(v) => send({ type: 'SET_RECORDING', on: v })} label="Recording" />Recording</label>
            <label className="row" style={{ gap: 8 }}><Switch on={p.autoDirector} onChange={(v) => send({ type: 'SET_AUTO_DIRECTOR', on: v })} label="Auto-director" />Auto-director</label>
            <Link to="../bus" className="pill accent">Stream bus · {s.subscribers.filter((x) => x.on).length} subscribers</Link>
            <Link to="../bridge" className="pill">Bridge · {snap.presence.filter((x) => x.roles.some((r) => BRIDGE_ROLES.includes(r))).length} on</Link>
          </div>
        </div>

        <div className="stack tight">
          <div className="row between"><span className="label">Multiview · click to preview, double-click to cut</span><span className="small muted">{s.sources.length} sources</span></div>
          <div className="grid" style={{ '--min': '170px' } as React.CSSProperties}>
            {s.sources.map((src, i) => {
              const pgm = src.id === p.programId, pvw = src.id === p.previewId;
              return (
                <button key={src.id} className={`tile ${pgm ? 'pgm' : pvw ? 'pvw' : ''}`} onClick={() => !pgm && send({ type: 'SET_PREVIEW', sourceId: src.id })} onDoubleClick={() => send({ type: 'CUT_TO', sourceId: src.id })} aria-label={`Preview ${src.label}`}>
                  <span className="monitor" style={{ borderRadius: 5 }}>
                    <Person size={40} />
                    {(pgm || pvw) && <span className="tag tl pill square" style={{ background: pgm ? 'var(--pgm-fill)' : '#1A7F4B', color: '#fff' }}>{pgm ? 'PGM' : 'PVW'}</span>}
                    <span className="tag br" style={{ width: 34, height: 4, padding: 0, background: '#262C34' }}><span style={{ display: 'block', height: 4, width: `${Math.round(level(src.kind === 'media' ? -40 : -12, false, i) * 100)}%`, background: 'var(--ok)', borderRadius: 2 }} /></span>
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{src.label}</span>
                  <span className="small muted">{src.meta}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="side-col stack">
        <RunOfShow />
        <TalentPanel />
        <AudioPanel />
        <JournalPanel />
      </div>
    </div>
  );
}

function RunOfShow() {
  const { snap, send, store } = useEvent();
  const s = snap.state;
  const tau = store.now() - s.epoch;
  const live = liveCue(s);
  const pending = s.cues.filter((c) => c.status === 'pending');
  const row = (c: Cue, tag: string, cls: string) => (
    <div key={c.id} className={`panel ${cls}`} style={{ padding: 10, gap: 4 }}>
      <div className="row between"><span className="label">{tag}</span><span className="mono small">{fmtTau(c.at)}</span></div>
      <span style={{ fontWeight: 600 }}>{c.title}{c.auto ? <span className="muted small"> · auto</span> : null}</span>
      <span className="small muted">{c.detail}</span>
      {tag === 'NEXT' && <span className="small mono accent">{c.at - tau > 0 ? `in ${fmtCountdown(c.at - tau)}` : `due ${fmtCountdown(c.at - tau)} ago`}</span>}
    </div>
  );
  return (
    <div className="panel">
      <div className="row between"><span className="label">Run of show</span><span className="mono small muted">Cue {s.cues.filter((c) => c.status !== 'pending').length} / {s.cues.length}</span></div>
      {live && row(live, 'NOW', 'pgmp')}
      {pending[0] && row(pending[0], 'NEXT', 'okp')}
      {pending[1] && row(pending[1], 'THEN', '')}
      <Gate roles={['producer', 'stage_manager']}>
        <div className="row">
          <button className="btn" onClick={() => send({ type: 'FIRE_NEXT_CUE' })} disabled={!pending.length}>Fire next cue</button>
          {pending[0] && <button className="btn ghost" onClick={() => send({ type: 'SKIP_CUE', cueId: pending[0].id })}>Skip</button>}
          <div className="grow" />
          <label className="row small" style={{ gap: 8 }}>Auto-run<Switch on={s.production.autoRun} onChange={(v) => send({ type: 'SET_AUTO_RUN', on: v })} label="Auto-run cues" /></label>
        </div>
      </Gate>
    </div>
  );
}

const TALENT_COLOR: Record<string, string> = { live: 'var(--pgm-ink)', standby: 'var(--warn)', ready: 'var(--ok-ink)', preflight: 'var(--accent-ink)', arrived: 'var(--muted)', invited: 'var(--dim)', off: 'var(--dim)' };

function TalentPanel() {
  const { snap } = useEvent();
  return (
    <div className="panel">
      <div className="row between"><span className="label">Backstage · talent state</span><Link to="../green-room" className="small">Green rooms</Link></div>
      <div className="list">
        {snap.state.talent.map((t) => (
          <div key={t.id} className="row nowrap-row">
            <span className="avatar">{initials(t.name)}</span>
            <div className="stack tight grow" style={{ gap: 1, minWidth: 0 }}><span style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</span><span className="small muted">{t.greenRoom} · {t.where}</span></div>
            <span className="pill square" style={{ color: TALENT_COLOR[t.state], borderColor: TALENT_COLOR[t.state] }}>{t.state.toUpperCase()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AudioPanel() {
  const { snap, send, has } = useEvent();
  const canMix = has('producer', 'audio');
  return (
    <div className="panel">
      <div className="row between"><span className="label">Audio · mirrored to control surfaces</span><span className="small muted">−23 LUFS</span></div>
      <div className="grid" style={{ '--min': '70px' } as React.CSSProperties}>
        {snap.state.buses.map((b, i) => (
          <div key={b.id} className="stack tight" style={{ alignItems: 'center' }}>
            <div className="row nowrap-row" style={{ height: 110, alignItems: 'flex-end', gap: 8 }}>
              <div className="meter" style={{ height: 110 }}><span style={{ height: `${Math.round(level(b.gainDb, b.muted, i) * 100)}%` }} /></div>
              <Fader value={b.gainDb} disabled={!canMix} label={`${b.name} gain`} onCommit={(v) => send({ type: 'SET_GAIN', busId: b.id, gainDb: v })} />
            </div>
            <span style={{ fontWeight: 600, fontSize: 12 }}>{b.name}</span>
            <span className="mono small muted">{b.muted ? 'MUTE' : `${b.gainDb} dB`}</span>
            <button className={`btn sm ${b.muted ? 'danger' : 'ghost'}`} disabled={!canMix} onClick={() => send({ type: 'TOGGLE_MUTE', busId: b.id })}>{b.muted ? 'Unmute' : 'Mute'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Moves locally while dragging; sends one SET_GAIN when released. */
function Fader({ value, disabled, label, onCommit }: { value: number; disabled: boolean; label: string; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState<number | null>(null);
  const commit = () => { if (local !== null && local !== value) onCommit(local); setLocal(null); };
  return (
    <input type="range" min={-60} max={10} step={0.5} value={local ?? value} disabled={disabled} aria-label={label}
      onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit}
      style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 110, width: 24 }} />
  );
}

function JournalPanel() {
  const { snap } = useEvent();
  return (
    <div className="panel">
      <div className="row between"><span className="label">Command journal</span><Link to="../clock" className="small">Full timeline</Link></div>
      <div className="list small">
        {snap.state.recent.slice(0, 7).map((j) => (
          <div key={j.seq} style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: 8 }}>
            <span className="mono muted">{fmtTau(j.tau)}</span>
            <span>{j.summary} <span className="muted">· {j.actor.split('@')[0]}</span></span>
          </div>
        ))}
        {!snap.state.recent.length && <Empty>Nothing yet — actions you take appear here with their sequence number.</Empty>}
      </div>
    </div>
  );
}

// ======================================================================= Simple control room

const SHOTS = [
  { id: 'speaker', name: 'Active speaker' }, { id: 'two', name: 'Two-up' }, { id: 'panel', name: 'Panel grid' },
  { id: 'slides', name: 'Slides + speaker' }, { id: 'wide', name: 'Room wide' }, { id: 'slate', name: 'Holding slate' },
] as const;

export function SimpleControl() {
  const { snap, send, store } = useEvent();
  useTick(500);
  const s = snap.state;
  const p = s.production;
  const next = nextCue(s);
  const tau = store.now() - s.epoch;
  const queued = s.questions.find((q) => q.status === 'on_stage') ?? [...s.questions].filter((q) => q.status === 'approved').sort((a, b) => b.votes - a.votes)[0];
  const shot = SHOTS.find((x) => x.id === p.layout)!;

  return (
    <div className="cols">
      <div className="main-col stack">
        <div className="row"><span className="seg"><span className="on" style={{ padding: '6px 12px' }}>Simple</span><Link to="../control">Pro</Link></span><span className="pill accent">Bus: Stage + recording + simulcast</span></div>
        <Monitor kind="pgm" big label={`${shot.name} · ${srcLabel(s, p.programId)}`} />
        <div className={`panel ${p.autoDirector ? 'okp' : 'warnp'}`}>
          <div className="row nowrap-row">
            <Switch on={p.autoDirector} onChange={(v) => send({ type: 'SET_AUTO_DIRECTOR', on: v })} label="Auto-director" />
            <div className="stack tight"><span style={{ fontWeight: 600 }}>{p.autoDirector ? 'Auto-director is on' : 'Manual · you are choosing shots'}</span>
              <span className="small muted">{p.autoDirector ? 'Following the run of show: each cue brings up its own shot. Pick any shot to take over.' : 'Turn auto back on any time — it picks up from the current shot.'}</span></div>
          </div>
        </div>
        <div className="stack tight">
          <span className="label">Shots · click to take</span>
          <div className="grid" style={{ '--min': '150px' } as React.CSSProperties}>
            {SHOTS.map((x) => (
              <button key={x.id} className={`tile ${p.layout === x.id ? 'pgm' : ''}`} aria-pressed={p.layout === x.id} onClick={() => send({ type: 'SET_LAYOUT', layout: x.id })}>
                <span className="monitor" style={{ borderRadius: 5 }}>{p.layout === x.id && <span className="tag tl pill square" style={{ background: 'var(--pgm-fill)', color: '#fff' }}>LIVE</span>}</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{x.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <button className={`btn lg ${p.hold ? 'warn-fill' : 'warn'}`} onClick={() => send({ type: 'SET_HOLD', on: !p.hold })}>{p.hold ? 'Back from break' : 'Hold · Be right back'}</button>
          <Link className="btn lg" to="../team">Hand off to shadow producer</Link>
          <button className="btn lg" onClick={() => send({ type: 'FIRE_NEXT_CUE' })} disabled={!next}>End segment</button>
        </div>
      </div>
      <div className="side-col stack">
        <div className="panel">
          <span className="label">Up next · fires on its own</span>
          {next ? (
            <div className="panel okp" style={{ padding: 10 }}>
              <div className="row between"><span style={{ fontWeight: 600 }}>{next.title}</span><span className="mono ok">{next.at - tau > 0 ? `in ${fmtCountdown(next.at - tau)}` : 'due'}</span></div>
              <span className="small muted">{next.auto && s.production.autoRun ? 'Will fire automatically' : 'Waits for you'}</span>
              <div className="row">
                <button className="btn sm" onClick={() => send({ type: 'SET_AUTO_RUN', on: !s.production.autoRun })}>{s.production.autoRun ? 'Hold' : 'Resume auto'}</button>
                <button className="btn sm" onClick={() => send({ type: 'SKIP_CUE', cueId: next.id })}>Skip</button>
                <button className="btn sm" onClick={() => send({ type: 'FIRE_NEXT_CUE' })}>Play now</button>
              </div>
            </div>
          ) : <Empty>No more cues.</Empty>}
          <div className="list small">
            {s.cues.filter((c) => c.status === 'pending').slice(1, 4).map((c) => (
              <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '70px minmax(0,1fr)', gap: 8 }}><span className="mono muted">{fmtTau(c.at)}</span><span>{c.title}</span></div>
            ))}
          </div>
        </div>
        <div className="panel">
          <span className="label">Talent · self-checked</span>
          <div className="list small">{s.talent.map((t) => <div key={t.id} className="row between"><span>{t.name}</span><span style={{ color: TALENT_COLOR[t.state], fontWeight: 600 }}>{t.state}</span></div>)}</div>
          {s.talent.filter((t) => t.preflight && (!t.preflight.camera || !t.preflight.mic)).map((t) => <div key={t.id} className="banner small">{t.name}'s preflight failed — the stage manager has been told.</div>)}
        </div>
        <div className="panel">
          <span className="label">Host queued for stage</span>
          {queued ? <><span>"{queued.text}"</span><span className="small muted">▲ {queued.votes} · {queued.status === 'on_stage' ? 'on screen now' : 'approved'}</span></> : <Empty>Nothing queued.</Empty>}
        </div>
        <div className="panel">
          <span className="label">Health</span>
          <div className="grid small" style={{ '--min': '130px' } as React.CSSProperties}>
            <span className="ok">Audio auto · −23 LUFS</span>
            <span className={s.production.recording ? 'ok' : 'warn'}>{s.production.recording ? 'Recording + chapters' : 'Not recording'}</span>
            <span className="ok">Backup path ready</span>
            <span className={s.devices.every((d) => d.healthy) ? 'ok' : 'warn'}>{s.devices.filter((d) => !d.healthy).length} device warnings</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ======================================================================= Event clock & devices

export function EventClock() {
  const { snap, store } = useEvent();
  useTick(250);
  const s = snap.state;
  const tau = store.now() - s.epoch;
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [more, setMore] = useState(true);

  useEffect(() => {
    api<JournalEntry[]>(`/api/events/${s.id}/journal?limit=60`).then((rows) => { setJournal(rows); setMore(rows.length === 60); }).catch(() => undefined);
  }, [s.id, s.seq]);

  const loadMore = async () => {
    const last = journal[journal.length - 1];
    if (!last) return;
    const rows = await api<JournalEntry[]>(`/api/events/${s.id}/journal?limit=60&before=${last.seq}`);
    setJournal([...journal, ...rows]);
    setMore(rows.length === 60);
  };

  const win0 = tau - 15 * 60_000, win1 = tau + 45 * 60_000;
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - win0) / (win1 - win0)) * 100))}%`;
  const colors: Record<Cue['status'], [string, string]> = { pending: ['#2A3340', '#4A5562'], live: ['#1A5A39', '#2A8A57'], done: ['#173E52', '#2B6F8F'], skipped: ['#3A2A12', '#6A4C17'] };

  return (
    <>
      <div className="row top">
        <div className="panel accent" style={{ flex: '1 1 280px' }}>
          <span className="label accent">Global event clock · Durable Object</span>
          <span className="mono" style={{ fontSize: 26, fontWeight: 600 }}>τ {fmtTau(tau, true)}</span>
          <span className="small muted">epoch {new Date(s.epoch).toLocaleTimeString()} · seq {s.seq.toLocaleString()} · rate 1.000</span>
        </div>
        <div className="panel" style={{ flex: '1 1 240px' }}>
          <span className="label">This device vs event clock</span>
          <span className="mono" style={{ fontSize: 18 }}>offset {store.offsetMs >= 0 ? '+' : ''}{store.offsetMs.toFixed(1)} ms</span>
          <span className="small muted">Measured from WebSocket round trips every 15 s</span>
        </div>
        <div className="panel" style={{ flex: '1 1 280px' }}>
          <span className="label">Local media clocks</span>
          <div className="row"><span className="pill ok">PTP GM · locked</span><span className="pill ok">Word clock 48 kHz</span><span className="pill ok">Video 60000/1001</span></div>
          <span className="small muted">Sample-accurate timing stays on local hardware; the event clock schedules it.</span>
        </div>
      </div>

      <div className="panel">
        <div className="row between"><span className="label">Run of show on the event clock · τ −15 min to +45 min</span>
          <div className="row small muted"><span>■ pending</span><span className="ok">■ live</span><span className="accent">■ done</span><span className="warn">■ skipped</span></div></div>
        <div className="timeline-lane" style={{ height: 48 }}>
          <div className="playhead" style={{ left: pct(tau) }} />
          {s.cues.map((c) => {
            const [bg, line] = colors[c.status];
            const left = pct(c.at), right = pct(c.at + c.durationMs);
            const w = `calc(${right} - ${left})`;
            return <div key={c.id} className="blk" title={c.title} style={{ left, width: w, minWidth: 6, background: bg, borderColor: line, top: 8 }}>{c.title}</div>;
          })}
        </div>
      </div>

      <div className="cols">
        <div className="half panel">
          <div className="row between"><span className="label">Event journal · every authorized action</span><span className="small muted">{s.seq} entries</span></div>
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Seq</th><th>τ</th><th>Action</th><th>By</th></tr></thead>
              <tbody>
                {journal.map((j) => (
                  <tr key={j.seq}><td className="mono muted">{j.seq}</td><td className="mono accent">{fmtTau(j.tau, true)}</td><td>{j.summary}</td><td className="muted">{j.actor}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {more && journal.length > 0 && <button className="btn sm" onClick={loadMore}>Load older</button>}
          {!journal.length && <Empty>No journal entries yet.</Empty>}
        </div>
        <div className="half panel">
          <div className="row between"><span className="label">Production device registry</span><span className="small muted">Cloudflare One · trust ≠ authority</span></div>
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Device</th><th>Protocol</th><th>Scope</th><th>Trust</th><th>RTT</th><th>Cert</th></tr></thead>
              <tbody>
                {s.devices.map((d) => (
                  <tr key={d.id}>
                    <td><span className="row nowrap-row" style={{ gap: 8 }}><span className="dot" style={{ color: d.healthy ? 'var(--ok)' : 'var(--warn)' }} /><b>{d.name}</b></span></td>
                    <td className="mono small">{d.protocol}</td><td>{d.scope}</td><td>{d.trust}</td><td className="mono small">{d.rttMs} ms</td><td><span className="pill square">{d.cert}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ======================================================================= Stream bus

const CONTRIB_STATUS: Record<string, { label: string; cls: string }> = {
  local: { label: 'LOCAL', cls: '' }, offered: { label: 'OFFERED', cls: 'warn' }, standby: { label: 'STANDBY', cls: 'warn' }, on_bus: { label: 'ON BUS', cls: 'ok' },
};

export function StreamBus() {
  const { snap, send, has } = useEvent();
  const s = snap.state;
  const canRoute = has('producer');
  const on = s.subscribers.filter((x) => x.on);
  const viewers = on.reduce((a, b) => a + b.viewers, 0);
  const tracks = [
    { kind: 'Video', cls: 'accent', items: ['4K60 HDR master', '1080p60', '720p30', 'Clean (no GFX)'] },
    { kind: 'Audio', cls: 'ok', items: ['Program stereo', 'Program 5.1', 'Clean no-music', 'ES interpreted', 'JA interpreted'] },
    { kind: 'Captions', cls: 'warn', items: ['EN live', 'ES', 'JA'] },
    { kind: 'Data', cls: '', items: ['τ timestamps', 'Tally', 'Cue markers', 'Poll graphics', 'Break markers'] },
  ];
  return (
    <>
      <div className="stack tight" style={{ maxWidth: 880 }}>
        <h1>Stream bus · the primary production stream</h1>
        <span className="muted">The control room produces one master program. Any live stage, room screen, watch party or outside platform subscribes to it and adds its own layers downstream — all on the same event clock.</span>
      </div>
      <div className="row top">
        <div className="panel" style={{ flex: '1 1 200px' }}><span className="label">Sources</span><b>Cameras, talent, remote stages</b><span className="small muted">iPhone · iPad · Mac app · SDI · VT</span></div>
        <div className="panel" style={{ flex: '1 1 200px' }}><span className="label">Control room</span><b>{srcLabel(s, s.production.programId)} on program</b><span className="small muted">{s.production.hold ? 'HOLDING' : s.production.onAir ? 'On air' : 'Off air'}</span></div>
        <div className="panel accent" style={{ flex: '1.4 1 260px', borderWidth: 2 }}><span className="label accent">Stream bus · PGM-A</span><b style={{ fontSize: 16 }}>Primary production stream</b><span className="small muted">4K60 HDR master · audio, caption &amp; data tracks · stamped with τ</span></div>
        <div className="panel okp" style={{ flex: '1 1 200px' }}><span className="label ok">Subscribers</span><b style={{ fontSize: 16 }}>{on.length} live now</b><span className="small muted">{viewers.toLocaleString()} viewers</span></div>
      </div>

      <div className="panel">
        <div className="row between"><span className="label">Contributing streams · from the iOS, iPadOS &amp; macOS apps</span><span className="small muted">Any authorized device can publish; the director decides what goes on the bus</span></div>
        <div className="grid" style={{ '--min': '240px' } as React.CSSProperties}>
          {s.contributors.map((c) => (
            <div key={c.id} className="well stack tight">
              <div className="monitor"><span className={`tag tl pill square ${CONTRIB_STATUS[c.status].cls}`}>{CONTRIB_STATUS[c.status].label}</span><span className="tag br small">{c.device}</span></div>
              <b>{c.name}</b><span className="small muted">{c.meta}</span>
              {canRoute && (
                <select className="field" value={c.status} aria-label={`${c.name} status`} onChange={(e) => send({ type: 'SET_CONTRIBUTOR', contributorId: c.id, status: e.target.value as typeof c.status })}>
                  <option value="local">Local only</option><option value="offered">Offered to bus</option><option value="standby">Standby</option><option value="on_bus">On the bus</option>
                </select>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="cols">
        <div className="panel" style={{ flex: '1 1 300px', minWidth: 0 }}>
          <span className="label">What the bus carries</span>
          {tracks.map((t) => (
            <div key={t.kind} className="stack tight divider" style={{ paddingTop: 8 }}>
              <span className={`label ${t.cls}`}>{t.kind}</span>
              <div className="row" style={{ gap: 6 }}>{t.items.map((i) => <span key={i} className="pill square mono">{i}</span>)}</div>
            </div>
          ))}
          <span className="small muted">Talent IFB and crew talkback never ride the bus. Interpreters subscribe to clean audio and publish language tracks back.</span>
        </div>
        <div className="panel" style={{ flex: '3 1 640px', minWidth: 0 }}>
          <span className="label">Subscribers · toggle a stage onto the bus</span>
          <div className="scroll-x">
            <table className="table" style={{ minWidth: 720 }}>
              <thead><tr><th>Stage / output</th><th>Takes from bus</th><th>Adds locally</th><th>Delivery</th><th style={{ textAlign: 'right' }}>On bus</th></tr></thead>
              <tbody>
                {s.subscribers.map((x) => (
                  <tr key={x.id}>
                    <td><div className="stack tight" style={{ gap: 1 }}><b>{x.name}</b><span className={`small ${x.on ? 'ok' : 'muted'}`}>{x.on ? 'Subscribed · in sync with τ' : 'Off bus · own program'}</span></div></td>
                    <td className="muted">{x.takes}</td><td className="muted">{x.adds}</td><td className="mono small">{x.delivery}</td>
                    <td style={{ textAlign: 'right' }}>{canRoute ? <Switch on={x.on} onChange={(v) => send({ type: 'SET_SUBSCRIBER', subscriberId: x.id, on: v })} label={`Subscribe ${x.name}`} /> : <span className="small">{x.on ? 'On' : 'Off'}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ======================================================================= Bridge

const BRIDGE_GROUPS: { name: string; roles: Role[] }[] = [
  { name: 'Production', roles: ['producer', 'audio', 'stage_manager'] },
  { name: 'Host & talent', roles: ['moderator', 'talent'] },
  { name: 'Organizers, front of house & vendors', roles: ['organizer', 'foh', 'vendor'] },
];

export function Bridge() {
  const { snap, send } = useEvent();
  const s = snap.state;
  const [note, setNote] = useState('');
  const [channels, setChannels] = useState([
    { name: 'All-call', who: 'Everyone on the bridge', listen: true, talk: false },
    { name: 'Production', who: 'Director, TD, audio, SM', listen: true, talk: true },
    { name: 'Talent wrangling', who: 'SM, green rooms, waiting talent', listen: true, talk: false },
    { name: 'Remote stages', who: 'Breakout hosts, field cams, parties', listen: true, talk: false },
    { name: 'FOH & hospitality', who: 'Check-in, catering, valet', listen: false, talk: false },
  ]);
  const crew = snap.presence.filter((x) => x.roles.some((r) => BRIDGE_ROLES.includes(r)));
  const myMic = !!s.bridgeMics[snap.me.email];
  const toggleCh = (i: number, k: 'listen' | 'talk') => setChannels(channels.map((c, j) => (j === i ? { ...c, [k]: !c[k] } : c)));

  return (
    <div className="cols">
      <div className="main-col stack loose">
        <div className="stack tight" style={{ maxWidth: 820 }}>
          <div className="row"><h1>The bridge</h1><span className="pill ok"><span className="dot" />Always open · {crew.length} connected</span></div>
          <span className="muted">The always-open call for everyone working the event — the backstage counterpart to the lobby. People wait here, talk on channels, and get moved to green rooms or stages without new links.</span>
        </div>
        <Video.VideoRoom />
        {BRIDGE_GROUPS.map((g) => {
          const people = crew.filter((x) => x.roles.some((r) => g.roles.includes(r)));
          return (
            <div key={g.name} className="stack tight">
              <div className="row between"><span className="label">{g.name}</span><span className="small muted">{people.length} on bridge</span></div>
              {people.length === 0 ? <Empty>Nobody connected right now.</Empty> : (
                <div className="grid" style={{ '--min': '200px' } as React.CSSProperties}>
                  {people.map((x) => {
                    const live = !!s.bridgeMics[x.email];
                    return (
                      <div key={x.email} className="panel" style={{ padding: 8, borderColor: live ? 'var(--ok-line)' : undefined }}>
                        <div className="monitor"><Person size={34} /><span className="tag tl pill square" style={{ background: live ? '#1A7F4B' : '#39424E', color: '#fff' }}>{live ? 'TALKING' : 'MUTED'}</span><span className="tag br small">{x.device}</span></div>
                        <div className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{x.name}{x.email === snap.me.email ? ' (you)' : ''}</b><span className="small muted">{x.roles.map((r) => ROLE_LABEL[r]).join(', ')}</span></div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="side-col stack">
        <div className="panel">
          <div className="row between"><span className="label">Stream bus · PGM-A</span><span className="small muted">Ducked under bridge audio</span></div>
          <Monitor kind="pgm" label={srcLabel(s, s.production.programId)} />
        </div>
        <div className="panel">
          <span className="label">Channels</span>
          <div className="list">
            {channels.map((c, i) => (
              <div key={c.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 48px 48px', gap: 6, alignItems: 'center' }}>
                <span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{c.name}</b><span className="small muted">{c.who}</span></span>
                <button className={`btn sm ${c.listen ? 'on' : 'ghost'}`} aria-pressed={c.listen} aria-label={`Listen to ${c.name}`} onClick={() => toggleCh(i, 'listen')}>L</button>
                <button className={`btn sm ${c.talk ? 'on' : 'ghost'}`} aria-pressed={c.talk} aria-label={`Talk on ${c.name}`} onClick={() => toggleCh(i, 'talk')}>T</button>
              </div>
            ))}
          </div>
          <button className={`btn lg ${myMic ? 'warn-fill' : 'accent'}`} onClick={() => send({ type: 'BRIDGE_MIC', on: !myMic })}>{myMic ? 'Mic live · tap to mute' : 'Open my mic'}</button>
          <span className="small muted">Mic state is shared live. Audio itself rides Cloudflare Realtime once the media layer is connected.</span>
        </div>
        <div className="panel">
          <span className="label">Move from the bridge</span>
          <div className="grid" style={{ '--min': '130px' } as React.CSSProperties}>
            <Link className="btn sm" to="../green-room">To green room</Link>
            <Link className="btn sm" to="../stage-manager">Cue talent</Link>
            <Link className="btn sm" to="../bus">Offer stream to bus</Link>
            <Link className="btn sm" to="../networking">Side room</Link>
            <Link className="btn sm" to="../breakouts">Breakouts</Link>
          </div>
        </div>
        <div className="panel">
          <span className="label">Bridge log</span>
          <form className="row nowrap-row" onSubmit={async (e) => { e.preventDefault(); if (note.trim() && await send({ type: 'BRIDGE_LOG', text: note })) setNote(''); }}>
            <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Log a note for the crew" aria-label="Bridge note" />
            <button className="btn" type="submit">Log</button>
          </form>
          <div className="list small">
            {s.bridgeLog.slice(0, 10).map((b, i) => <div key={i} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: 8 }}><span className="mono muted">{clockTime(b.ts)}</span><span><b>{b.who}:</b> {b.text}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
