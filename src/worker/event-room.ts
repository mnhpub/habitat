import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { apply, authorize, CommandError, fireNextCue, WARP_COMMANDS } from '../shared/reducer';
import { parseCommand } from '../shared/command';
import { resolveActor } from './membership';
import { MAX_SNAPSHOT_BYTES, snapshotChunks, writeSnapshot } from './snapshot-storage';
import { seedEvent } from '../shared/seed';
import { viewFor } from '../shared/view';
import { canReadBreakoutRoom } from '../shared/breakout';
import type {
  Actor, Breakout, ClientSnapshot, Command, CommandResult, EventState, JournalEntry, PresenceEntry, Role,
} from '../shared/types';

interface SocketMeta { actor: Actor; since: number; revoked?: boolean; expiresAt?: number; roleVersion?: number }

/** Journal entries that are too frequent to show in the "recent" feed (still journaled). */
const QUIET = /^(react:|vote:|word:|upvote:|chat$|bridge-mic:)/;
const GROWING_COMMANDS = new Set<Command['type']>([
  'REGISTER', 'ASK', 'UPVOTE', 'ORDER', 'POLL_CREATE', 'VOTE', 'WORD', 'RAISE_HAND',
  'JOIN_TABLE', 'CHAT', 'BRIDGE_LOG', 'BRIDGE_MIC', 'ADD_INCIDENT', 'BREAKOUT_CHAT', 'CREATE_BREAKOUT',
]);

/**
 * One instance per event. It is the event clock (epoch + monotonically increasing seq),
 * the authoritative state, and the append-only journal. Every client holds a hibernating
 * WebSocket here and receives its own projection of the state after each change.
 */
