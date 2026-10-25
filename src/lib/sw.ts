/**
 * Registers the service worker (production builds only; the dev server has none).
 * When a new version is ready we don't swap it in silently — the page offers
 * a reload, so code never changes underneath someone mid-task.
 */
export function registerServiceWorker(onUpdateReady: (apply: () => void) => void) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        const offer = (worker: ServiceWorker) =>
          onUpdateReady(() => {
            worker.postMessage('SKIP_WAITING');
          });

        // A new version may already be waiting from an earlier visit.
        if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            // "installed" with an existing controller = an update, not the first install.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
          });
        });
      })
      .catch((err) => console.warn('[crowdmate] service worker registration failed', err));

    // On the very first visit the new worker takes control too (clients.claim);
    // that is not an update, so don't reload the page for it.
    let hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });
}
