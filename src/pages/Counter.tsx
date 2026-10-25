import { useCallback, useEffect, useRef, useState } from 'react';
import { timeAgo } from '../../shared/domain';
import type { OpResult, QueueView, TicketView } from '../../shared/protocol';
import { LiveDot } from '../components/ConnectionBar';
import { Loading, Problem, useTitle } from '../components/PageState';
import { useToast } from '../components/Toast';
import { onLinkClick } from '../lib/router';
import { useFlip } from '../lib/useFlip';
import { OpFailure } from '../sync/client';
import { getSync, useConnection, useEvent, useNow } from '../sync/hooks';
import { statusText } from './EventHub';

type CounterAction = 'next' | 'noshow' | 'done' | 'pause';

/**
 * The screen staff use at the counter. Built for speed: big buttons and
 * single-key shortcuts (N, X, D, P), and it refuses to call anyone while
 * offline so nobody gets skipped by a call that never reached the server.
 */
export default function Counter({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const queueId = params.queueId!;
  const state = useEvent(eventId);
  const { status } = useConnection();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const view = state.view;
  const queue = view?.queues.find((q) => q.id === queueId);
  useTitle(queue ? `Counter: ${queue.name}` : 'Counter');

  const online = status === 'online' && state.live;
  const isOrganizer = getSync().hasOrganizerKey(eventId);

  const act = useCallback(
    async (action: CounterAction) => {
      if (!queue || busy || !online) return;
      setBusy(true);
      try {
        let result: OpResult;
        if (action === 'next') result = await getSync().perform(eventId, { type: 'queue.callNext', queueId });
        else if (action === 'noshow') result = await getSync().perform(eventId, { type: 'queue.markNoShow', queueId });
        else if (action === 'done') result = await getSync().perform(eventId, { type: 'queue.finishCurrent', queueId });
        else result = await getSync().perform(eventId, { type: 'queue.setStatus', queueId, status: queue.status === 'paused' ? 'open' : 'paused' });

        if (result.kind === 'called') {
          setAnnouncement(result.number === null ? 'Nobody is waiting.' : `Calling token ${result.number}.`);
        } else if (action === 'done') {
          setAnnouncement('Marked as served.');
        } else if (action === 'pause') {
          setAnnouncement(queue.status === 'paused' ? 'Queue resumed.' : 'Queue paused.');
        }
      } catch (err) {
        toast.show(err instanceof OpFailure ? err.message : 'That did not work. Try again.', { tone: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [busy, eventId, online, queue, queueId, toast],
  );

  // Keyboard shortcuts, ignored while typing in a field or when a dialog is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog[open]')) return;
      const map: Record<string, CounterAction> = { n: 'next', x: 'noshow', d: 'done', p: 'pause' };
      const action = map[event.key.toLowerCase()];
      if (!action) return;
      event.preventDefault();
      void act(action);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act]);

  if (!isOrganizer && state.live) {
    return (
      <Problem title="Staff only">
        <p>The counter screen needs the organizer's staff link.</p>
      </Problem>
    );
  }
  if (!view || !view.staff) {
    if (state.error?.code === 'not_found') return <Problem title="Event not found" />;
    return <Loading label="Opening counter" />;
  }
  if (!queue) {
    return (
      <Problem title="Queue not found">
        <p>This queue was removed.</p>
      </Problem>
    );
  }

  const tickets = view.staff.tickets.filter((t) => t.queueId === queueId);
  const current = tickets.find((t) => t.status === 'called');
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  const waiting = queue.waiting.map((n) => byNumber.get(n)).filter((t): t is TicketView => !!t);
  const finished = tickets
    .filter((t) => t.finishedAt !== null)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 6);
  const disabled = busy || !online;

  return (
    <div className="counter">
      <header className="page-head">
        <p className="page-kicker">
          <a href={`/organize/${eventId}`} onClick={onLinkClick}>
            {view.name}
          </a>
        </p>
        <h1>{queue.name}</h1>
        <p className="page-meta">
          <span className={`badge badge-${queue.status}`}>{statusText(queue.status)}</span>
          <LiveDot live={online} label={online ? 'Connected' : 'Reconnecting'} />
        </p>
      </header>

      {!online && (
        <p className="notice" role="status">
          Reconnecting. Calling is paused so nobody is skipped by a call that never arrives.
        </p>
      )}

      <div className="counter-grid">
        <section className="counter-now" aria-labelledby="now-heading">
          <h2 id="now-heading" className="h-small">
            Now serving
          </h2>
          <p className="counter-number">{current ? current.number : '–'}</p>
          <p className="counter-name">{current ? current.name || 'No name given' : waiting.length ? 'Nobody called yet' : 'Nobody waiting'}</p>
          <div className="counter-actions">
            <button type="button" className="btn btn-primary btn-huge" onClick={() => act('next')} disabled={disabled || queue.status === 'paused'}>
              Call next <kbd>N</kbd>
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => act('noshow')} disabled={disabled || !current}>
              No-show <kbd>X</kbd>
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => act('done')} disabled={disabled || !current}>
              Done, don't call next <kbd>D</kbd>
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => act('pause')} disabled={disabled || queue.status === 'closed'}>
              {queue.status === 'paused' ? 'Resume' : 'Take a break'} <kbd>P</kbd>
            </button>
          </div>
          <div className="visually-hidden" role="status" aria-live="assertive">
            {announcement}
          </div>
        </section>

        <WaitingList queue={queue} waiting={waiting} finished={finished} />
      </div>
    </div>
  );
}

function WaitingList({ queue, waiting, finished }: { queue: QueueView; waiting: TicketView[]; finished: TicketView[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const now = useNow(30_000);
  useFlip(listRef, waiting.map((t) => t.id).join(','));

  return (
    <section className="panel" aria-labelledby="waiting-heading">
      <h2 id="waiting-heading">
        Waiting <span className="count">{waiting.length}</span>
      </h2>
      {waiting.length === 0 ? (
        <p className="muted">{queue.status === 'closed' ? 'The line is empty and closed.' : 'Nobody is waiting.'}</p>
      ) : (
        <ol className="waiting-list" ref={listRef}>
          {waiting.map((t, index) => (
            <li key={t.id} data-flip-key={t.id} className="waiting-item">
              <span className="token-chip">{t.number}</span>
              <span className="waiting-name">{t.name || 'No name'}</span>
              <span className="muted waiting-time">
                {index === 0 ? 'next, ' : ''}joined {timeAgo(t.joinedAt, now)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {finished.length > 0 && (
        <>
          <h3 className="h-small">Recently finished</h3>
          <ul className="finished-list">
            {finished.map((t) => (
              <li key={t.id}>
                <span className="token-chip token-chip-muted">{t.number}</span>
                {t.status === 'served' ? 'Served' : t.status === 'noshow' ? 'No-show' : 'Left the line'}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
