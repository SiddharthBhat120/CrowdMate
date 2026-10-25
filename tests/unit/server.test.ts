// @vitest-environment node
/**
 * Runs the real server on a random port and talks to it like phones would:
 * over HTTP and WebSocket.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ClientMessage, Op, ServerMessage } from '../../shared/protocol';
import { createApp } from '../../server/app';

let dir: string;
let app: ReturnType<typeof createApp>;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crowdmate-test-'));
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CrowdMate</title>' + 'x'.repeat(2000));
  writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1);'.repeat(200));
  app = createApp({ dataFile: join(dir, 'data', 'db.json'), distDir: dist });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake phone: one WebSocket plus a log of everything the server said. */
class Phone {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  private waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(readonly deviceId: string) {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.test(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }

  async open() {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.send({ t: 'hello', deviceId: this.deviceId });
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  next<T extends ServerMessage>(test: (m: ServerMessage) => m is T, timeoutMs = 2000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as T);
        },
      });
    });
  }

  async op(eventId: string, op: Op, opId = `op-${Math.random().toString(36).slice(2)}`) {
    const ack = this.next((m): m is Extract<ServerMessage, { t: 'ack' }> => m.t === 'ack' && m.opId === opId);
    this.send({ t: 'op', env: { opId, eventId, op, createdAt: Date.now() } });
    return ack;
  }

  close() {
    this.ws.close();
  }
}

const isSnapshot = (m: ServerMessage): m is Extract<ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot';

async function createEvent(name = 'Spring Fair') {
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { eventId: string; organizerKey: string };
}

