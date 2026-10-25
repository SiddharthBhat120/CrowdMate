/**
 * SyncClient: the one place that talks to the server.
 *
 *  - Keeps a single WebSocket open, with heartbeat pings and reconnect using
 *    exponential backoff + jitter.
 *  - Every change is written to an IndexedDB "outbox" first, then sent.
 *    It stays there until the server acknowledges it, so nothing is lost if
 *    the phone goes offline or the page is closed. Op ids make re-sending safe.
 *  - The last snapshot of every event is cached in IndexedDB, so screens show
 *    data instantly on load and keep working offline.
 *
 * React components read state through useSyncExternalStore (see hooks.ts).
 * State objects are replaced, never mutated, so React can compare by reference.
 */
import { backoffDelay } from '../../shared/domain';
import type {
  ClientMessage,
  ErrorCode,
  EventPublicView,
  EventView,
  Op,
  OpEnvelope,
  OpResult,
  ServerMessage,
} from '../../shared/protocol';
import { idb, type OutboxEntry } from '../lib/idb';
import { uid } from '../lib/ids';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Changes waiting to reach the server. */
  pending: number;
}

export interface EventState {
  view: EventView | null;
  version: number;
  /** True when this data was confirmed by the server on the current connection. */
  live: boolean;
  /** When the data was last received from the server (ms since epoch). */
  receivedAt: number | null;
  error: { code: ErrorCode; message: string } | null;
}

export class OpFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpFailure';
  }
}

export interface FailureNotice {
  op: Op;
  code: ErrorCode;
  message: string;
}

export interface SyncOptions {
  socketUrl: () => string;
  deviceId: string;
  createSocket?: (url: string) => WebSocket;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  heartbeatMs?: number;
  /** No message for this long = connection is dead, even if the browser hasn't noticed. */
  deadAfterMs?: number;
  isOnline?: () => boolean;
}

const EMPTY_EVENT: EventState = Object.freeze({ view: null, version: 0, live: false, receivedAt: null, error: null });
const OPEN = 1;

export class SyncClient {
  private readonly opts: Required<SyncOptions>;
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private started = false;
  private connection: ConnectionState = { status: 'connecting', pending: 0 };
  private serverOffsetMs = 0;
  private events = new Map<string, EventState>();
  private refCounts = new Map<string, number>();
  /** Events subscribed on the *current* socket. Reset on every reconnect. */
  private serverSubs = new Set<string>();
  private organizerKeys = new Map<string, string>();
  private outbox: readonly OutboxEntry[] = [];
  private seq = 0;
  private waiters = new Map<string, { resolve: (r: OpResult) => void; reject: (e: OpFailure) => void }>();
  private listeners = new Set<() => void>();
  private failureListeners = new Set<(notice: FailureNotice) => void>();
  /** Ops sent on the wire but not yet acknowledged (used to describe failures). */
  private lastSentOps = new Map<string, Op>();
  private ready: Promise<void> = Promise.resolve();

  constructor(options: SyncOptions) {
    this.opts = {
      createSocket: (url) => new WebSocket(url),
      fetchImpl: (...args) => fetch(...args),
      now: () => Date.now(),
      random: Math.random,
      heartbeatMs: 20_000,
      deadAfterMs: 45_000,
      isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
      ...options,
    };
  }

  /* ---------------- lifecycle ---------------- */

