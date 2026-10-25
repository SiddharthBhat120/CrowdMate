import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idb, resetDbForTests } from '../../src/lib/idb';
import { OpFailure, SyncClient } from '../../src/sync/client';
import { FakeSocket, makeView } from './fakes';

let online = true;
let client: SyncClient;

function makeClient() {
  return new SyncClient({
    socketUrl: () => 'ws://test/ws',
    deviceId: 'device-under-test-1',
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    fetchImpl: () => Promise.reject(new Error('offline')),
    random: () => 1, // deterministic backoff: always the maximum of each step
    isOnline: () => online,
    heartbeatMs: 1000,
    deadAfterMs: 2500,
  });
}

/** Fake only the timers the client uses; fake-indexeddb keeps using real setImmediate. */
function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

/** Let promises and IndexedDB callbacks settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh database for each test
  resetDbForTests();
  FakeSocket.instances = [];
  online = true;
  client = makeClient();
});

afterEach(() => {
  client.stop();
  vi.useRealTimers();
});

describe('connecting', () => {
  it('says hello, then subscribes to the events in use', async () => {
    client.subscribe('abcdef');
    client.start();
    await client.whenReady();
    await settle();
    const socket = FakeSocket.latest();
    expect(client.getConnection().status).toBe('connecting');
    socket.serverOpen();
    expect(socket.sent[0]).toEqual({ t: 'hello', deviceId: 'device-under-test-1' });
    expect(socket.sentOfType('subscribe')).toEqual([{ t: 'subscribe', eventId: 'ABCDEF', sinceVersion: 0 }]);
    expect(client.getConnection().status).toBe('online');
  });

  it('stores snapshots and serves them from IndexedDB on the next visit', async () => {
    client.subscribe('ABCDEF');
    client.start();
    await client.whenReady();
    await settle();
    FakeSocket.latest().serverOpen();
    FakeSocket.latest().serverSend({ t: 'snapshot', eventId: 'ABCDEF', version: 7, view: makeView() });
    expect(client.getEvent('ABCDEF')).toMatchObject({ version: 7, live: true });
    await settle();

    // "Reload the page" while offline: a brand-new client, no network.
    client.stop();
    online = false;
    client = makeClient();
    client.start();
    client.subscribe('ABCDEF');
    await client.whenReady();
    await vi.waitFor(() => expect(client.getEvent('ABCDEF')).toMatchObject({ version: 7, live: false }));
    expect(client.getEvent('ABCDEF').view?.name).toBe('Spring Fair');
    expect(client.getConnection().status).toBe('offline');
  });
});

describe('offline changes (the outbox)', () => {
  it('keeps a change made offline and sends it after reconnecting', async () => {
    online = false;
    client.start();
    await client.whenReady();
    await settle();
    const result = client.perform('ABCDEF', { type: 'ticket.join', queueId: 'q1', name: '' });
    await settle();
    expect(client.getConnection().pending).toBe(1);
    expect(FakeSocket.instances).toHaveLength(0);

    online = true;
    client.connectNow();
    const socket = FakeSocket.latest();
    socket.serverOpen();
    const [op] = socket.sentOfType('op');
    expect(op!.env.op).toEqual({ type: 'ticket.join', queueId: 'q1', name: '' });
    // The op's event gets a subscription so the server knows who is asking.
    expect(socket.sentOfType('subscribe').map((s) => s.eventId)).toContain('ABCDEF');

    socket.serverSend({ t: 'ack', opId: op!.env.opId, ok: true, result: { kind: 'ticket', ticketId: 't1', number: 4 } });
    await expect(result).resolves.toEqual({ kind: 'ticket', ticketId: 't1', number: 4 });
    expect(client.getConnection().pending).toBe(0);
    await settle();
    expect(await idb.getAll('outbox')).toEqual([]);
  });

  it('survives a page reload while offline', async () => {
    online = false;
    client.start();
    await client.whenReady();
    await settle();
    void client.perform('ABCDEF', { type: 'tag.message', tagId: 'tag1', text: 'Near gate 2' });
    await settle();
    client.stop();

    client = makeClient();
    client.start();
    await client.whenReady();
    await settle();
    expect(client.getConnection().pending).toBe(1);
    online = true;
    client.connectNow();
    FakeSocket.latest().serverOpen();
    expect(FakeSocket.latest().sentOfType('op')[0]!.env.op).toMatchObject({ text: 'Near gate 2' });
  });

  it('re-sends unacknowledged changes with the same op id after a drop', async () => {
    client.start();
    await client.whenReady();
    await settle();
    FakeSocket.latest().serverOpen();
    void client.perform('ABCDEF', { type: 'ticket.leave', ticketId: 't1' });
    await settle();
    const firstId = FakeSocket.latest().sentOfType('op')[0]!.env.opId;
    FakeSocket.latest().serverDrop();
    client.connectNow();
    FakeSocket.latest().serverOpen();
    expect(FakeSocket.latest().sentOfType('op')[0]!.env.opId).toBe(firstId);
  });

  it('rejects with the server’s reason when a change is refused', async () => {
    client.start();
    await client.whenReady();
    await settle();
    FakeSocket.latest().serverOpen();
    const result = client.perform('ABCDEF', { type: 'ticket.join', queueId: 'q1', name: '' });
    await settle();
    const op = FakeSocket.latest().sentOfType('op')[0]!;
    FakeSocket.latest().serverSend({ t: 'ack', opId: op.env.opId, ok: false, code: 'queue_closed', message: 'Food stall is closed.' });
    await expect(result).rejects.toBeInstanceOf(OpFailure);
    await expect(result).rejects.toThrow('Food stall is closed.');
  });
});

describe('reconnecting', () => {
  it('backs off exponentially and resets after a successful connection', async () => {
    useFakeClock();
    client.start();
    await client.whenReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(1);

    FakeSocket.latest().serverDrop(); // attempt 0 failed -> wait 500ms
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.latest().serverDrop(); // attempt 1 failed -> wait 1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);

    FakeSocket.latest().serverOpen(); // success resets the counter
    FakeSocket.latest().serverDrop();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('replaces a silent "zombie" connection found by the heartbeat', async () => {
    useFakeClock();
    client.start();
    await client.whenReady();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.latest();
    socket.serverOpen();
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sentOfType('ping')).toHaveLength(1);
    // The server never answers. After deadAfterMs the client gives up on this socket.
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getConnection().status).toBe('offline');
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it('asks only for changes since the version it already has', async () => {
    client.subscribe('ABCDEF');
    client.start();
    await client.whenReady();
    await settle();
    FakeSocket.latest().serverOpen();
    FakeSocket.latest().serverSend({ t: 'snapshot', eventId: 'ABCDEF', version: 12, view: makeView() });
    FakeSocket.latest().serverDrop();
    client.connectNow();
    FakeSocket.latest().serverOpen();
    expect(FakeSocket.latest().sentOfType('subscribe')).toEqual([{ t: 'subscribe', eventId: 'ABCDEF', sinceVersion: 12 }]);
  });
});
