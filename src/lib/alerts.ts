/**
 * Getting someone's attention: vibration, a system notification and the tab title.
 *
 * Notifications need a secure page (HTTPS or localhost) and the person's
 * permission. They show while this page is open in the background; alerts
 * with the page fully closed would need Web Push and a push server.
 */

export type NotifySupport = 'granted' | 'denied' | 'default' | 'unsupported';

export function notifySupport(): NotifySupport {
  if (typeof window === 'undefined' || !('Notification' in window) || !window.isSecureContext) return 'unsupported';
  return Notification.permission;
}

export async function askToNotify(): Promise<NotifySupport> {
  if (notifySupport() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'unsupported';
  }
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported or not allowed yet */
  }
}

export async function alertUser(title: string, body: string, url: string) {
  vibrate([250, 120, 250, 120, 400]);
  if (notifySupport() !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, { body, tag: url, data: { url }, icon: '/icon-192.png' });
    } else {
      new Notification(title, { body, tag: url, icon: '/icon-192.png' });
    }
  } catch {
    /* some browsers block notifications from the page itself; vibration already happened */
  }
}
