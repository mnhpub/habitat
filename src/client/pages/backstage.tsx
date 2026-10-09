import { useEffect, useRef, useState } from 'react';
import { useEvent, useTick } from '../store';
import { clockTime, Empty, fmtCountdown, fmtTau, Icon, ICONS, Person } from '../lib';
import { Monitor } from './production';
import type { EventView, Talent } from '../../shared/types';

const lastName = (n: string) => n.split(' ').slice(-1)[0];
const srcLabel = (s: EventView, id: string) => s.sources.find((x) => x.id === id)?.label ?? id;

/** The talent record for the signed-in person, or a picker for crew. */
function useMyTalent(): [Talent | undefined, (id: string) => void] {
  const { snap } = useEvent();
  const s = snap.state;
  const linked = s.talent.find((t) => t.email === snap.me.email);
  const [picked, setPicked] = useState<string>(() => localStorage.getItem(`talent:${s.id}`) ?? '');
  const t = linked ?? s.talent.find((x) => x.id === picked) ?? undefined;
  return [t, (id: string) => { setPicked(id); try { localStorage.setItem(`talent:${s.id}`, id); } catch { /* storage unavailable */ } }];
}

function TalentPicker({ value, onPick }: { value?: string; onPick: (id: string) => void }) {
  const { snap } = useEvent();
  return (
    <label className="fieldlabel" style={{ maxWidth: 320 }}>Speaker
      <select className="field" value={value ?? ''} onChange={(e) => onPick(e.target.value)}>
        <option value="" disabled>Choose who you are…</option>
        {snap.state.talent.map((t) => <option key={t.id} value={t.id}>{t.name}{t.email ? ' · linked' : ''}</option>)}
      </select>
    </label>
  );
}

/** The talent's own segment cues: those whose detail names them. */
function cuesFor(s: EventView, t: Talent) {
  return s.cues.filter((c) => c.detail.includes(lastName(t.name)) || c.title.includes(lastName(t.name)));
}

// ======================================================================= Green room (desktop)

interface PreflightResult { camera: boolean; mic: boolean; level: number; network: string }

async function runPreflight(video: HTMLVideoElement | null): Promise<PreflightResult & { stream?: MediaStream }> {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
  } catch {
    return { camera: false, mic: false, level: 0, network: 'unknown' };
  }
  if (video) { video.srcObject = stream; video.muted = true; await video.play().catch(() => undefined); }
  const camera = stream.getVideoTracks().some((t) => t.readyState === 'live');
  // Listen to the mic for a moment and keep the loudest level.
  let peak = 0;
  try {
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const until = performance.now() + 1500;
    while (performance.now() < until) {
      an.getByteTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      await new Promise((r) => setTimeout(r, 50));
    }
    await ctx.close();
  } catch { /* no audio context */ }
  const mic = stream.getAudioTracks().some((t) => t.readyState === 'live');
  const conn = (navigator as Navigator & { connection?: { downlink?: number; rtt?: number } }).connection;
  const network = conn?.downlink ? `${conn.downlink} Mbps · ${conn.rtt ?? '?'} ms` : 'measured by event server';
  return { camera, mic, level: peak, network, stream };
}

