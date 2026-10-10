// Signed tokens for links in email. The unsubscribe token is public (anyone with the link can opt out),
// so it carries only an email address and a workspace, and a signature the Worker checks.

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array {
  const s = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signUnsubscribe(secret: string, email: string, orgId: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify({ e: email, o: orgId })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyUnsubscribe(secret: string, token: string): Promise<{ email: string; orgId: string } | null> {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || token.length > 1024) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromB64url(sig), encoder.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { e?: unknown; o?: unknown };
    if (typeof data.e !== 'string' || typeof data.o !== 'string') return null;
    return { email: data.e, orgId: data.o };
  } catch {
    return null;
  }
}

/** Random, unguessable token for calendar feeds. */
export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}
