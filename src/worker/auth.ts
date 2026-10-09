import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from './env';

/** Who is calling, as established by Cloudflare Access (or dev sign-in locally). */
export interface Identity {
  email: string;
  name: string;
  /** Request arrived through the WARP client / Gateway. */
  warp: boolean;
  device: string;
  source: 'access' | 'dev';
  expiresAt: number;
}

interface AccessPayload extends JWTPayload {
  email?: string;
  common_name?: string; // service tokens
  identity_nonce?: string;
}

/** Fields we use from https://<team>/cdn-cgi/access/get-identity */
interface AccessIdentity {
  email?: string;
  name?: string;
  is_warp?: boolean;
  is_gateway?: boolean;
  device_id?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const identityCache = new Map<string, { at: number; id: AccessIdentity }>();
const IDENTITY_TTL_MS = 5 * 60_000;

export function devAuthEnabled(env: Env, req: Request): boolean {
  if (env.DEV_AUTH !== 'true') return false;
  const host = new URL(req.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function authenticate(req: Request, env: Env, freshPosture = false): Promise<Identity | null> {
  if (devAuthEnabled(env, req)) return devIdentity(req);

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new Error('ACCESS_TEAM_DOMAIN and ACCESS_AUD must be configured');
  }
  const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? readCookie(req, 'CF_Authorization');
  if (!token) return null;

  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }

  let payload: AccessPayload;
  try {
    ({ payload } = await jwtVerify<AccessPayload>(token, jwks, { issuer: `https://${team}`, audience: env.ACCESS_AUD }));
  } catch {
    return null;
  }

  const email = (payload.email ?? payload.common_name ?? '').toLowerCase();
  if (!email) return null;

  const ident = await accessIdentity(team, token, freshPosture);
  return {
    email,
    name: ident?.name || email.split('@')[0],
    warp: !!(ident?.is_warp || ident?.is_gateway),
    device: deviceLabel(req, ident?.device_id),
    source: 'access',
    expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now(),
  };
}

/** Device posture lives on the Access identity, not in the JWT. Cached per token. */
async function accessIdentity(team: string, token: string, fresh: boolean): Promise<AccessIdentity | null> {
  const key = token;
  const hit = identityCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.id;
  try {
    const res = await fetch(`https://${team}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${token}` },
    });
    if (!res.ok) return null;
    const id = (await res.json()) as AccessIdentity;
    identityCache.set(key, { at: Date.now(), id });
    if (identityCache.size > 5000) identityCache.clear();
    return id;
  } catch {
    return null;
  }
}

function devIdentity(req: Request): Identity | null {
  const raw = readCookie(req, 'dev_user');
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as { email: string; name: string; warp: boolean };
    if (!v.email) return null;
    return { email: v.email.toLowerCase(), name: v.name || v.email, warp: !!v.warp, device: deviceLabel(req), source: 'dev', expiresAt: Date.now() + 5 * 60_000 };
  } catch {
    return null;
  }
}

export function devCookie(email: string, name: string, warp: boolean): string {
  const v = encodeURIComponent(JSON.stringify({ email, name, warp }));
  return `dev_user=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function deviceLabel(req: Request, deviceId?: string): string {
  const ua = req.headers.get('user-agent') ?? '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Device';
  return deviceId ? `${os} · managed` : os;
}
