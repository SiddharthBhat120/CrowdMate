import { useEffect, useState } from 'react';

export interface ShareBase {
  /** Origin to put inside QR codes and shared links. */
  base: string;
  /** True when this page runs on localhost, which other phones cannot open. */
  localOnly: boolean;
  /** The Wi-Fi address we switched to, if any. */
  lanAddress: string | null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * QR codes must contain an address other phones can reach. If the organizer
 * opened the app at localhost, swap in this computer's Wi-Fi address (asked
 * from the server) so phones on the same network can scan and open it.
 */
export function useShareBase(): ShareBase {
  const isLocal = LOCAL_HOSTS.has(location.hostname);
  const [state, setState] = useState<ShareBase>({ base: location.origin, localOnly: isLocal, lanAddress: null });

  useEffect(() => {
    if (!isLocal) return;
    let cancelled = false;
    fetch('/api/info')
      .then((res) => (res.ok ? (res.json() as Promise<{ addresses: string[] }>) : null))
      .then((info) => {
        const ip = info?.addresses[0];
        if (cancelled || !ip) return;
        const port = location.port ? `:${location.port}` : '';
        setState({ base: `${location.protocol}//${ip}${port}`, localOnly: true, lanAddress: ip });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLocal]);

  return state;
}
