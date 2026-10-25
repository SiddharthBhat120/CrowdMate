/**
 * A ~40-line router on top of the History API. The app has a handful of
 * routes, so a router library would only add bundle weight.
 */
import { useSyncExternalStore, type MouseEvent } from 'react';

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search + location.hash) return;
  if (options.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  // Note the current heading first: React may render the new page a moment later.
  const oldHeading = document.querySelector('main h1');
  notify();
  window.scrollTo(0, 0);
  focusHeadingWhenReady(oldHeading);
}

/**
 * Move focus to the new page's <h1> so keyboard and screen-reader users land
 * on the new content. Pages often show "Loading…" first, so wait (briefly)
 * for the heading to appear, but never steal focus from someone who has
 * already started using the new page.
 */
let stopWatching: (() => void) | null = null;

function focusHeadingWhenReady(oldHeading: Element | null) {
  stopWatching?.();
  const main = document.querySelector('main');
  if (!main) return;
  const startedOn = document.activeElement;

  const tryFocus = () => {
    const heading = main.querySelector<HTMLElement>('h1');
    if (!heading || heading === oldHeading) return false;
    const active = document.activeElement;
    const userMovedOn = active && active !== document.body && active !== startedOn && active.isConnected && main.contains(active);
    if (!userMovedOn) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    return true;
  };

  if (tryFocus()) return;
  const observer = new MutationObserver(() => {
    if (tryFocus()) stop();
  });
  const timer = setTimeout(() => stop(), 5000);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    stopWatching = null;
  };
  observer.observe(main, { childList: true, subtree: true });
  stopWatching = stop;
}

export function usePath(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => location.pathname,
  );
}

/** Match "/ticket/:eventId/:ticketId" style patterns. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const actual = path.split('/').filter(Boolean);
  if (p.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    const value = actual[i]!;
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (part !== value) {
      return null;
    }
  }
  return params;
}

/** Use on <a> elements: plain left-clicks navigate in-app, others behave normally. */
export function onLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.currentTarget;
  if (anchor.target && anchor.target !== '_self') return;
  const url = new URL(anchor.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search + url.hash);
}
