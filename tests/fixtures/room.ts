import { DatabaseSync } from 'node:sqlite';
import type { Actor, Role } from '../../src/shared/types';
import { EventRoom } from '../../src/worker/event-room';

export const organizer: Actor = { email: 'org@example.com', name: 'Organizer', roles: ['organizer'], warp: true };

export function fixture() {
  const db = new DatabaseSync(':memory:');
  const sockets: ReturnType<typeof socket>[] = [];
  let failSnapshot = false;
  let failMetadata = false;
  let metadata = { name: 'Original', venue: '' };
  const members = new Map<string, Role[]>([[organizer.email, ['organizer']]]);
  const ctx = {
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
    getWebSockets: () => sockets,
    storage: {
      sql: {
        exec(query: string, ...args: unknown[]) {
          if (failSnapshot && /INSERT INTO snapshot/.test(query)) throw new Error('snapshot storage failed');
          const stmt = db.prepare(query);
          const rows = stmt.all(...args as never[]);
          return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      transactionSync<T>(fn: () => T) {
        db.exec('SAVEPOINT room_test');
        try { const value = fn(); db.exec('RELEASE room_test'); return value; }
        catch (error) { db.exec('ROLLBACK TO room_test; RELEASE room_test'); throw error; }
      },
      setAlarm: async (_at: number) => {},
      deleteAlarm: async () => {},
    },
  };
  const env = {
    REQUIRE_WARP_FOR_PRODUCTION: 'true',
    DB: {
      prepare(query: string) {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async first() { return { join_open: 0, roles: members.has(String(args[0])) ? JSON.stringify(members.get(String(args[0]))) : null }; },
          async run() {
            if (failMetadata) throw new Error('metadata database unavailable');
            metadata = { name: String(args[0]), venue: String(args[1]) };
            return { success: true };
          },
        };
      },
    },
  };
  const room = new EventRoom(ctx as never, env as never);
  return {
    room, db, sockets, members,
    setFailSnapshot: (fail: boolean) => { failSnapshot = fail; },
    setFailMetadata: (fail: boolean) => { failMetadata = fail; },
    metadata: () => metadata,
    socket(actor: Actor) { const ws = socket(actor); sockets.push(ws); return ws; },
  };
}

function socket(actor: Actor) {
  let attachment = { actor, since: Date.now(), expiresAt: Date.now() + 60_000 };
  const sent: Record<string, any>[] = [];
  let closed = false;
  return {
    sent,
    get closed() { return closed; },
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: (next: typeof attachment) => { attachment = structuredClone(next); },
    send: (json: string) => { sent.push(JSON.parse(json)); },
    close: (_code?: number) => { closed = true; },
  };
}
