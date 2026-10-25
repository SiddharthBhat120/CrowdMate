import { useEffect, useState, type FormEvent } from 'react';
import { estimateWaitSec, formatWait } from '../../shared/domain';
import { LIMITS } from '../../shared/protocol';
import { Field } from '../components/Field';
import { Loading, Problem, useTitle } from '../components/PageState';
import { savePlace } from '../lib/places';
import { navigate, onLinkClick } from '../lib/router';
import { getSavedName, setSavedName } from '../lib/storage';
import { OpFailure } from '../sync/client';
import { getSync, useConnection, useEvent, useOutbox } from '../sync/hooks';
import { statusText } from './EventHub';

/**
 * The page a QR code on a counter opens. Often the very first visit, on a
 * weak network, so it is part of the main bundle and keeps work minimal.
 */
export function JoinQueue({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const queueId = params.queueId!;
  const state = useEvent(eventId);
  const { status } = useConnection();
  const outbox = useOutbox();
  const view = state.view;
  const queue = view?.queues.find((q) => q.id === queueId);
  useTitle(queue ? `Join ${queue.name}` : 'Join a queue');

  const [name, setName] = useState(getSavedName);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const existing = view?.tickets.find((t) => t.queueId === queueId && (t.status === 'waiting' || t.status === 'called'));
  const queuedJoin = outbox.some((e) => e.env.eventId === eventId && e.env.op.type === 'ticket.join' && e.env.op.queueId === queueId);

  // Already in this line on this phone: go straight to the token.
  useEffect(() => {
    if (existing) navigate(`/ticket/${eventId}/${existing.id}`, { replace: true });
  }, [existing, eventId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (joining || !view || !queue) return;
    setJoining(true);
    setError(null);
    const trimmed = name.trim();
    setSavedName(trimmed);
    try {
      const result = await getSync().perform(eventId, { type: 'ticket.join', queueId, name: trimmed });
      if (result.kind !== 'ticket') throw new Error('Unexpected answer from the server.');
      await savePlace('ticket', eventId, view.name, result.ticketId, `Token ${result.number}, ${queue.name}`);
      navigate(`/ticket/${eventId}/${result.ticketId}`, { replace: true });
    } catch (err) {
      setError(err instanceof OpFailure || err instanceof Error ? err.message : 'Could not join. Try again.');
      setJoining(false);
    }
  }

  if (!view) {
    if (state.error?.code === 'not_found') {
      return (
        <Problem title="Event not found">
          <p>This QR code belongs to an event that has ended or doesn't exist.</p>
        </Problem>
      );
    }
    return <Loading label="Opening queue" />;
  }

  if (!queue) {
    return (
      <Problem title="Queue not found">
        <p>
          This queue isn't part of {view.name} anymore.{' '}
          <a href={`/e/${eventId}`} onClick={onLinkClick}>
            See the event's other queues
          </a>
          .
        </p>
      </Problem>
    );
  }

  const position = queue.waiting.length + 1;
  const waitSec = estimateWaitSec(queue, position);
  const waitingForNetwork = (joining || queuedJoin) && status !== 'online';

  return (
    <div className="stack-xl narrow">
      <header className="page-head">
        <p className="page-kicker">
          <a href={`/e/${eventId}`} onClick={onLinkClick}>
            {view.name}
          </a>
        </p>
        <h1>{queue.name}</h1>
        <p className="page-meta">
          <span className={`badge badge-${queue.status}`}>{statusText(queue.status)}</span>
        </p>
      </header>

      <dl className="facts">
        <div>
          <dt>People waiting</dt>
          <dd>{queue.waiting.length}</dd>
        </div>
        <div>
          <dt>Now serving</dt>
          <dd>{queue.nowServing ?? 'Nobody'}</dd>
        </div>
        <div>
          <dt>Your wait if you join now</dt>
          <dd>{queue.waiting.length === 0 && queue.nowServing === null ? 'No wait' : formatWait(waitSec)}</dd>
        </div>
      </dl>

      {queue.status === 'closed' ? (
        <p className="notice">{queue.name} isn't taking new people right now.</p>
      ) : waitingForNetwork || queuedJoin ? (
        <p className="notice" role="status">
          {status === 'online'
            ? 'Getting your token…'
            : "You're offline. Your request is saved on this phone and you'll get your token number as soon as you reconnect."}
        </p>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <Field
            label="Your name (optional)"
            hint="Helps the staff call you. Only staff can see it."
            value={name}
            maxLength={LIMITS.personName}
            autoComplete="given-name"
            onChange={(e) => setName(e.target.value)}
          />
          <div>
            <button type="submit" className="btn btn-primary btn-large" disabled={joining}>
              {joining ? 'Getting your token…' : 'Get my token'}
            </button>
          </div>
          {queue.status === 'paused' && <p className="muted">The counter is on a short break, but you can join the line now.</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