  start() {
    if (this.started) return;
    this.started = true;
    this.ready = this.loadPersisted();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.connectNow);
      window.addEventListener('offline', this.handleBrowserOffline);
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
    void this.ready.then(() => this.connect());
  }

  stop() {
    this.started = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.connectNow);
      window.removeEventListener('offline', this.handleBrowserOffline);
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  private async loadPersisted() {
    const [entries, keys] = await Promise.all([idb.getAll('outbox'), idb.getAll('keys')]);
    for (const { eventId, key } of keys) this.organizerKeys.set(eventId, key);
    const merged = [...entries, ...this.outbox].sort((a, b) => a.seq - b.seq);
    const unique = new Map(merged.map((e) => [e.opId, e]));
    this.outbox = [...unique.values()];
    this.seq = this.outbox.reduce((max, e) => Math.max(max, e.seq), this.seq);
    this.setConnection({ pending: this.outbox.length });
  }

  /* ---------------- connection ---------------- */

  private connect() {
    if (!this.started) return;
    if (this.socket) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.opts.isOnline()) {
      this.setConnection({ status: 'offline' });
      return; // the browser's "online" event will call connectNow()
    }

    let ws: WebSocket;
    try {
      ws = this.opts.createSocket(this.opts.socketUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    this.serverSubs.clear();

    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.attempt = 0;
      this.lastMessageAt = this.opts.now();
      this.send({ t: 'hello', deviceId: this.opts.deviceId });
      for (const eventId of this.refCounts.keys()) this.subscribeOnServer(eventId);
      this.flushOutbox();
      this.startHeartbeat();
      this.setConnection({ status: 'online' });
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws) return;
      this.lastMessageAt = this.opts.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
    ws.onclose = () => this.dropSocket(ws);
    ws.onerror = () => {
      /* a close event always follows; reconnect is handled there */
    };
  }

  /** Forget a socket (closed, or silently dead) and plan the next attempt. */
  private dropSocket(ws: WebSocket) {
    if (this.socket !== ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    this.socket = null;
    this.serverSubs.clear();
    this.stopHeartbeat();
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    // Everything we show is now "last known", not live.
    let changed = false;
    for (const [id, state] of this.events) {
      if (state.live) {
        this.events.set(id, { ...state, live: false });
        changed = true;
      }
    }
    this.setConnection({ status: 'offline' }, changed);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    if (!this.opts.isOnline()) return;
    const delay = Math.max(250, backoffDelay(this.attempt, this.opts.random()));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Try immediately (network came back, or the user returned to the tab). */
  readonly connectNow = () => {
    this.attempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  };

  private readonly handleBrowserOffline = () => {
    if (this.socket) this.dropSocket(this.socket);
    else this.setConnection({ status: 'offline' });
  };

  private readonly handleVisibility = () => {
    if (document.visibilityState === 'visible' && !this.socket) this.connectNow();
  };

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.socket;
      if (!ws) return;
      if (this.opts.now() - this.lastMessageAt > this.opts.deadAfterMs) {
        // Phones on bad networks often keep a "zombie" socket open. Replace it.
        this.dropSocket(ws);
        return;
      }
      this.send({ t: 'ping', at: this.opts.now() });
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private send(msg: ClientMessage): boolean {
    const ws = this.socket;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /* ---------------- incoming ---------------- */

  private handleMessage(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome':
        this.serverOffsetMs = msg.serverTime - this.opts.now();
        return;
      case 'pong':
        this.serverOffsetMs = msg.serverTime - this.opts.now();
        return;
      case 'snapshot': {
        const current = this.events.get(msg.eventId);
        if (current?.view && current.live && msg.version < current.version) return; // out of order
        const state: EventState = { view: msg.view, version: msg.version, live: true, receivedAt: this.opts.now(), error: null };
        this.events.set(msg.eventId, state);
        void idb.put('events', { eventId: msg.eventId, version: msg.version, view: msg.view, savedAt: this.opts.now() });
        this.emit();
        return;
      }
      case 'upToDate': {
        const current = this.events.get(msg.eventId) ?? EMPTY_EVENT;
        this.events.set(msg.eventId, { ...current, live: true, receivedAt: this.opts.now(), error: null });
        this.emit();
        return;
      }
      case 'subscribeError': {
        this.serverSubs.delete(msg.eventId);
        if (msg.code === 'forbidden') {
          // Wrong organizer key: forget it and fall back to a normal visitor subscription.
          this.organizerKeys.delete(msg.eventId);
          void idb.delete('keys', msg.eventId);
        }
        const current = this.events.get(msg.eventId) ?? EMPTY_EVENT;
        this.events.set(msg.eventId, { ...current, live: false, error: { code: msg.code, message: msg.message } });
        this.emit();
        if (msg.code === 'forbidden' && this.refCounts.has(msg.eventId)) this.subscribeOnServer(msg.eventId);
        return;
      }
      case 'ack': {
        const before = this.outbox.length;
        this.outbox = this.outbox.filter((e) => e.opId !== msg.opId);
        if (this.outbox.length !== before) void idb.delete('outbox', msg.opId);
        const waiter = this.waiters.get(msg.opId);
        this.waiters.delete(msg.opId);
        const sentOp = this.lastSentOps.get(msg.opId);
        this.lastSentOps.delete(msg.opId);
        if (msg.ok) {
          waiter?.resolve(msg.result);
        } else {
          const failure = new OpFailure(msg.code, msg.message);
          if (waiter) waiter.reject(failure);
          else if (sentOp) {
            for (const listener of this.failureListeners) listener({ op: sentOp, code: msg.code, message: msg.message });
          }
        }
        this.setConnection({ pending: this.outbox.length });
        return;
      }
    }
  }

  /* ---------------- subscriptions ---------------- */

  /**
   * Start receiving live updates for an event. Returns a function that stops them.
   * Reference-counted, so two screens showing the same event share one subscription.
   */
  subscribe(eventId: string, organizerKey?: string): () => void {
    const id = eventId.toUpperCase();
    if (organizerKey && this.organizerKeys.get(id) !== organizerKey) {
      this.organizerKeys.set(id, organizerKey);
      void idb.put('keys', { eventId: id, key: organizerKey });
      // Re-subscribe with the key so this connection gets organizer rights.
      this.serverSubs.delete(id);
    }
    const count = this.refCounts.get(id) ?? 0;
    this.refCounts.set(id, count + 1);
    if (!this.events.has(id)) {
      this.events.set(id, EMPTY_EVENT);
      void this.loadCached(id);
    }
    this.subscribeOnServer(id);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.refCounts.get(id) ?? 1) - 1;
      if (left > 0) {
        this.refCounts.set(id, left);
        return;
      }
      this.refCounts.delete(id);
      // Keep the server subscription while changes for this event are still queued.
      if (!this.outbox.some((e) => e.env.eventId === id) && this.serverSubs.delete(id)) {
        this.send({ t: 'unsubscribe', eventId: id });
      }
    };
  }

  private subscribeOnServer(id: string) {
    if (this.serverSubs.has(id)) return;
    const state = this.events.get(id) ?? EMPTY_EVENT;
    const key = this.organizerKeys.get(id);
    // Only ask "anything new since version N?" if our cached copy is the same kind of view.
    const sameRole = state.view?.role === (key ? 'organizer' : 'visitor');
    const msg: Extract<ClientMessage, { t: 'subscribe' }> = { t: 'subscribe', eventId: id, sinceVersion: sameRole ? state.version : 0 };
    if (key) msg.organizerKey = key;
    if (this.send(msg)) this.serverSubs.add(id);
  }

  private async loadCached(id: string) {
    await this.ready;
    const cached = await idb.get('events', id);
    const current = this.events.get(id);
    if (cached && current && !current.view) {
      this.events.set(id, { ...current, view: cached.view, version: cached.version, receivedAt: cached.savedAt });
      this.emit();
      // A socket that opened while IndexedDB was loading subscribed with version 0;
      // that's fine — the server just sends a full snapshot.
      return;
    }
    if (!cached && current && !current.view) void this.prefetchPublic(id);
  }

  /**
   * First visit (e.g. straight from a QR scan): fetch the public data over
   * plain HTTP while the WebSocket is still connecting. The server answers
   * with an ETag, so repeat requests are cheap 304s.
   */
  private async prefetchPublic(id: string) {
    try {
      const res = await this.opts.fetchImpl(`/api/events/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
      const current = this.events.get(id);
      if (!current || current.view) return;
      if (res.status === 404) {
        this.events.set(id, { ...current, error: { code: 'not_found', message: 'No event with that code.' } });
        this.emit();
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { version: number; view: EventPublicView };
      const latest = this.events.get(id);
      if (!latest || latest.view) return;
      const view: EventView = { ...data.view, role: 'visitor', tickets: [], tags: [], finding: [], staff: null };
      // version 0 so the WebSocket still sends the personalised snapshot.
      this.events.set(id, { ...latest, view, version: 0, receivedAt: this.opts.now() });
      this.emit();
    } catch {
      /* offline: the WebSocket will catch up later */
    }
  }

  /* ---------------- outgoing changes ---------------- */

  /**
   * Make a change. It is saved to the outbox immediately and sent when possible.
   * The promise resolves when the server confirms (which may be much later if
   * the phone is offline) and rejects with OpFailure if the server refuses it.
   */
  async perform(eventId: string, op: Op): Promise<OpResult> {
    await this.ready;
    const id = eventId.toUpperCase();
    const env: OpEnvelope = { opId: uid(), eventId: id, op, createdAt: this.opts.now() };
    const entry: OutboxEntry = { opId: env.opId, env, seq: ++this.seq };
    const result = new Promise<OpResult>((resolve, reject) => this.waiters.set(env.opId, { resolve, reject }));
    this.outbox = [...this.outbox, entry];
    this.setConnection({ pending: this.outbox.length });
    await idb.put('outbox', entry);
    this.sendOp(entry);
    return result;
  }

  private sendOp(entry: OutboxEntry) {
    if (!this.socket || this.socket.readyState !== OPEN) return;
    this.subscribeOnServer(entry.env.eventId);
    this.lastSentOps.set(entry.opId, entry.env.op);
    this.send({ t: 'op', env: entry.env });
  }

  private flushOutbox() {
    for (const entry of this.outbox) this.sendOp(entry);
  }

  /* ---------------- reading state ---------------- */

  getEvent(eventId: string): EventState {
    return this.events.get(eventId.toUpperCase()) ?? EMPTY_EVENT;
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  getOutbox(): readonly OutboxEntry[] {
    return this.outbox;
  }

  hasOrganizerKey(eventId: string): boolean {
    return this.organizerKeys.has(eventId.toUpperCase());
  }

  organizerKey(eventId: string): string | undefined {
    return this.organizerKeys.get(eventId.toUpperCase());
  }

  /** Current time on the server's clock (corrects for a wrong phone clock). */
  serverNow(): number {
    return this.opts.now() + this.serverOffsetMs;
  }

  /** Resolves once saved outbox entries and organizer keys are loaded. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when a change queued earlier (e.g. before a reload) is refused by the server. */
  onFailure(listener: (notice: FailureNotice) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  private setConnection(patch: Partial<ConnectionState>, forceEmit = false) {
    const next = { ...this.connection, ...patch };
    if (next.status !== this.connection.status || next.pending !== this.connection.pending) {
      this.connection = next;
      this.emit();
    } else if (forceEmit) {
      this.emit();
    }
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
