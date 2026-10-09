import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { authenticate } from '../src/worker/auth';

test('fresh production authentication bypasses cached Access device posture', async () => {
  const team = 'auth-regression.cloudflareaccess.com';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'regression', alg: 'RS256', use: 'sig' };
  const expiry = Math.floor(Date.now() / 1000) + 60;
  const token = await new SignJWT({ email: 'crew@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'regression' })
    .setIssuer(`https://${team}`).setAudience('app').setSubject('crew').setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  const originalFetch = globalThis.fetch;
  let warp = true;
  let identityRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/certs')) return Response.json({ keys: [jwk] });
    if (url.includes('/get-identity')) { identityRequests++; return Response.json({ name: 'Crew', is_warp: warp }); }
    throw new Error('Unexpected external request in auth test');
  };
  try {
    const env = { DEV_AUTH: 'false', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'app' };
    const req = new Request('https://events.example.com/api/events/ev/commands', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    assert.equal((await authenticate(req, env as never))!.warp, true);
    warp = false;
    assert.equal((await authenticate(req, env as never, true))!.warp, false);
    assert.equal(identityRequests, 2);
    assert.equal((await authenticate(req, env as never))!.expiresAt, expiry * 1000);
  } finally { globalThis.fetch = originalFetch; }
});
