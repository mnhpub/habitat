import type { Env } from './env';

/** Cloudflare Realtime SFU Connection API. The App Secret stays on the Worker. */
const BASE = 'https://rtc.live.cloudflare.com/v1';

/** An SDP offer or answer, as the SFU sends and receives it. */
export interface Sdp { type: 'offer' | 'answer'; sdp: string }

export class RealtimeError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

interface TrackResult { trackName?: string; mid?: string; sessionId?: string; errorCode?: string; errorDescription?: string }
interface SfuResponse { sessionId?: string; sessionDescription?: Sdp; tracks?: TrackResult[]; errorCode?: string; errorDescription?: string }

async function sfu(env: Env, method: 'POST' | 'PUT', path: string, body?: unknown): Promise<SfuResponse> {
  if (!env.REALTIME_APP_ID || !env.REALTIME_APP_SECRET) {
    throw new RealtimeError('Video is not configured. Set REALTIME_APP_ID and REALTIME_APP_SECRET for this Worker.', 503);
  }
  const res = await fetch(`${BASE}/apps/${env.REALTIME_APP_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.REALTIME_APP_SECRET}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as SfuResponse;
  if (!res.ok) throw new RealtimeError(`Realtime request failed (${res.status}${json.errorCode ? ` ${json.errorCode}` : ''})`, 502);
  if (json.errorCode) throw new RealtimeError(`Realtime error ${json.errorCode}: ${json.errorDescription ?? ''}`.trim(), 502);
  // A 200 does not mean every track succeeded; check each result.
  const failed = json.tracks?.find((t) => t.errorCode);
  if (failed) throw new RealtimeError(`Realtime track ${failed.trackName ?? ''} failed: ${failed.errorCode}`, 502);
  return json;
}

async function createSession(env: Env): Promise<string> {
  const res = await sfu(env, 'POST', '/sessions/new');
  if (!res.sessionId) throw new RealtimeError('Realtime returned no session', 502);
  return res.sessionId;
}

/** Create a session and publish the browser's camera and microphone tracks into it. */
export async function publishTracks(env: Env, sdp: string, tracks: { mid: string; trackName: string }[]): Promise<{ sessionId: string; answer: Sdp }> {
  const sessionId = await createSession(env);
  const res = await sfu(env, 'POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: { type: 'offer', sdp },
    tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
  });
  if (!res.sessionDescription) throw new RealtimeError('Realtime returned no answer', 502);
  return { sessionId, answer: res.sessionDescription };
}

/** Create a receiving session that subscribes to another person's published tracks. Returns the SFU's offer. */
export async function subscribeTracks(env: Env, publisherSessionId: string, trackNames: string[]): Promise<{ sessionId: string; offer: Sdp }> {
  const sessionId = await createSession(env);
  const res = await sfu(env, 'POST', `/sessions/${sessionId}/tracks/new`, {
    tracks: trackNames.map((trackName) => ({ location: 'remote', sessionId: publisherSessionId, trackName })),
  });
  if (!res.sessionDescription) throw new RealtimeError('Realtime returned no offer', 502);
  return { sessionId, offer: res.sessionDescription };
}

/** Return the browser's answer to an SFU offer for a receiving session. */
export async function answerSession(env: Env, sessionId: string, sdp: string): Promise<void> {
  await sfu(env, 'PUT', `/sessions/${sessionId}/renegotiate`, { sessionDescription: { type: 'answer', sdp } });
}
