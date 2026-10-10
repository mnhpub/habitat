import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import app from '../../src/worker/index';
import { devCookie } from '../../src/worker/auth';
import { fixture } from './room';
import type { Actor } from '../../src/shared/types';

/** Every migration, in order, applied to a fresh in-memory SQLite database. */
export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  return db;
}

/** D1 surface the Worker uses, backed by SQLite. `batch` runs in order; the Node adapter has no real transactions. */
export function d1(db: DatabaseSync) {
  return {
    prepare(query: string) {
      let args: any[] = [];
      const statement = {
        bind(...values: any[]) { args = values; return statement; },
        async all<T = any>() { return { results: db.prepare(query).all(...args) as T[] }; },
        async first<T = any>() { return (db.prepare(query).get(...args) as T | undefined) ?? null; },
        async run() {
          const r = db.prepare(query).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

export function platform(options: { mail?: boolean } = {}) {
  const db = migratedDatabase();
  const rooms = new Map<string, ReturnType<typeof fixture>>();
  const parts = new Map<string, Uint8Array>();
  const outbox: { to: string; subject: string; text: string; html: string; headers?: Record<string, string> }[] = [];
  const pending: Promise<unknown>[] = [];
  const env: Record<string, any> = {
    DEV_AUTH: 'true',
    REQUIRE_WARP_FOR_PRODUCTION: 'true',
    PUBLIC_URL: 'https://habitat.test',
    DB: d1(db),
    RECORDINGS: {
      async put(key: string, body: ArrayBuffer) { parts.set(key, new Uint8Array(body)); },
      async get(key: string) {
        const bytes = parts.get(key);
        return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
      },
      async delete(key: string) { parts.delete(key); },
    },
    EVENTS: {
      idFromName: (id: string) => id,
      get(id: string) {
        if (!rooms.has(id)) {
          const f = fixture();
          (f.room as any).env = env;
          rooms.set(id, f);
        }
        return rooms.get(id)!.room;
      },
    },
  };
  if (options.mail !== false) {
    env.EMAIL = {
      async send(message: any) {
        if (String(message.to).endsWith('@bounce.test')) throw new Error('mailbox unavailable');
        outbox.push({ to: message.to, subject: message.subject, text: message.text, html: message.html, headers: message.headers });
        return { messageId: `m${outbox.length}` };
      },
    };
    env.MAIL_FROM = 'events@habitat.test';
    env.UNSUBSCRIBE_SECRET = 'test-secret-value-for-hmac';
  }

  const request = (path: string, init: RequestInit = {}, email = 'org@example.com', warp = true) => app.fetch(new Request(`http://localhost${path}`, {
    ...init,
    headers: { cookie: devCookie(email, email.split('@')[0], warp).split(';')[0], ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: (init as { json?: unknown }).json !== undefined ? JSON.stringify((init as { json?: unknown }).json) : init.body,
  }), env as never, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as never);

  /** Let background work started with waitUntil finish (campaign sends). */
  const drain = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };

  const actor = (email: string, roles: Actor['roles'], warp = true): Actor => ({ email, name: email.split('@')[0], roles, warp });
  const room = (id: string) => env.EVENTS.get(id);

  return { db, env, rooms, outbox, parts, request, drain, actor, room };
}

export type Platform = ReturnType<typeof platform>;
export const json = <T = any>(res: Response): Promise<T> => res.json() as Promise<T>;
