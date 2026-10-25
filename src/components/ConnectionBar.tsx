import { useConnection } from '../sync/hooks';

/**
 * Tells people plainly when they are offline and whether their changes are
 * still waiting to be sent. Hidden when everything is fine.
 */
export function ConnectionBar() {
  const { status, pending } = useConnection();
  const waiting = pending > 0 ? ` ${pending} ${pending === 1 ? 'change is' : 'changes are'} saved on this phone and will be sent when you reconnect.` : '';

  let text = '';
  if (status === 'offline') text = `You're offline. Showing the last saved information.${waiting}`;
  else if (status === 'connecting' && pending > 0) text = `Connecting…${waiting}`;

  return (
    <div className={`connection-bar${text ? ' is-visible' : ''}`} role="status">
      {text}
    </div>
  );
}

export function LiveDot({ live, label }: { live: boolean; label: string }) {
  return (
    <span className={`live-dot${live ? ' is-live' : ''}`}>
      <span className="live-dot-mark" aria-hidden="true" />
      {label}
    </span>
  );
}
