import type { ClientSnapshot, Command, CommandResult } from '../shared/types';
import { WARP_COMMANDS } from '../shared/reducer';

export class ApiError extends Error {
  constructor(message: string, public status: number, public body?: unknown) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status, body);
  return body as T;
}

export type ConnState = 'connecting' | 'live' | 'offline';

/**
 * Live connection to one event's Durable Object. Holds the latest projected snapshot,
 * estimates the offset to the server clock (for τ), and sends commands over the socket
 * (falling back to HTTP while reconnecting).
 */
export class EventStore {
  snap: ClientSnapshot | null = null;
  conn: ConnState = 'connecting';
  error: string | null = null;
  offsetMs = 0;
  revision = 0;
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private retry = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private n = 0;

  constructor(public eventId: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private emit() { this.revision++; for (const l of this.listeners) l(); }

  start() {
    if (this.ws && !this.closed) return;
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.clearPending('Connection closed');
    ws?.close();
    this.conn = 'offline';
    this.emit();
  }

  private clearPending(error: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/events/${this.eventId}/ws`);
    this.ws = ws;
    this.conn = this.snap ? 'offline' : 'connecting';
    this.emit();

    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      this.retry = 0;
      this.conn = 'live';
      this.error = null;
      this.ping();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 15_000);
      this.emit();
    };
    ws.onmessage = (ev) => {
      if (this.closed || this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'snapshot') {
        this.snap = { state: msg.state, me: msg.me, serverTime: msg.serverTime, presence: msg.presence };
        this.emit();
      } else if (msg.type === 'ack') {
        const pending = this.pending.get(msg.id);
        if (pending) { clearTimeout(pending.timer); pending.resolve(msg.result); }
        this.pending.delete(msg.id);
      } else if (msg.type === 'pong') {
        const rtt = Date.now() - msg.t;
        this.offsetMs = msg.serverTime + rtt / 2 - Date.now();
      }
    };
    ws.onclose = (ev) => {
      if (this.closed || this.ws !== ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.clearPending('Connection lost');
      this.conn = 'offline';
      if (ev.code === 1008 || ev.code === 4403) this.error = 'No access to this event';
      this.emit();
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.closed && this.ws === ws) this.connect();
      }, delay);
      // The upgrade fails without a readable status; ask over HTTP why.
      if (!this.snap) void this.probe(ws);
    };
  }

  private async probe(ws: WebSocket) {
    try {
      const snap = await api<ClientSnapshot>(`/api/events/${this.eventId}/snapshot`);
      if (this.closed || this.ws !== ws) return;
      this.snap = snap;
      this.emit();
    } catch (e) {
      if (this.closed || this.ws !== ws) return;
      if (e instanceof ApiError && (e.status === 403 || e.status === 401 || e.status === 404)) {
        this.error = e.message;
        this.closed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.emit();
      }
    }
  }

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  }

  /** Server-aligned now. */
  now() { return Date.now() + this.offsetMs; }

  async send(cmd: Command): Promise<CommandResult> {
    // Production controls re-enter the Worker so Access posture and roles are checked now.
    if (!WARP_COMMANDS.has(cmd.type) && this.ws?.readyState === WebSocket.OPEN) {
      const id = `c${++this.n}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pending.has(id)) { this.pending.delete(id); resolve({ ok: false, error: 'No response from the event server' }); }
        }, 10_000);
        this.pending.set(id, { resolve, timer });
        try { this.ws!.send(JSON.stringify({ type: 'cmd', id, cmd })); }
        catch { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: 'Connection lost' }); }
      });
    }
    try {
      return await api<CommandResult>(`/api/events/${this.eventId}/commands`, { method: 'POST', json: cmd });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed' };
    }
  }
}
