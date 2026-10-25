/**
 * HTTP + WebSocket server.
 *
 * HTTP  : create an event, read public event data (with ETag/304), serve the app.
 * WS /ws: subscribe to events and send ops; the server pushes a fresh,
 *         personalised snapshot to every subscriber whenever an event changes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { loadEvents, Saver } from './persist';
import { createStaticHandler } from './static';
import { publicView, Store, tagPublicView, viewFor } from './store';
import { parseClientMessage, parseEventName } from './validate';

export interface AppOptions {
  dataFile: string;
  distDir: string;
  /** Override the clock in tests. */
  now?: () => number;
  heartbeatMs?: number;
}

interface Conn {
  ws: WebSocket;
  deviceId: string | null;
  /** eventId -> whether this connection proved the organizer key */
  subs: Map<string, { isOrganizer: boolean }>;
  tokens: number;
  lastRefill: number;
  alive: boolean;
}

const OPS_BURST = 30;
const OPS_PER_SEC = 4;
const MAX_BODY = 10_000;

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  const store = new Store(loadEvents(options.dataFile));
  const saver = new Saver(options.dataFile, () => store.all());
  const serveStatic = createStaticHandler(options.distDir);
  const subscribers = new Map<string, Set<Conn>>();
  const conns = new Set<Conn>();
  const createLimits = new Map<string, number[]>();

  function send(conn: Conn, msg: ServerMessage) {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  function sendSnapshot(conn: Conn, eventId: string) {
    const event = store.get(eventId);
    const sub = conn.subs.get(eventId);
    if (!event || !sub || !conn.deviceId) return;
    const view = viewFor(event, { deviceId: conn.deviceId, isOrganizer: sub.isOrganizer });
    send(conn, { t: 'snapshot', eventId, version: event.version, view });
  }

  function broadcast(eventId: string) {
    for (const conn of subscribers.get(eventId) ?? []) sendSnapshot(conn, eventId);
  }

  function allowCreate(ip: string): boolean {
    const hourAgo = now() - 3_600_000;
    const recent = (createLimits.get(ip) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= 20) return false;
    recent.push(now());
    createLimits.set(ip, recent);
    return true;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/info' && req.method === 'GET') {
      sendJson(res, 200, { addresses: lanAddresses() });
      return true;
    }
    if (path === '/api/events' && req.method === 'POST') {
      if (!allowCreate(req.socket.remoteAddress ?? 'unknown')) {
        sendJson(res, 429, { error: 'Too many events created from this network. Try again in an hour.' });
        return true;
      }
      let name: string | null = null;
      try {
        name = parseEventName(JSON.parse(await readBody(req)));
      } catch {
        name = null;
      }
      if (!name) {
        sendJson(res, 400, { error: 'Give the event a name.' });
        return true;
      }
      const { event, organizerKey } = store.createEvent(name, now());
      saver.schedule();
      sendJson(res, 201, { eventId: event.id, organizerKey });
      return true;
    }

    const tagMatch = /^\/api\/events\/([A-Za-z0-9]{1,16})\/tags\/([a-z0-9]{1,16})$/.exec(path);
    if (tagMatch && req.method === 'GET') {
      const tag = store.get(tagMatch[1]!)?.tags[tagMatch[2]!];
      if (!tag) sendJson(res, 404, { error: 'This safety tag is not active.' });
      else sendJson(res, 200, tagPublicView(tag));
      return true;
    }

    const eventMatch = /^\/api\/events\/([A-Za-z0-9]{1,16})$/.exec(path);
    if (eventMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const event = store.get(eventMatch[1]!.toUpperCase());
      if (!event) {
        sendJson(res, 404, { error: 'No event with that code.' });
        return true;
      }
      // The version number is a perfect ETag: same version = same data.
      const etag = `"${event.id}-v${event.version}"`;
      const headers = { ETag: etag, 'Cache-Control': 'no-cache' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return true;
      }
      sendJson(res, 200, { version: event.version, view: publicView(event) }, headers);
      return true;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown API route.' });
      return true;
    }
    return false;
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    handleApi(req, res, path)
      .then((handled) => {
        if (handled) return;
        if (serveStatic(req, res, path)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Frontend not built. In development open the Vite URL (port 5173). For production run "npm run build" first.');
      })
      .catch((err: unknown) => {
        console.error('[crowdmate] request failed', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
        else res.end();
      });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  wss.on('connection', (ws) => {
    const conn: Conn = { ws, deviceId: null, subs: new Map(), tokens: OPS_BURST, lastRefill: now(), alive: true };
    conns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    send(conn, { t: 'welcome', serverTime: now() });

    ws.on('message', (data) => {
      conn.alive = true;
      const msg = parseClientMessage(data.toString());
      if (!msg) return;

      switch (msg.t) {
        case 'hello':
          conn.deviceId = msg.deviceId;
          return;

        case 'ping':
          send(conn, { t: 'pong', at: msg.at, serverTime: now() });
          return;

        case 'subscribe': {
          const eventId = msg.eventId.toUpperCase();
          const event = store.get(eventId);
          if (!event || !conn.deviceId) {
            send(conn, { t: 'subscribeError', eventId, code: 'not_found', message: 'No event with that code.' });
            return;
          }
          let isOrganizer = false;
          if (msg.organizerKey) {
            isOrganizer = store.isOrganizerKey(eventId, msg.organizerKey);
            if (!isOrganizer) {
              send(conn, { t: 'subscribeError', eventId, code: 'forbidden', message: 'This organizer link is not valid.' });
              return;
            }
          }
          conn.subs.set(eventId, { isOrganizer });
          let set = subscribers.get(eventId);
          if (!set) subscribers.set(eventId, (set = new Set()));
          set.add(conn);
          if (msg.sinceVersion === event.version) send(conn, { t: 'upToDate', eventId, version: event.version });
          else sendSnapshot(conn, eventId);
          return;
        }

        case 'unsubscribe':
          conn.subs.delete(msg.eventId);
          subscribers.get(msg.eventId)?.delete(conn);
          return;

        case 'op': {
          const { env } = msg;
          if (!conn.deviceId) {
            send(conn, { t: 'ack', opId: env.opId, ok: false, code: 'bad_request', message: 'Say hello first.' });
            return;
          }
          // Token bucket: short bursts are fine, a flood is not.
          const t = now();
          conn.tokens = Math.min(OPS_BURST, conn.tokens + ((t - conn.lastRefill) / 1000) * OPS_PER_SEC);
          conn.lastRefill = t;
          if (conn.tokens < 1) {
            send(conn, { t: 'ack', opId: env.opId, ok: false, code: 'rate_limited', message: 'Slow down a little and try again.' });
            return;
          }
          conn.tokens -= 1;

          const eventId = env.eventId.toUpperCase();
          const isOrganizer = conn.subs.get(eventId)?.isOrganizer ?? false;
          let outcome;
          try {
            outcome = store.apply({ ...env, eventId }, { deviceId: conn.deviceId, isOrganizer }, t);
          } catch (err) {
            console.error('[crowdmate] op failed', env.op.type, err);
            send(conn, { t: 'ack', opId: env.opId, ok: false, code: 'bad_request', message: 'The server could not apply that change.' });
            return;
          }
          if (outcome.response.ok) send(conn, { t: 'ack', opId: env.opId, ok: true, result: outcome.response.result });
          else send(conn, { t: 'ack', opId: env.opId, ok: false, code: outcome.response.code, message: outcome.response.message });
          if (outcome.changed) {
            saver.schedule();
            broadcast(eventId);
          }
          return;
        }
      }
    });

    ws.on('close', () => {
      conns.delete(conn);
      for (const eventId of conn.subs.keys()) subscribers.get(eventId)?.delete(conn);
      conn.subs.clear();
    });
  });

  // Drop connections that stopped answering (phone switched off, network gone).
  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, options.heartbeatMs ?? 30_000);

  function close(): Promise<void> {
    clearInterval(heartbeat);
    saver.flush();
    for (const client of wss.clients) client.terminate();
    return new Promise((done) => wss.close(() => server.close(() => done())));
  }

  return { server, store, close, flush: () => saver.flush() };
}