export class EventRoom extends DurableObject<Env> {
  private state: EventState | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataFlush: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tau INTEGER NOT NULL,
        actor TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
      sql.exec('CREATE TABLE IF NOT EXISTS snapshot_chunks (part INTEGER PRIMARY KEY, json TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS metadata_outbox (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, name TEXT NOT NULL, venue TEXT NOT NULL)');
      const chunks = sql.exec<{ json: string }>('SELECT json FROM snapshot_chunks ORDER BY part').toArray();
      if (chunks.length) this.state = JSON.parse(chunks.map(row => row.json).join('')) as EventState;
      else {
        const legacy = sql.exec<{ json: string }>('SELECT json FROM snapshot WHERE id = 1').toArray()[0];
        if (legacy) {
          const state = JSON.parse(legacy.json) as EventState;
          ctx.storage.transactionSync(() => {
            writeSnapshot(sql, snapshotChunks(state));
            sql.exec('DELETE FROM snapshot');
          });
          this.state = state;
        }
      }
    });
  }

  // ------------------------------------------------------------------ RPC (called by the Worker)

  async init(id: string, name: string, kind: 'corporate' | 'social', createdBy: string, venue?: string): Promise<void> {
    if (this.state) return;
    const state = seedEvent(id, name, kind, createdBy, Date.now());
    if (venue !== undefined) state.venue = venue;
    const chunks = snapshotChunks(state);
    this.ctx.storage.transactionSync(() => writeSnapshot(this.ctx.storage.sql, chunks));
    this.state = state;
    await this.scheduleAlarm();
  }

  async metadata(): Promise<{ name: string; venue: string }> {
    const state = this.require();
    return { name: state.name, venue: state.venue };
  }

  async snapshot(actor: Actor): Promise<ClientSnapshot> {
    return this.snapshotFor(this.require(), actor);
  }

  /** Full breakout, including its transcript, for members and hosts. Used to write notes. */
  async breakoutRoom(actor: Actor, breakoutId: string): Promise<{ ok: true; breakout: Breakout } | { ok: false; error: string; status: number }> {
    const b = this.require().breakouts.find((x) => x.id === breakoutId);
    if (!b) return { ok: false, error: 'Unknown breakout', status: 404 };
    if (!canReadBreakoutRoom(b, actor)) return { ok: false, error: "You can't read this breakout", status: 403 };
    return { ok: true, breakout: structuredClone(b) };
  }

  async command(actor: Actor, input: unknown): Promise<CommandResult> {
    const s = this.require();
    try {
      const cmd = parseCommand(input);
      authorize(actor, cmd, this.env.REQUIRE_WARP_FOR_PRODUCTION === 'true');
      // Apply to a copy so a failed command can never leave half-applied state.
      const draft = structuredClone(s);
      const now = Date.now();
      const summary = apply(draft, cmd, actor, now);
      const seq = this.commit(draft, actor.email, cmd, summary, now);
      if (cmd.type === 'RENAME_EVENT') await this.flushMetadata();
      if (['SET_AUTO_RUN', 'FIRE_NEXT_CUE', 'SKIP_CUE', 'RENAME_EVENT'].includes(cmd.type)) await this.scheduleAlarm();
      return { ok: true, seq };
    } catch (e) {
      if (e instanceof CommandError) return { ok: false, error: e.message, status: e.status };
      throw e;
    }
  }

  async journal(actor: Actor, before: number | null, limit: number): Promise<JournalEntry[]> {
    if (!actor.roles.some((r) => r !== 'attendee')) return [];
    const lim = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 100;
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new CommandError('Invalid journal cursor');
    type Row = Record<string, SqlStorageValue> & JournalEntry;
    const rows = before
      ? this.ctx.storage.sql.exec<Row>('SELECT seq, ts, tau, actor, type, summary FROM journal WHERE seq < ? ORDER BY seq DESC LIMIT ?', before, lim)
      : this.ctx.storage.sql.exec<Row>('SELECT seq, ts, tau, actor, type, summary FROM journal ORDER BY seq DESC LIMIT ?', lim);
    return rows.toArray().map((r) => ({ seq: r.seq, ts: r.ts, tau: r.tau, actor: r.actor, type: r.type, summary: r.summary }));
  }

  /** Membership changed in D1: update connected sockets for that person. */
  async refreshRoles(email: string, roles: Role[]): Promise<void> {
    const s = this.state;
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (!meta || meta.actor.email !== email) continue;
      meta.roleVersion = (meta.roleVersion ?? 0) + 1;
      meta.actor.roles = roles;
      meta.revoked = roles.length === 0;
      ws.serializeAttachment(meta);
      if (meta.revoked) { ws.close(1008, 'Membership removed'); continue; }
      if (s) this.send(ws, { type: 'snapshot', ...this.snapshotFor(s, meta.actor) });
    }
  }

  // ------------------------------------------------------------------ WebSockets

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const raw = req.headers.get('X-Actor');
    if (!raw) return new Response('Missing actor', { status: 400 });
    const actor = JSON.parse(raw) as Actor;
    const s = this.require();
    const expiresAt = Number(req.headers.get('X-Session-Expires'));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return new Response('Session expired', { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [actor.email]);
    server.serializeAttachment({ actor, since: Date.now(), expiresAt } satisfies SocketMeta);
    this.send(server, { type: 'snapshot', ...this.snapshotFor(s, actor) });
    this.scheduleBroadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 16_384) return;
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    if (meta.revoked || !meta.actor.roles.length || !meta.expiresAt || meta.expiresAt <= Date.now()) {
      ws.close(1008, 'Session or membership expired'); return;
    }
    let msg: { type: string; id?: string; cmd?: Command; t?: number };
    try { msg = JSON.parse(message); } catch { return; }

    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
    } else if (msg.type === 'cmd' && msg.cmd) {
      try {
        const cmd = parseCommand(msg.cmd);
        if (WARP_COMMANDS.has(cmd.type) && this.env.REQUIRE_WARP_FOR_PRODUCTION === 'true') {
          throw new CommandError('Production controls require fresh HTTP authentication', 403);
        }
        const actor = await resolveActor(this.env, meta.actor, this.require().id);
        const current = ws.deserializeAttachment() as SocketMeta | null;
        if (!actor || current?.revoked || current?.roleVersion !== meta.roleVersion) {
          ws.close(1008, 'Membership changed'); return;
        }
        const result = await this.command(actor, cmd);
        this.send(ws, { type: 'ack', id: msg.id, result });
      } catch (error) {
        if (error instanceof CommandError) this.send(ws, { type: 'ack', id: msg.id, result: { ok: false, error: error.message, status: error.status } });
        else { console.error('Socket command failed', error); this.send(ws, { type: 'ack', id: msg.id, result: { ok: false, error: 'Could not save command', status: 500 } }); }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    this.scheduleBroadcast();
  }

  async webSocketError(): Promise<void> {
    this.scheduleBroadcast();
  }

  // ------------------------------------------------------------------ Cue automation

  /** Auto cues fire on the event clock, even with nobody connected. */
  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    const next = s.cues.find((c) => c.status === 'pending');
    if (s.production.autoRun && next && next.auto && s.epoch + next.at <= now + 250) {
      const draft = structuredClone(s);
      const summary = fireNextCue(draft, now) + ' (auto)';
      this.commit(draft, 'system:cue-engine', { type: 'FIRE_NEXT_CUE' }, summary, now);
    }
    await this.flushMetadata();
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const next = s.cues.find((c) => c.status === 'pending');
    const cueAt = s.production.autoRun && next?.auto ? Math.max(Date.now() + 100, s.epoch + next.at) : Infinity;
    const metadataAt = this.ctx.storage.sql.exec('SELECT id FROM metadata_outbox').toArray().length ? Date.now() + 30_000 : Infinity;
    const alarmAt = Math.min(cueAt, metadataAt);
    if (Number.isFinite(alarmAt)) {
      await this.ctx.storage.setAlarm(alarmAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ------------------------------------------------------------------ internals

  private require(): EventState {
    if (!this.state) throw new Error('Event not initialized');
    return this.state;
  }

  /** Assign the next sequence number, append to the journal, persist and broadcast. */
  private commit(next: EventState, actor: string, cmd: Command, summary: string, now: number): number {
    next.seq += 1;
    const seq = next.seq;
    const tau = now - next.epoch;
    if (!QUIET.test(summary)) {
      next.recent.unshift({ seq, ts: now, tau, actor, type: cmd.type, summary });
      if (next.recent.length > 40) next.recent.length = 40;
    }
    // Leave headroom for production controls and moderation when new submissions reach capacity.
    const chunks = snapshotChunks(next, GROWING_COMMANDS.has(cmd.type) ? MAX_SNAPSHOT_BYTES - 1024 * 1024 : MAX_SNAPSHOT_BYTES);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'INSERT INTO journal (seq, ts, tau, actor, type, summary, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
        seq, now, tau, actor, cmd.type, summary, JSON.stringify(cmd),
      );
      writeSnapshot(this.ctx.storage.sql, chunks);
      if (cmd.type === 'RENAME_EVENT') this.ctx.storage.sql.exec(
        'INSERT INTO metadata_outbox (id, seq, name, venue) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, name = excluded.name, venue = excluded.venue',
        seq, next.name, next.venue,
      );
    });
    this.state = next;
    this.scheduleBroadcast();
    return seq;
  }

  private async flushMetadata(): Promise<void> {
    if (this.metadataFlush) return this.metadataFlush;
    this.metadataFlush = (async () => {
      // Serialize D1 updates; a newer rename may replace the pending row during the await.
      for (let attempt = 0; attempt < 5; attempt++) {
        const pending = this.ctx.storage.sql.exec<{ seq: number; name: string; venue: string }>('SELECT seq, name, venue FROM metadata_outbox').toArray()[0];
        if (!pending) return;
        try {
          const result = await this.env.DB.prepare('UPDATE events SET name = ?, venue = ? WHERE id = ?')
            .bind(pending.name, pending.venue, this.require().id).run();
          if (!result.success) return;
          this.ctx.storage.sql.exec('DELETE FROM metadata_outbox WHERE seq = ?', pending.seq);
        } catch { return; } // The durable outbox and alarm retry survive eviction.
      }
    })();
    try { await this.metadataFlush; } finally { this.metadataFlush = null; }
  }

  private presence(): PresenceEntry[] {
    const byEmail = new Map<string, PresenceEntry>();
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (!meta || meta.revoked || !meta.expiresAt || meta.expiresAt <= Date.now()) continue;
      const a = meta.actor;
      if (!byEmail.has(a.email)) byEmail.set(a.email, { email: a.email, name: a.name, roles: a.roles, device: a.device ?? 'Device', since: meta.since });
    }
    return [...byEmail.values()];
  }

  private snapshotFor(s: EventState, actor: Actor): ClientSnapshot {
    return { state: viewFor(s, actor), me: actor, serverTime: Date.now(), presence: this.presence() };
  }

  /** Coalesce bursts (reactions, votes) into one projection per socket. */
  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const s = this.state;
      if (!s) return;
      const presence = this.presence();
      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment() as SocketMeta | null;
        if (!meta || meta.revoked) continue;
        if (!meta.expiresAt || meta.expiresAt <= Date.now()) { ws.close(1008, 'Session expired'); continue; }
        this.send(ws, { type: 'snapshot', state: viewFor(s, meta.actor), me: meta.actor, serverTime: Date.now(), presence });
      }
    }, 60);
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}
