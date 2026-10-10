import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishTracks, subscribeTracks, answerSession, RealtimeError } from '../src/worker/realtime';
import type { Env } from '../src/worker/env';

const env = { REALTIME_APP_ID: 'app1', REALTIME_APP_SECRET: 'secret1' } as Env;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { url: string; method: string; auth: string | null; body: any }

/** Replace fetch with a scripted SFU. Each handler gets the request and returns a JSON body. */
function sfu(handler: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url), method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(handler(call)), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('publishing creates a session, sends the browser offer, and returns the SFU answer', async () => {
  const calls = sfu((c) => c.url.endsWith('/sessions/new')
    ? { sessionId: 'sess-pub' }
    : { sessionDescription: { type: 'answer', sdp: 'answer-sdp' }, tracks: [{ trackName: 'camera', mid: '0' }] });
  const out = await publishTracks(env, 'offer-sdp', [{ mid: '0', trackName: 'camera' }, { mid: '1', trackName: 'mic' }]);
  assert.deepEqual(out, { sessionId: 'sess-pub', answer: { type: 'answer', sdp: 'answer-sdp' } });
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/new');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Bearer secret1', 'the App Secret is sent only from the Worker');
  assert.equal(calls[1].url, 'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/sess-pub/tracks/new');
  assert.deepEqual(calls[1].body.sessionDescription, { type: 'offer', sdp: 'offer-sdp' });
  assert.deepEqual(calls[1].body.tracks, [
    { location: 'local', mid: '0', trackName: 'camera' },
    { location: 'local', mid: '1', trackName: 'mic' },
  ]);
});

test('subscribing pulls remote tracks from the publisher session and returns the SFU offer', async () => {
  const calls = sfu((c) => c.url.endsWith('/sessions/new')
    ? { sessionId: 'sess-sub' }
    : { sessionDescription: { type: 'offer', sdp: 'sfu-offer' } });
  const out = await subscribeTracks(env, 'sess-pub', ['camera', 'mic']);
  assert.deepEqual(out, { sessionId: 'sess-sub', offer: { type: 'offer', sdp: 'sfu-offer' } });
  assert.deepEqual(calls[1].body.tracks, [
    { location: 'remote', sessionId: 'sess-pub', trackName: 'camera' },
    { location: 'remote', sessionId: 'sess-pub', trackName: 'mic' },
  ]);
});

test('answering a subscription renegotiates the receiving session with the browser answer', async () => {
  const calls = sfu(() => ({}));
  await answerSession(env, 'sess-sub', 'browser-answer');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/apps/app1/sessions/sess-sub/renegotiate');
  assert.deepEqual(calls[0].body, { sessionDescription: { type: 'answer', sdp: 'browser-answer' } });
});

test('a 200 response with a failed track is an error, not a silent success', async () => {
  sfu((c) => c.url.endsWith('/sessions/new')
    ? { sessionId: 'sess-pub' }
    : { sessionDescription: { type: 'answer', sdp: 'a' }, tracks: [{ trackName: 'camera', errorCode: 'TRACK_NOT_FOUND' }] });
  await assert.rejects(
    publishTracks(env, 'offer', [{ mid: '0', trackName: 'camera' }]),
    (err: unknown) => err instanceof RealtimeError && err.status === 502 && /camera.*TRACK_NOT_FOUND/.test(err.message),
  );
});

test('an errorCode in the body is surfaced even when HTTP status is 200', async () => {
  sfu(() => ({ errorCode: 'BAD_SDP', errorDescription: 'bad offer' }));
  await assert.rejects(answerSession(env, 'sess-sub', 'x'), /BAD_SDP: bad offer/);
});

test('an HTTP failure from the SFU reports the status and does not leak the response body', async () => {
  sfu(() => ({ errorCode: 'UNAUTHORIZED', secret: 'should-not-appear' }), 401);
  await assert.rejects(answerSession(env, 'sess-sub', 'x'), (err: unknown) => {
    assert.ok(err instanceof RealtimeError);
    assert.equal(err.status, 502);
    assert.match(err.message, /401 UNAUTHORIZED/);
    assert.ok(!err.message.includes('should-not-appear'));
    return true;
  });
});

test('video is reported as not configured (503) when the app id or secret is missing', async () => {
  const calls = sfu(() => ({}));
  for (const missing of [{ REALTIME_APP_ID: 'app1' }, { REALTIME_APP_SECRET: 'secret1' }, {}]) {
    await assert.rejects(answerSession(missing as Env, 'sess', 'x'), (err: unknown) => err instanceof RealtimeError && err.status === 503);
  }
  assert.equal(calls.length, 0, 'no request leaves the Worker without credentials');
});

test('a sessions/new response without a session id is refused', async () => {
  sfu(() => ({}));
  await assert.rejects(publishTracks(env, 'offer', [{ mid: '0', trackName: 'camera' }]), /returned no session/);
});
