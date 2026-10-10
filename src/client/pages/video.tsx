import { useEffect, useRef, useState } from 'react';
import { api, toast, useEvent } from '../store';
import type { CallParticipant } from '../../shared/types';
import { Empty } from '../lib';
import { startSessionRecording, type SessionRecorder } from '../recorder';

/** STUN for candidate discovery. Media itself goes through the Cloudflare Realtime SFU. */
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

/** Resolve once ICE candidate gathering finishes, or after a short wait with the candidates found so far. */
function gatheredIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 4000);
  });
}

interface Remote { name: string; stream: MediaStream }

/** One video room for the event. Everyone in the event can join; each person publishes their camera and microphone. */
export function VideoRoom() {
  const { snap, send } = useEvent();
  const eventId = snap.state.id;
  const me = snap.me.email;
  const roster = snap.state.call;
  const mine = roster.find((p) => p.email === me);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Not connected');
  const [remotes, setRemotes] = useState<Record<string, Remote>>({});
  const [local, setLocal] = useState<MediaStream | null>(null);

  const localPc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const subscriptions = useRef(new Map<string, RTCPeerConnection>());
  const pending = useRef(new Set<string>());

  // Team recording. The room's state says whether a recording is running; this screen holds the recorder if it started it.
  const recorder = useRef<SessionRecorder | null>(null);
  const recordingRef = useRef<string | null>(null);
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;
  const active = snap.state.sessionRecordings?.call;
  const activeMine = active?.by === me;
  const liveStreams = () => [localStream.current, ...Object.values(remotesRef.current).map((r) => r.stream)]
    .filter((stream): stream is MediaStream => !!stream);

  /** Stop this screen's recorder, if it runs one. The room's recording state is not changed here. */
  const finishLocalRecording = async () => {
    const rec = recorder.current;
    recorder.current = null;
    await rec?.stop();
  };

  const startRecording = async () => {
    if (!window.confirm('Everyone in the room will see that this session is being recorded. Start recording?')) return;
    try {
      const { id } = await api<{ id: string }>(`/api/events/${eventId}/recordings`, { method: 'POST', json: { consent: true, title: 'Video room' } });
      recordingRef.current = id;
      recorder.current = startSessionRecording(eventId, id, liveStreams, (message) => {
        toast(`Recording stopped: ${message}`);
        void stopRecording();
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the recording');
    }
  };

  const stopRecording = async () => {
    const id = recordingRef.current;
    recordingRef.current = null;
    await finishLocalRecording();
    if (!id) return;
    try {
      await api(`/api/events/${eventId}/recordings/${id}/stop`, { method: 'POST' });
      toast('Recording saved. Crew can download it from Workspace → Team recordings.', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not stop the recording');
    }
  };

  // If the room reports that the recording stopped (for example, a producer ended it), stop this screen's recorder too.
  useEffect(() => {
    if (!active && recorder.current) { recordingRef.current = null; void finishLocalRecording(); }
    // finishLocalRecording only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** Stop every connection this screen opened. */
  const teardown = () => {
    localPc.current?.close();
    localPc.current = null;
    localStream.current?.getTracks().forEach((t) => t.stop());
    localStream.current = null;
    subscriptions.current.forEach((pc) => pc.close());
    subscriptions.current.clear();
    pending.current.clear();
    setLocal(null);
    setRemotes({});
  };

  // Leaving the screen (for example, leaving a breakout) also leaves the room on the server.
  const joinedRef = useRef(false);
  joinedRef.current = joined;
  useEffect(() => () => {
    if (recordingRef.current) void stopRecording();
    if (joinedRef.current) void api(`/api/events/${eventId}/calls/leave`, { method: 'POST' }).catch(() => undefined);
    teardown();
  }, []);

  const join = async () => {
    setBusy(true);
    setStatus('Starting camera and microphone…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      localStream.current = stream;
      setLocal(stream);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      localPc.current = pc;
      pc.onconnectionstatechange = () => setStatus(`Video: ${pc.connectionState}`);
      const sent = stream.getTracks().map((track) => ({
        trackName: track.kind === 'video' ? 'camera' : 'mic',
        transceiver: pc.addTransceiver(track, { direction: 'sendonly' }),
      }));
      await pc.setLocalDescription(await pc.createOffer());
      await gatheredIce(pc);
      setStatus('Connecting to the video room…');
      const res = await api<{ sessionId: string; answer: RTCSessionDescriptionInit }>(`/api/events/${eventId}/calls/publish`, {
        method: 'POST',
        json: { sdp: pc.localDescription?.sdp, tracks: sent.map((s) => ({ mid: s.transceiver.mid, trackName: s.trackName })) },
      });
      await pc.setRemoteDescription(res.answer);
      setJoined(true);
    } catch (e) {
      teardown();
      setStatus('Not connected');
      toast(e instanceof Error ? e.message : 'Could not join the video room');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      // Leaving the room ends this person's recording, so the file does not keep silent frames.
      if (recordingRef.current) await stopRecording();
      await api(`/api/events/${eventId}/calls/leave`, { method: 'POST' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not leave the video room');
    } finally {
      teardown();
      setJoined(false);
      setStatus('Not connected');
      setBusy(false);
    }
  };

  /** Receive one participant's tracks on their own receiving session. */
  const subscribe = async (p: CallParticipant) => {
    pending.current.add(p.sessionId);
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      subscriptions.current.set(p.sessionId, pc);
      const stream = new MediaStream();
      pc.ontrack = (ev) => {
        stream.addTrack(ev.track);
        setRemotes((r) => ({ ...r, [p.sessionId]: { name: p.name, stream } }));
      };
      const res = await api<{ sessionId: string; offer: RTCSessionDescriptionInit }>(`/api/events/${eventId}/calls/subscribe`, {
        method: 'POST',
        json: { publisherSessionId: p.sessionId, trackNames: p.tracks },
      });
      await pc.setRemoteDescription(res.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await gatheredIce(pc);
      await api(`/api/events/${eventId}/calls/answer`, { method: 'POST', json: { sessionId: res.sessionId, sdp: pc.localDescription?.sdp } });
    } catch (e) {
      subscriptions.current.get(p.sessionId)?.close();
      subscriptions.current.delete(p.sessionId);
      toast(e instanceof Error ? e.message : `Could not receive ${p.name}`);
    } finally {
      pending.current.delete(p.sessionId);
    }
  };

  // Keep receiving everyone else who is in the room, and stop receiving anyone who left.
  useEffect(() => {
    if (!joined) return;
    const present = new Set(roster.map((p) => p.sessionId));
    for (const p of roster) {
      if (p.email === me || subscriptions.current.has(p.sessionId) || pending.current.has(p.sessionId)) continue;
      void subscribe(p);
    }
    for (const [sessionId, pc] of subscriptions.current) {
      if (present.has(sessionId)) continue;
      pc.close();
      subscriptions.current.delete(sessionId);
      setRemotes((r) => { const next = { ...r }; delete next[sessionId]; return next; });
    }
    // subscribe reads the latest roster from props each time this effect runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, roster]);

  // The room's own state can drop us (for example, after a membership change).
  useEffect(() => {
    if (joined && !mine) { teardown(); setJoined(false); setStatus('Left the video room'); }
  }, [joined, mine]);

  const others = roster.filter((p) => p.email !== me);

  return (
    <div className="stack loose">
      <div className="stack tight">
        <h1>Video room</h1>
        <span className="muted">Camera and microphone for everyone in the event, carried by Cloudflare Realtime.</span>
      </div>

      <div className="panel stack">
        <div className="row between nowrap-row">
          <div className="stack tight" style={{ gap: 2 }}>
            <b>{joined ? 'You are in the video room' : 'Join the video room'}</b>
            <span className="small muted">{status} · {roster.length} {roster.length === 1 ? 'person' : 'people'} in the room</span>
          </div>
          {joined
            ? <button className="btn danger" onClick={leave} disabled={busy}>Leave</button>
            : <button className="btn primary" onClick={join} disabled={busy}>{busy ? 'Connecting…' : 'Join with camera'}</button>}
        </div>
      </div>

      {joined && (
        <div className="panel stack tight">
          <div className="row between nowrap-row">
            <div className="stack tight" style={{ gap: 2 }}>
              {active
                ? <span className="pill live">● Recording · {activeMine ? 'you started it' : `started by ${active.by}`}</span>
                : <b>Not recording</b>}
              <span className="small muted">Everyone in the room sees when a recording is running. Parts are uploaded while the session runs.</span>
            </div>
            {!active && <button className="btn" onClick={startRecording}>Record this session</button>}
            {active && activeMine && <button className="btn danger" onClick={stopRecording}>Stop recording</button>}
          </div>
        </div>
      )}

      <div className="grid" style={{ '--min': '260px' } as React.CSSProperties}>
        {local && <Tile name="You" stream={local} muted />}
        {Object.entries(remotes).map(([id, r]) => <Tile key={id} name={r.name} stream={r.stream} />)}
      </div>
      {!local && !Object.keys(remotes).length && <Empty>Nobody is on camera yet.</Empty>}
      {others.length > 0 && (
        <span className="small muted">In the room: {others.map((p) => p.name).join(', ')}</span>
      )}
      <span className="small muted">Your camera is shared only inside this event. Turn it off by leaving the room.</span>
      {mine && !joined && <span className="small muted">Join again to re-publish your camera.</span>}
      <SessionRecordings eventId={eventId} stateKey={active?.recordingId ?? 'idle'} />
    </div>
  );
}

interface RecordingItem { id: string; title: string; status: 'recording' | 'ready'; startedBy: string; startedAt: number }

/** Recordings of this event that this person may see: all of them for crew, their own otherwise. */
function SessionRecordings({ eventId, stateKey }: { eventId: string; stateKey: string }) {
  const [list, setList] = useState<RecordingItem[]>([]);
  useEffect(() => {
    api<RecordingItem[]>(`/api/events/${eventId}/recordings`).then(setList).catch(() => setList([]));
  }, [eventId, stateKey]);
  if (!list.length) return null;
  return (
    <div className="panel stack tight">
      <span className="label">Recordings</span>
      {list.map((r) => (
        <div key={r.id} className="row between nowrap-row">
          <span className="small"><b>{r.title}</b> · {new Date(r.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {r.startedBy}</span>
          {r.status === 'ready'
            ? <a className="btn sm" href={`/api/events/${eventId}/recordings/${r.id}/media`} download>Download</a>
            : <span className="pill warn">Recording</span>}
        </div>
      ))}
    </div>
  );
}

function Tile({ name, stream, muted = false }: { name: string; stream: MediaStream; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) { ref.current.srcObject = stream; void ref.current.play().catch(() => undefined); }
  }, [stream]);
  return (
    <div className="panel stack tight" style={{ padding: 8 }}>
      <video ref={ref} autoPlay playsInline muted={muted} aria-label={`${name}'s video`} style={{ width: '100%', borderRadius: 6, background: '#000' }} />
      <span className="small">{name}</span>
    </div>
  );
}
