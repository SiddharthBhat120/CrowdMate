// @ts-check
/// <reference lib="webworker" />
/**
 * CrowdMate service worker (template — the build fills in the two
 * placeholders below; see vite.config.ts).
 *
 * Strategy
 *  - App shell + hashed assets are precached at install, served cache-first.
 *    The app opens instantly on repeat visits and with no network at all.
 *  - GET /api/* is network-first with a cached fallback, so the last known
 *    data still shows offline.
 *  - WebSocket traffic never passes through a service worker.
 *  - A new version waits until the page asks it to take over, so a running
 *    page is never switched to new code underneath it.
 */

/** @type {ServiceWorkerGlobalScope} */
// @ts-ignore — `self` is a ServiceWorkerGlobalScope inside a worker.
const sw = self;

const VERSION = '__CROWDMATE_VERSION__';
/** @type {string[]} */
const PRECACHE = __CROWDMATE_PRECACHE__;
const SHELL_CACHE = `crowdmate-shell-${VERSION}`;
const API_CACHE = 'crowdmate-api';

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `cache: 'reload'` skips the HTTP cache so we store fresh copies.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('crowdmate-shell-') && name !== SHELL_CACHE).map((name) => caches.delete(name)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname === '/ws' || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    event.respondWith(shell(request));
  } else if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

/** @param {Request} request */
async function shell(request) {
  const cached = await caches.match('/', { cacheName: SHELL_CACHE });
  if (cached) return cached;
  return fetch(request);
}

/** @param {Request} request */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).pathname.startsWith('/assets/')) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

/** @param {Request} request */
async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', sw.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      return sw.clients.openWindow(target);
    })(),
  );
});
