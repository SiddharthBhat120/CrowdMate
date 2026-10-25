import { useEffect, useState, type FormEvent } from 'react';
import { estimateWaitSec, formatWait } from '../../shared/domain';
import { LIMITS, type QueueView, type TagFullView, type TicketView } from '../../shared/protocol';
import { LiveDot } from '../components/ConnectionBar';
import { Field } from '../components/Field';
import { Loading, Problem, useTitle } from '../components/PageState';
import { savePlace } from '../lib/places';
import { navigate, onLinkClick } from '../lib/router';
import { OpFailure } from '../sync/client';
import { getSync, useConnection, useEvent } from '../sync/hooks';

export function EventHub({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const state = useEvent(eventId);
  const view = state.view;
  useTitle(view?.name ?? 'Event');

  const eventName = view?.name;
  useEffect(() => {
    if (eventName && state.live) void savePlace('event', eventId, eventName, eventId, eventName);
  }, [eventId, eventName, state.live]);

  if (!view) {
    if (state.error?.code === 'not_found') {
      return (
        <Problem title="Event not found">
          <p>There's no event with the code {eventId}. Check the code on the poster and try again.</p>
        </Problem>
      );
    }
    return <Loading label="Opening event" />;
  }

  const activeTickets = view.tickets.filter((t) => t.status === 'waiting' || t.status === 'called');
  const isOrganizer = getSync().hasOrganizerKey(eventId);

  return (
    <div className="stack-xl">
      <header className="event-banner">
        <h1>{view.name}</h1>
        <p className="page-meta">
          <LiveDot live={state.live} label={state.live ? 'Live' : 'Saved copy'} />
          <span>
            Code <strong className="code">{view.id}</strong>
          </span>
          {isOrganizer && (
            <a href={`/organize/${eventId}`} onClick={onLinkClick}>
              Organizer dashboard
            </a>
          )}
        </p>
      </header>

      {activeTickets.length > 0 && (
        <section aria-labelledby="my-tokens" className="stack">
          <h2 id="my-tokens">Your tokens</h2>
          <ul className="my-tokens">
            {activeTickets.map((t) => (
              <TicketLink key={t.id} eventId={eventId} ticket={t} queue={view.queues.find((q) => q.id === t.queueId)} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="queues-heading" className="stack">
        <h2 id="queues-heading">Pick a queue</h2>
        {view.queues.length === 0 ? (
          <p className="empty">No queues are open yet. This page updates by itself when they are.</p>
        ) : (
          <ul className="queue-rows">
            {view.queues.map((q) => (
              <QueueRow key={q.id} eventId={eventId} queue={q} myTicket={activeTickets.find((t) => t.queueId === q.id)} />
            ))}
          </ul>
        )}
      </section>

      <SafetyTags eventId={eventId} eventName={view.name} tags={view.tags} />
    </div>
  );
}

function TicketLink({ eventId, ticket, queue }: { eventId: string; ticket: TicketView; queue: QueueView | undefined }) {
  const called = ticket.status === 'called';
  return (
    <li>
      <a href={`/ticket/${eventId}/${ticket.id}`} onClick={onLinkClick} className={`my-token${called ? ' is-called' : ''}`}>
        <span className="my-token-number">{ticket.number}</span>
        <span>
          <span className="my-token-queue">{queue?.name ?? 'Queue'}</span>
          <span className="my-token-state">{called ? "It's your turn" : 'Tap to see your place'}</span>
        </span>
      </a>
    </li>
  );
}

function QueueRow({ eventId, queue, myTicket }: { eventId: string; queue: QueueView; myTicket: TicketView | undefined }) {
  const waitingCount = queue.waiting.length;
  const wait = estimateWaitSec(queue, waitingCount + 1);
  const closed = queue.status === 'closed';
  return (
    <li className={`queue-row queue-${queue.status}`}>
      <div className="queue-row-main">
        <h3>{queue.name}</h3>
        <p className="queue-row-meta">
          {closed ? (
            'Closed'
          ) : (
            <>
              <strong>{waitingCount}</strong> waiting
              {waitingCount > 0 && <> · {formatWait(wait)}</>}
              {queue.status === 'paused' && <> · on a break</>}
            </>
          )}
        </p>
      </div>
      {myTicket ? (
        <a className="btn btn-secondary" href={`/ticket/${eventId}/${myTicket.id}`} onClick={onLinkClick}>
          View token {myTicket.number}
        </a>
      ) : closed ? null : (
        <a className="btn btn-primary" href={`/q/${eventId}/${queue.id}`} onClick={onLinkClick}>
          Get a token
        </a>
      )}
    </li>
  );
}

export function statusText(status: QueueView['status']): string {
  return status === 'open' ? 'Open' : status === 'paused' ? 'On a break' : 'Closed';
}

function SafetyTags({ eventId, eventName, tags }: { eventId: string; eventName: string; tags: TagFullView[] }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { status } = useConnection();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) {
      setError('Describe who will wear the tag, so a helper can recognise them.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await getSync().perform(eventId, { type: 'tag.create', label: label.trim(), note: note.trim() });
      if (result.kind === 'tag') {
        await savePlace('tag', eventId, eventName, result.tagId, label.trim());
        navigate(`/tag/${eventId}/${result.tagId}`);
      }
    } catch (err) {
      setError(err instanceof OpFailure ? err.message : 'Could not create the tag. Try again.');
      setBusy(false);
    }
  }

  return (
    <section className="safety-card" aria-labelledby="tags-heading">
      <div className="safety-card-head">
        <span className="safety-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
          </svg>
        </span>
        <div>
          <h2 id="tags-heading">Safety tag</h2>
          <p className="muted">
            For a child or elderly relative. If you get separated, whoever finds them scans the tag and you can chat
            instantly. Your number stays private.
          </p>
        </div>
      </div>

      {tags.length > 0 && (
        <ul className="tag-chips">
          {tags.map((t) => (
            <li key={t.id}>
              <a href={`/tag/${eventId}/${t.id}`} onClick={onLinkClick} className={`tag-chip tag-${t.status}`}>
                <span className={`status-dot status-${t.status}`} aria-hidden="true" />
                {t.label}
                {t.status === 'lost' && <span className="visually-hidden">, marked missing</span>}
                {t.status === 'found' && <span className="visually-hidden">, someone found them</span>}
              </a>
            </li>
          ))}
        </ul>
      )}

      {!open ? (
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} aria-expanded={false}>
            Create a safety tag
          </button>
        </div>
      ) : (
        <form className="stack reveal" onSubmit={submit} noValidate>
          <Field
            label="Who is this tag for?"
            hint="First name, age and what they're wearing. Example: Aarav, 6, red T-shirt"
            value={label}
            maxLength={LIMITS.tagLabel}
            autoFocus
            onChange={(e) => {
              setLabel(e.target.value);
              setError(null);
            }}
            error={error}
          />
          <Field
            multiline
            rows={2}
            label="Anything a helper should know (optional)"
            hint="Shown only to the person who finds them."
            value={note}
            maxLength={LIMITS.tagNote}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create safety tag'}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {busy && status !== 'online' && (
            <p className="muted" role="status">
              You're offline. The tag is saved on this phone and will be created when you reconnect.
            </p>
          )}
        </form>
      )}
    </section>
  );
}
