/**
 * A tiny promise wrapper around IndexedDB (no library).
 *
 * Stores
 *   events  : last known snapshot of each event, so screens render offline
 *   outbox  : changes made while offline, waiting to be sent
 *   places  : events, tickets and tags this phone has used (home screen list)
 *   keys    : organizer keys for events this phone manages
 *
 * If IndexedDB is unavailable (some private modes), every call quietly
 * becomes a no-op so the app still works online.
 */
import type { EventView, OpEnvelope } from '../../shared/protocol';

export interface CachedEvent {
  eventId: string;
  version: number;
  view: EventView;
  savedAt: number;
}

export interface OutboxEntry {
  opId: string;
  env: OpEnvelope;
  /** Insertion order, so ops are replayed in the order the user made them. */
  seq: number;
}

export type PlaceKind = 'organizer' | 'ticket' | 'tag' | 'event';

export interface Place {
  key: string;
  kind: PlaceKind;
  eventId: string;
  eventName: string;
  /** ticketId / tagId / queueId depending on kind */
  refId: string;
  label: string;
  savedAt: number;
}

interface StoreMap {
  events: CachedEvent;
  outbox: OutboxEntry;
  places: Place;
  keys: { eventId: string; key: string };
}
type StoreName = keyof StoreMap;

const DB_NAME = 'crowdmate';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'eventId' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'opId' });
      if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'eventId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgraded the schema: close so it isn't blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    const tx = db.transaction(name, mode);
    // Listen for completion before anything can finish, so the event is never missed.
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    done.catch(() => {}); // handled below; avoids an "unhandled rejection" if the request fails first
    const result = await requestToPromise(run(tx.objectStore(name)));
    // A write is only safe once the whole transaction has committed.
    await done;
    return result;
  } catch (err) {
    console.warn('[crowdmate] IndexedDB error', err);
    return undefined;
  }
}

export const idb = {
  get<S extends StoreName>(name: S, key: string): Promise<StoreMap[S] | undefined> {
    return withStore(name, 'readonly', (s) => s.get(key) as IDBRequest<StoreMap[S]>);
  },
  async getAll<S extends StoreName>(name: S): Promise<StoreMap[S][]> {
    return (await withStore(name, 'readonly', (s) => s.getAll() as IDBRequest<StoreMap[S][]>)) ?? [];
  },
  async put<S extends StoreName>(name: S, value: StoreMap[S]): Promise<void> {
    await withStore(name, 'readwrite', (s) => s.put(value));
  },
  async delete(name: StoreName, key: string): Promise<void> {
    await withStore(name, 'readwrite', (s) => s.delete(key));
  },
};

/** For tests: forget the cached connection. */
export function resetDbForTests() {
  dbPromise = null;
}