export function GreenRoom() {
  const { snap, send, store } = useEvent();
  useTick(500);
  const s = snap.state;
  const [t, pick] = useMyTalent();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [talking, setTalking] = useState(false);

  useEffect(() => () => streamRef.current?.getTracks().forEach((x) => x.stop()), []);

  const check = async () => {
    if (!t) return;
    setChecking(true);
    const r = await runPreflight(videoRef.current);
    if (r.stream) { streamRef.current?.getTracks().forEach((x) => x.stop()); streamRef.current = r.stream; }
    setResult(r);
    setChecking(false);
    await send({ type: 'PREFLIGHT_REPORT', talentId: t.id, camera: r.camera, mic: r.mic && r.level > 0.01, network: r.network });
  };

  const talk = (on: boolean) => { setTalking(on); send({ type: 'BRIDGE_MIC', on }); };

  if (!t) return <div className="panel" style={{ maxWidth: 520 }}><h2>Green room</h2><span className="muted">Pick the speaker you are (crew can pick anyone to check them in).</span><TalentPicker onPick={pick} /></div>;

  const mine = cuesFor(s, t);
  const next = mine.find((c) => c.status === 'pending');
  const tau = store.now() - s.epoch;
  const banner = t.state === 'live'
    ? { cls: 'pgmp', tag: 'ON AIR', title: `You're live — ${s.cues.find((c) => c.status === 'live')?.title ?? 'on stage'}`, sub: 'The director controls your shot. Talk naturally.' }
    : t.state === 'standby'
      ? { cls: 'warnp', tag: 'STANDBY', title: `You're on ${next ? `in ${fmtCountdown(next.at - tau)} — ${next.title}` : 'next'}`, sub: 'Stay put. The stage manager cues you and the director takes you live — no link to click.' }
      : t.state === 'ready'
        ? { cls: 'okp', tag: 'READY', title: 'Preflight passed — you are ready', sub: 'The stage manager will put you on standby before your segment.' }
        : { cls: '', tag: t.state.toUpperCase(), title: 'Run your preflight', sub: 'It checks your camera, mic and connection and tells the crew — no manual check needed.' };

  return (
    <div className="cols">
      <div className="main-col stack">
        <div className="row between"><div className="row"><h1>{t.greenRoom}</h1><span className="pill ok"><Icon d={ICONS.shield} size={14} />{t.name} · verified presenter</span></div>{snap.me.roles.some((r) => r !== 'talent') && <TalentPicker value={t.id} onPick={pick} />}</div>
        <div className={`panel ${banner.cls}`}>
          <div className="row nowrap-row"><span className="pill square" style={{ fontSize: 13 }}>{banner.tag}</span><div className="stack tight"><b style={{ fontSize: 16 }}>{banner.title}</b><span className="small muted">{banner.sub}</span></div></div>
        </div>
        <div className="monitor" style={{ borderWidth: 1 }}>
          <video ref={videoRef} playsInline muted style={{ display: result?.camera ? 'block' : 'none' }} />
          {!result?.camera && <Person size={140} />}
          <span className="tag tl">Self view · as the audience will see you</span>
          {result && <span className="tag tr mono">mic peak {(result.level * 100).toFixed(0)}%</span>}
        </div>
        <div className="row">
          <button className="btn lg primary" onClick={check} disabled={checking}>{checking ? 'Checking camera and mic…' : t.preflight ? 'Run preflight again' : 'Run preflight'}</button>
          <span className="small muted">Your browser will ask for camera and microphone access.</span>
        </div>
        <div className="panel">
          <div className="row between"><span className="label">Automatic preflight</span><span className="small muted">{t.preflight ? `Reported ${clockTime(t.preflight.checkedAt)}` : 'Not run yet'}</span></div>
          <div className="grid" style={{ '--min': '200px' } as React.CSSProperties}>
            {[
              { n: 'Camera', ok: t.preflight?.camera, v: t.preflight ? (t.preflight.camera ? 'Working' : 'Not found') : '—' },
              { n: 'Microphone', ok: t.preflight?.mic, v: t.preflight ? (t.preflight.mic ? 'Hearing you' : 'No signal') : '—' },
              { n: 'Network', ok: !!t.preflight, v: t.preflight?.network ?? '—' },
              { n: 'Event clock offset', ok: Math.abs(store.offsetMs) < 50, v: `${store.offsetMs.toFixed(1)} ms` },
            ].map((c) => (
              <div key={c.n} className="well row nowrap-row">
                <span style={{ color: c.ok ? 'var(--ok)' : c.ok === false ? 'var(--warn)' : 'var(--dim)' }}><Icon d={ICONS.check} size={16} stroke={2.6} /></span>
                <span className="stack tight" style={{ gap: 1 }}><b style={{ fontSize: 13 }}>{c.n}</b><span className="small muted mono">{c.v}</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="side-col stack">
        <div className="panel"><div className="row between"><span className="label pgm">Stage return · program</span><span className="small muted">Muted to you</span></div><Monitor kind="pgm" label={srcLabel(s, s.production.programId)} /></div>
        <div className="panel">
          <span className="label">From the crew</span>
          <div className="list small">{s.bridgeLog.slice(0, 3).map((b, i) => <div key={i}><span className="muted">{b.who} · {clockTime(b.ts)}</span><div>{b.text}</div></div>)}</div>
          <button className={`btn lg ${talking ? 'warn-fill' : 'accent'}`} onPointerDown={() => talk(true)} onPointerUp={() => talk(false)} onPointerLeave={() => talking && talk(false)}>Hold to talk to stage manager</button>
        </div>
        <div className="panel">
          <span className="label">Your segment</span>
          {mine.length ? <div className="list small">{mine.map((c) => <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '70px minmax(0,1fr)', gap: 8 }}><span className="mono accent">{fmtTau(c.at)}</span><span>{c.title} <span className="muted">· {c.status}</span></span></div>)}</div> : <Empty>No segment assigned yet.</Empty>}
        </div>
        <div className="panel">
          <span className="label">Also in {t.greenRoom}</span>
          <div className="list small">{s.talent.filter((o) => o.greenRoom === t.greenRoom && o.id !== t.id).map((o) => <div key={o.id} className="row between"><span>{o.name}</span><span className="muted">{o.state}</span></div>)}</div>
        </div>
      </div>
    </div>
  );
}

// ======================================================================= Talent (iPhone)

const PROMPTER = [
  'Thank you, Marcus. It is a pleasure to be here with everyone in the room and online.',
  'When we stopped treating remote speakers as guests on a call, and started treating them as part of the stage, everything changed.',
  'Ife, you saw this first-hand in Lagos last spring —',
  'The quality has to be good enough that nobody notices it.',
  'Which means the crew is directing the show, not juggling calls.',
];

export function TalentPhone() {
  const { snap, send, store } = useEvent();
  useTick(500);
  const s = snap.state;
  const [t, pick] = useMyTalent();
  const [line, setLine] = useState(1);
  const [cough, setCough] = useState(false);
  const [talking, setTalking] = useState(false);
  if (!t) return <div className="device panel"><h2>Talent</h2><TalentPicker onPick={pick} /></div>;
  const live = s.cues.find((c) => c.status === 'live');
  const remaining = live ? live.at + live.durationMs - (store.now() - s.epoch) : 0;
  const head = t.state === 'live' ? { bg: 'var(--pgm-fill)', text: 'YOU ARE ON AIR' } : t.state === 'standby' ? { bg: 'var(--warn)', text: 'STANDBY' } : { bg: '#1E232A', text: t.state === 'ready' ? 'READY · OFF AIR' : 'OFF AIR' };
  const talk = (on: boolean) => { setTalking(on); send({ type: 'BRIDGE_MIC', on }); };

  return (
    <div className="device">
      <div className="row between" style={{ background: head.bg, color: t.state === 'standby' ? '#1A1406' : '#fff', padding: '14px 16px', borderRadius: 14 }}>
        <div className="stack tight" style={{ gap: 2 }}><b style={{ letterSpacing: '.12em', fontSize: 12 }}>{head.text}</b><span style={{ fontSize: 15 }}>{live?.title ?? 'Main Stage'}</span></div>
        <span className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{live && t.state === 'live' ? fmtCountdown(remaining) : '—'}</span>
      </div>
      <div className="row nowrap-row">
        <div style={{ flex: 1 }}><Monitor kind="pgm" label="Program" /></div>
        <div className="stack tight small" style={{ flex: 1 }}>
          <span className="ok">IFB · mix-minus</span>
          <span className={cough ? 'warn' : 'ok'}>{cough ? 'Mic held (cough)' : 'Mic live'}</span>
          <span className="muted">Next: {s.cues.find((c) => c.status === 'pending')?.title ?? '—'}</span>
        </div>
      </div>
      <div className="panel" style={{ minHeight: 240 }}>
        <div className="row between"><span className="label">Prompter</span><span className="small muted">Line {line + 1} / {PROMPTER.length}</span></div>
        {line > 0 && <p style={{ margin: 0, color: '#5E6875' }}>{PROMPTER[line - 1]}</p>}
        <p style={{ margin: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.35, borderLeft: '3px solid var(--accent)', paddingLeft: 12 }}>{PROMPTER[line]}</p>
        {line < PROMPTER.length - 1 && <p style={{ margin: 0, color: 'var(--muted)', fontSize: 17 }}>{PROMPTER[line + 1]}</p>}
        <div className="row"><button className="btn sm" onClick={() => setLine(Math.max(0, line - 1))}>Back</button><button className="btn sm" onClick={() => setLine(Math.min(PROMPTER.length - 1, line + 1))}>Next line</button></div>
      </div>
      {s.bridgeLog[0] && <div className="panel" style={{ background: 'var(--panel-2)' }}><span className="small muted">{s.bridgeLog[0].who} · {clockTime(s.bridgeLog[0].ts)}</span><span>{s.bridgeLog[0].text}</span></div>}
      <div className="row nowrap-row">
        <button className={`btn xl ${cough ? 'warn-fill' : ''}`} style={{ flex: 1 }} onPointerDown={() => setCough(true)} onPointerUp={() => setCough(false)} onPointerLeave={() => setCough(false)}>Hold · cough</button>
        <button className={`btn xl ${talking ? 'warn-fill' : 'accent'}`} style={{ flex: 1.4 }} onPointerDown={() => talk(true)} onPointerUp={() => talk(false)} onPointerLeave={() => talking && talk(false)}>Hold to talk · SM</button>
      </div>
    </div>
  );
}

// ======================================================================= Stage manager (iPhone)

const STATE_COLOR: Record<string, string> = { live: 'var(--pgm-ink)', standby: 'var(--warn)', ready: 'var(--ok-ink)' };

export function StageManager() {
  const { snap, send, store } = useEvent();
  useTick(500);
  const s = snap.state;
  const next = s.cues.find((c) => c.status === 'pending');
  const live = s.cues.find((c) => c.status === 'live');
  const tau = store.now() - s.epoch;
  const forCue = next ? s.talent.filter((t) => next.detail.includes(lastName(t.name)) || t.state === 'live') : s.talent;
  const [msg, setMsg] = useState('');
  const [mic, setMic] = useState(false);

  return (
    <div className="device">
      <div className="row between">
        <div className="stack tight" style={{ gap: 2 }}><span className="small muted">Stage manager · Main Stage</span><h2 style={{ fontSize: 22 }}>{next ? next.title : 'Show complete'}</h2></div>
        <span className="mono warn" style={{ fontSize: 26, fontWeight: 600 }}>{next ? fmtCountdown(next.at - tau) : '—'}</span>
      </div>
      <div className="row small">{live && <span className="pill square pgm">NOW · {live.title}</span>}{next && <span className="pill square ok">NEXT · {fmtTau(next.at)}</span>}</div>
      <span className="label">Talent for this cue</span>
      {forCue.map((t) => (
        <div key={t.id} className="panel" style={{ padding: 12 }}>
          <div className="row between"><div className="stack tight" style={{ gap: 2 }}><b style={{ fontSize: 15 }}>{t.name}</b><span className="small muted">{t.greenRoom} · {t.preflight ? (t.preflight.camera && t.preflight.mic ? 'preflight passed' : 'preflight failed') : 'no preflight'}</span></div>
            <span className="pill square" style={{ color: STATE_COLOR[t.state] ?? 'var(--muted)', borderColor: STATE_COLOR[t.state] ?? 'var(--line-2)' }}>{t.state.toUpperCase()}</span></div>
          <div className="row nowrap-row">
            <button className="btn warn" style={{ flex: 1 }} onClick={() => send({ type: 'SET_TALENT_STATE', talentId: t.id, state: 'standby' })} disabled={t.state === 'live'}>Standby</button>
            <button className="btn" style={{ flex: 1 }} onClick={() => send({ type: 'SET_TALENT_STATE', talentId: t.id, state: 'ready' })} disabled={t.state === 'live'}>Ready</button>
            <button className="btn" style={{ flex: 1 }} onClick={() => send({ type: 'BRIDGE_LOG', text: `${lastName(t.name)}: check your return feed` })}>Nudge</button>
          </div>
        </div>
      ))}
      <form className="row nowrap-row" onSubmit={async (e) => { e.preventDefault(); if (msg.trim() && await send({ type: 'BRIDGE_LOG', text: msg })) setMsg(''); }}>
        <input className="field" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message talent & crew" aria-label="Message" /><button className="btn" type="submit">Send</button>
      </form>
      <div className="panel" style={{ background: 'var(--bar)' }}>
        <span className="small muted">Talent ready → director takes them live. You never move a video call.</span>
        <button className="btn xl warn-fill" onClick={() => send({ type: 'STANDBY_CUE' })} disabled={!next}>STANDBY ALL{next ? ` · ${next.title.split(':')[0]}` : ''}</button>
        <div className="row nowrap-row">
          <button className="btn" style={{ flex: 1 }} onClick={() => send({ type: 'FIRE_NEXT_CUE' })} disabled={!next}>Fire cue</button>
          <button className={`btn ${mic ? 'warn-fill' : ''}`} style={{ flex: 1 }} onClick={() => { setMic(!mic); send({ type: 'BRIDGE_MIC', on: !mic }); }}>{mic ? 'Talkback on' : 'Talkback'}</button>
          <button className="btn danger" style={{ flex: 1 }} onClick={() => send({ type: 'SET_HOLD', on: !s.production.hold })}>{s.production.hold ? 'Release hold' : 'Hold show'}</button>
        </div>
      </div>
    </div>
  );
}

// ======================================================================= Camera operator (iPhone)

export function CameraOp() {
  const { snap, store } = useEvent();
  useTick(250);
  const s = snap.state;
  const cams = s.sources.filter((x) => x.kind === 'camera' || x.kind === 'room');
  const [camId, setCamId] = useState(cams[1]?.id ?? cams[0]?.id ?? '');
  const videoRef = useRef<HTMLVideoElement>(null);
  const [usingCam, setUsingCam] = useState(false);
  const pgm = s.production.programId === camId;
  const pvw = s.production.previewId === camId;
  const cam = s.sources.find((x) => x.id === camId);
  const tau = store.now() - s.epoch;
  const frames = Math.floor(((tau % 1000) / 1000) * 30);

  const useCamera = async () => {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      if (videoRef.current) { videoRef.current.srcObject = st; await videoRef.current.play(); }
      setUsingCam(true);
    } catch { setUsingCam(false); }
  };

  return (
    <div className="device" style={{ background: '#000', padding: 8, borderRadius: 18, border: `6px solid ${pgm ? '#FF3B41' : pvw ? '#2FBF71' : '#262C34'}` }}>
      <div className="row between">
        <span className="pill" style={{ background: pgm ? 'var(--pgm-fill)' : pvw ? '#1A7F4B' : '#262C34', color: '#fff', fontWeight: 700, borderRadius: 6, borderColor: 'transparent' }}>{cam?.label.split('·')[0].trim()} · {pgm ? 'ON AIR' : pvw ? 'PREVIEW' : 'STANDBY'}</span>
        <span className="mono small muted">TC {fmtTau(tau)}:{String(frames).padStart(2, '0')}</span>
      </div>
      <div className="monitor" style={{ aspectRatio: '3 / 4', background: '#11161C' }}>
        <video ref={videoRef} playsInline muted style={{ display: usingCam ? 'block' : 'none' }} />
        {!usingCam && <Person size={140} />}
        <div style={{ position: 'absolute', inset: '10%', border: '1px dashed rgba(236,238,241,.35)' }} />
        {s.bridgeLog[0] && <div className="tag" style={{ left: 10, right: 10, bottom: 10 }}><div className="small muted">{s.bridgeLog[0].who}</div><div>{s.bridgeLog[0].text}</div></div>}
      </div>
      <div className="grid mono small center" style={{ '--min': '70px' } as React.CSSProperties}>
        {[['ISO', '400'], ['SHUTTER', '1/120'], ['WB', '4300K'], ['LENS', '2×']].map(([k, v]) => <div key={k} className="well"><div className="dim" style={{ fontSize: 10 }}>{k}</div>{v}</div>)}
      </div>
      <div className="row nowrap-row">
        <select className="field" value={camId} onChange={(e) => setCamId(e.target.value)} aria-label="Camera">{cams.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        {!usingCam && <button className="btn" onClick={useCamera}>Use this camera</button>}
      </div>
      <span className="small muted">Tally follows the live program from the event server.</span>
    </div>
  );
}
