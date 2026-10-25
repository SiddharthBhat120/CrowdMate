import { useEffect, useState, useSyncExternalStore } from 'react';
import { getDeviceId } from '../lib/storage';
import { SyncClient, type ConnectionState, type EventState } from './client';

let instance: SyncClient | null = null;

/** The app-wide sync client (created on first use). */
export function getSync(): SyncClient {
  if (!instance) {
    instance = new SyncClient({
      socketUrl: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      deviceId: getDeviceId(),
    });
  }
  return instance;
}

/** For tests: use a custom client. */
export function setSyncForTests(client: SyncClient | null) {
  instance = client;
}

const subscribeToSync = (listener: () => void) => getSync().onChange(listener);

export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribeToSync, () => getSync().getConnection());
}

/** Live data for one event; subscribes while the component is mounted. */
export function useEvent(eventId: string, organizerKey?: string): EventState {
  useEffect(() => getSync().subscribe(eventId, organizerKey), [eventId, organizerKey]);
  return useSyncExternalStore(subscribeToSync, () => getSync().getEvent(eventId));
}

export function useOutbox() {
  return useSyncExternalStore(subscribeToSync, () => getSync().getOutbox());
}

/** Re-render every `ms` so "2 min ago" style labels stay correct. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => getSync().serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(getSync().serverNow()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