describe('HTTP API', () => {
  it('rejects an event without a name', async () => {
    const res = await fetch(`${base}/api/events`, { method: 'POST', body: '{"name":"   "}' });
    expect(res.status).toBe(400);
  });

  it('serves public event data with an ETag and answers 304 when unchanged', async () => {
    const { eventId } = await createEvent();
    const first = await fetch(`${base}/api/events/${eventId}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const body = (await first.json()) as { view: { name: string } };
    expect(body.view.name).toBe('Spring Fair');

    const second = await fetch(`${base}/api/events/${eventId}`, { headers: { 'If-None-Match': etag! } });
    expect(second.status).toBe(304);
  });

  it('returns 404 for unknown events and tags', async () => {
    expect((await fetch(`${base}/api/events/ZZZZZZ`)).status).toBe(404);
    const { eventId } = await createEvent();
    expect((await fetch(`${base}/api/events/${eventId}/tags/nothere`)).status).toBe(404);
  });
});

describe('static files and caching headers', () => {
  it('caches hashed assets for a year and revalidates the HTML shell', async () => {
    const asset = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'Accept-Encoding': 'br' } });
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-encoding')).toBe('br');
    expect(await asset.text()).toContain('console.log(1)');

    const page = await fetch(`${base}/ticket/ABCDEF/xyz`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");

    const sw = await fetch(`${base}/sw.js`);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers 304 for an unchanged file and blocks path tricks', async () => {
    const first = await fetch(`${base}/assets/app-abc123.js`);
    const etag = first.headers.get('etag')!;
    const again = await fetch(`${base}/assets/app-abc123.js`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).not.toBe(200);
  });
});

describe('real-time queue over WebSocket', () => {
  it('pushes live updates to every phone and keeps names private', async () => {
    const { eventId, organizerKey } = await createEvent();
    const staff = new Phone('staff-phone-0001');
    const visitor = new Phone('visitor-phone-01');
    await Promise.all([staff.open(), visitor.open()]);

    staff.send({ t: 'subscribe', eventId, sinceVersion: 0, organizerKey });
    const staffFirst = await staff.next(isSnapshot);
    expect(staffFirst.view.role).toBe('organizer');

    const created = await staff.op(eventId, { type: 'queue.create', name: 'Food stall', avgServiceSec: 90 });
    expect(created.ok).toBe(true);
    const queueId = created.ok && created.result.kind === 'queue' ? created.result.queueId : '';

    visitor.send({ t: 'subscribe', eventId, sinceVersion: 0 });
    await visitor.next(isSnapshot);

    const staffSeesJoin = staff.next((m): m is Extract<ServerMessage, { t: 'snapshot' }> => isSnapshot(m) && m.view.queues[0]!.waiting.length === 1);
    const joined = await visitor.op(eventId, { type: 'ticket.join', queueId, name: 'Priya' });
    expect(joined).toMatchObject({ ok: true, result: { kind: 'ticket', number: 1 } });

    const staffView = (await staffSeesJoin).view;
    expect(staffView.staff!.tickets[0]!.name).toBe('Priya');

    // Staff calls the visitor: the visitor's phone learns within one message.
    const visitorCalled = visitor.next(
      (m): m is Extract<ServerMessage, { t: 'snapshot' }> => isSnapshot(m) && m.view.tickets[0]?.status === 'called',
    );
    await staff.op(eventId, { type: 'queue.callNext', queueId });
    const visitorView = (await visitorCalled).view;
    expect(visitorView.queues[0]!.nowServing).toBe(1);
    expect(visitorView.staff).toBeNull();

    staff.close();
    visitor.close();
  });

  it('applies a re-sent op once (reconnect after a dropped connection)', async () => {
    const { eventId, organizerKey } = await createEvent();
    const staff = new Phone('staff-phone-0002');
    await staff.open();
    staff.send({ t: 'subscribe', eventId, sinceVersion: 0, organizerKey });
    await staff.next(isSnapshot);
    const created = await staff.op(eventId, { type: 'queue.create', name: 'Desk', avgServiceSec: 60 });
    const queueId = created.ok && created.result.kind === 'queue' ? created.result.queueId : '';

    const phone = new Phone('visitor-phone-02');
    await phone.open();
    phone.send({ t: 'subscribe', eventId, sinceVersion: 0 });
    await phone.next(isSnapshot);
    const first = await phone.op(eventId, { type: 'ticket.join', queueId, name: '' }, 'retry-me');
    phone.close();

    // Same op id from a fresh connection, as the outbox does after reconnecting.
    const again = new Phone('visitor-phone-02');
    await again.open();
    again.send({ t: 'subscribe', eventId, sinceVersion: 0 });
    await again.next(isSnapshot);
    const second = await again.op(eventId, { type: 'ticket.join', queueId, name: '' }, 'retry-me');
    expect(second).toEqual(first);
    expect(app.store.get(eventId)!.queues[0]!.waiting).toHaveLength(1);
    again.close();
    staff.close();
  });

  it('says upToDate instead of resending data the phone already has', async () => {
    const { eventId } = await createEvent();
    const phone = new Phone('visitor-phone-03');
    await phone.open();
    phone.send({ t: 'subscribe', eventId, sinceVersion: 0 });
    const snap = await phone.next(isSnapshot);
    phone.send({ t: 'subscribe', eventId, sinceVersion: snap.version });
    const reply = await phone.next((m): m is Extract<ServerMessage, { t: 'upToDate' }> => m.t === 'upToDate');
    expect(reply.version).toBe(snap.version);
    phone.close();
  });

  it('refuses a wrong organizer key and organizer ops from visitors', async () => {
    const { eventId } = await createEvent();
    const phone = new Phone('visitor-phone-04');
    await phone.open();
    phone.send({ t: 'subscribe', eventId, sinceVersion: 0, organizerKey: 'not-the-key' });
    const err = await phone.next((m): m is Extract<ServerMessage, { t: 'subscribeError' }> => m.t === 'subscribeError');
    expect(err.code).toBe('forbidden');
    phone.send({ t: 'subscribe', eventId, sinceVersion: 0 });
    await phone.next(isSnapshot);
    const denied = await phone.op(eventId, { type: 'queue.create', name: 'Hack', avgServiceSec: 60 });
    expect(denied).toMatchObject({ ok: false, code: 'forbidden' });
    phone.close();
  });

  it('ignores malformed messages without crashing', async () => {
    const { eventId } = await createEvent();
    const phone = new Phone('visitor-phone-05');
    await phone.open();
    phone.ws.send('not json');
    phone.ws.send(JSON.stringify({ t: 'op', env: { opId: 'x', eventId, op: { type: 'queue.delete' }, createdAt: 1 } }));
    phone.send({ t: 'ping', at: 1 });
    const pong = await phone.next((m): m is Extract<ServerMessage, { t: 'pong' }> => m.t === 'pong');
    expect(pong.at).toBe(1);
    phone.close();
  });
});

describe('persistence', () => {
  it('writes everything to disk so a restart loses nothing', async () => {
    const { eventId } = await createEvent('Saved Fair');
    app.flush();
    const saved = JSON.parse(readFileSync(join(dir, 'data', 'db.json'), 'utf8')) as { events: { id: string; name: string }[] };
    expect(saved.events.find((e) => e.id === eventId)?.name).toBe('Saved Fair');

    const restarted = createApp({ dataFile: join(dir, 'data', 'db.json'), distDir: join(dir, 'dist') });
    expect(restarted.store.get(eventId)?.name).toBe('Saved Fair');
    await restarted.close();
  });
});
