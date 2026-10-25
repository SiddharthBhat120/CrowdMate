import { useEffect, useRef, useState } from 'react';
import { formatWait, ordinal, ticketPhase, timeAgo, type TicketPhase } from '../../shared/domain';
import type { QueueView, TicketView } from '../../shared/protocol';
import { LiveDot } from '../components/ConnectionBar';
import { ConfirmDialog } from '../components/Dialog';
import { Loading, Problem, useTitle } from '../components/PageState';
import { useToast } from '../components/Toast';
import { alertUser, askToNotify, notifySupport, vibrate } from '../lib/alerts';
import { savePlace } from '../lib/places';
import { navigate, onLinkClick } from '../lib/router';
import { OpFailure } from '../sync/client';
import { getSync, useEvent, useNow } from '../sync/hooks';

const ALMOST_POSITION = 2;

export function Ticket({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const ticketId = params.ticketId!;
  const state = useEvent(eventId);
  const view = state.view;
  const ticket = view?.tickets.find((t) => t.id === ticketId);
  const queue = ticket ? view?.queues.find((q) => q.id === ticket.queueId) : undefined;
  const now = useNow();

  const phase = ticket ? ticketPhase(queue, ticket) : null;
  useTitle(phaseTitle(ticket, phase));

  if (!view || !ticket || !phase) {
    if (state.error?.code === 'not_found') {
      return (
        <Problem title="Event not found">
          <p>This token belongs to an event that has ended.</p>
        </Problem>
      );
    }
    if (view && state.live && !ticket) {
      return (
        <Problem title="Token not found on this phone">
          <p>Tokens belong to the phone that took them. If you joined on another phone, open the token there.</p>
        </Problem>
      );
    }
    return <Loading label="Opening your token" />;
  }

  return (
    <div className="stack-xl narrow">
      <p className="page-kicker">
        <a href={`/e/${eventId}`} onClick={onLinkClick}>
          {view.name}
        </a>
      </p>
      <TicketSlip ticket={ticket} queue={queue} phase={phase} />
      <p className="page-meta">
        <LiveDot
          live={state.live}
          label={state.live ? 'Updating live' : `Offline. Last update ${state.receivedAt ? timeAgo(state.receivedAt, now) : 'unknown'}`}
        />
      </p>
      <Announcer phase={phase} queueName={queue?.name ?? 'the counter'} eventId={eventId} ticketId={ticketId} />
      <TicketActions eventId={eventId} eventName={view.name} ticket={ticket} queue={queue} phase={phase} />
    </div>
  );
}

function phaseTitle(ticket: TicketView | undefined, phase: TicketPhase | null): string {
  if (!ticket || !phase) return 'Your token';
  if (phase.phase === 'called') return `Your turn! Token ${ticket.number}`;
  if (phase.phase === 'waiting') return `${ordinal(phase.position)} in line, token ${ticket.number}`;
  return `Token ${ticket.number}`;
}

function TicketSlip({ ticket, queue, phase }: { ticket: TicketView; queue: QueueView | undefined; phase: TicketPhase }) {
  return (
    <article className={`slip slip-${phase.phase}`} aria-labelledby="slip-title">
      <div className="slip-top">
        <h1 id="slip-title" className="slip-queue">
          {queue?.name ?? 'Queue'}
        </h1>
        {ticket.name && <p className="slip-name">{ticket.name}</p>}
      </div>
      <p className="slip-number" aria-label={`Token number ${ticket.number}`}>
        {ticket.number}
      </p>
      <div className="slip-bottom">
        <PhaseText phase={phase} queue={queue} />
        {(phase.phase === 'waiting' || phase.phase === 'paused') && <LineTrack position={phase.position} />}
      </div>
    </article>
  );
}

/**
 * A row of dots: the counter on the left, the people ahead, then you.
 * Purely visual (the text above says the same thing), so it is hidden from screen readers.
 */
function LineTrack({ position }: { position: number }) {
  const shown = Math.min(position - 1, 6);
  const hidden = position - 1 - shown;
  return (
    <div className="line-track" aria-hidden="true">
      <span className="line-counter">Counter</span>
      {hidden > 0 && <span className="line-more">+{hidden}</span>}
      {Array.from({ length: shown }, (_, i) => (
        <span key={position - shown + i} className="line-dot" />
      ))}
      <span className="line-dot line-you">You</span>
    </div>
  );
}

function PhaseText({ phase, queue }: { phase: TicketPhase; queue: QueueView | undefined }) {
  switch (phase.phase) {
    case 'waiting':
      return (
        <>
          <p className="slip-status pop" key={phase.position}>
            {phase.position === 1 ? "You're next" : `You're ${ordinal(phase.position)} in line`}
          </p>
          <p className="slip-sub">
            {phase.waitSec < 60 ? 'Any moment now' : `Wait ${formatWait(phase.waitSec)}`}
            {queue?.nowServing != null && `. Now serving ${queue.nowServing}`}
          </p>
        </>
      );
    case 'paused':
      return (
        <>
          <p className="slip-status">The counter is on a short break</p>
          <p className="slip-sub">You keep your place: {ordinal(phase.position)} in line.</p>
        </>
      );
    case 'called':
      return (
        <>
          <p className="slip-status">It's your turn</p>
          <p className="slip-sub">Please go to {queue?.name ?? 'the counter'} now.</p>
        </>
      );
    case 'done':
      return (
        <p className="slip-status">
          {phase.status === 'served' ? 'Done. Thanks for waiting.' : phase.status === 'noshow' ? 'You missed your turn.' : 'You left this line.'}
        </p>
      );
    case 'closed':
      return <p className="slip-status">This line has closed.</p>;
  }
}

/**
 * Speaks changes for screen-reader users and buzzes the phone at the moments
 * that matter: almost your turn, and your turn.
 */
function Announcer({ phase, queueName, eventId, ticketId }: { phase: TicketPhase; queueName: string; eventId: string; ticketId: string }) {
  const [message, setMessage] = useState('');
  const [urgent, setUrgent] = useState('');
  const last = useRef<string | null>(null);
  const alerted = useRef({ almost: false, called: false });

  useEffect(() => {
    const url = `/ticket/${eventId}/${ticketId}`;
    let text = '';
    if (phase.phase === 'waiting') text = `You are ${ordinal(phase.position)} in line. Wait ${formatWait(phase.waitSec)}.`;
    else if (phase.phase === 'paused') text = 'The counter is on a short break. You keep your place.';
    else if (phase.phase === 'done') text = phase.status === 'served' ? 'You have been served.' : 'This token is finished.';
    else if (phase.phase === 'closed') text = 'This line has closed.';

    const key = phase.phase === 'waiting' ? `waiting-${phase.position}` : phase.phase;
    const first = last.current === null;
    if (key !== last.current) {
      last.current = key;
      // Skip announcing the initial state: the page content already says it.
      if (!first && text) setMessage(text);
    }

    if (phase.phase === 'called' && !alerted.current.called) {
      alerted.current.called = true;
      setUrgent(`It's your turn. Please go to ${queueName} now.`);
      void alertUser("It's your turn", `Please go to ${queueName} now.`, url);
    } else if (phase.phase === 'waiting' && phase.position <= ALMOST_POSITION && !alerted.current.almost && !first) {
      alerted.current.almost = true;
      void alertUser('Almost your turn', `You're ${ordinal(phase.position)} in line at ${queueName}. Start heading back.`, url);
    }
  }, [phase, queueName, eventId, ticketId]);

  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite">
        {message}
      </div>
      <div className="visually-hidden" role="alert">
        {urgent}
      </div>
    </>
  );
}

function TicketActions({
  eventId,
  eventName,
  ticket,
  queue,
  phase,
}: {
  eventId: string;
  eventName: string;
  ticket: TicketView;
  queue: QueueView | undefined;
  phase: TicketPhase;
}) {
  const toast = useToast();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [support, setSupport] = useState(notifySupport);
  const [busy, setBusy] = useState(false);

  async function enableAlerts() {
    const result = await askToNotify();
    setSupport(result);
    vibrate(80); // a tiny buzz confirms vibration works on this phone
    if (result === 'granted') toast.show("Alerts are on. We'll notify you when it's almost your turn.", { tone: 'success' });
    else if (result === 'denied') toast.show('Notifications are blocked in your browser settings. Keep this page open; your phone will vibrate.');
  }

  async function leave() {
    setConfirmLeave(false);
    setBusy(true);
    try {
      await getSync().perform(eventId, { type: 'ticket.leave', ticketId: ticket.id });
      toast.show('You left the line.');
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not leave the line.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function rejoin() {
    if (!queue) return;
    setBusy(true);
    try {
      const result = await getSync().perform(eventId, { type: 'ticket.join', queueId: queue.id, name: ticket.name });
      if (result.kind === 'ticket') {
        await savePlace('ticket', eventId, eventName, result.ticketId, `Token ${result.number}, ${queue.name}`);
        navigate(`/ticket/${eventId}/${result.ticketId}`, { replace: true });
      }
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not join again.', { tone: 'error' });
      setBusy(false);
    }
  }

  const active = phase.phase === 'waiting' || phase.phase === 'paused' || phase.phase === 'called';
  const canRejoin = phase.phase === 'done' && phase.status !== 'served' && queue && queue.status !== 'closed';

  return (
    <section className="stack" aria-label="Token actions">
      {active && phase.phase !== 'called' && (
        <div className="panel panel-tight">
          <p>
            <strong>You can walk away.</strong> Keep this page open and your phone will buzz when it's almost your turn.
          </p>
          {support === 'default' && (
            <button type="button" className="btn btn-secondary" onClick={enableAlerts}>
              Turn on alerts
            </button>
          )}
          {support === 'unsupported' && <p className="muted">This browser can't show notifications here, so keep this page open.</p>}
        </div>
      )}
      <div className="button-row">
        {canRejoin && (
          <button type="button" className="btn btn-primary" onClick={rejoin} disabled={busy}>
            Join the line again
          </button>
        )}
        {active && (
          <button type="button" className="btn btn-quiet" onClick={() => setConfirmLeave(true)} disabled={busy}>
            Leave the line
          </button>
        )}
        <a className="btn btn-quiet" href={`/e/${eventId}`} onClick={onLinkClick}>
          All queues
        </a>
      </div>
      <ConfirmDialog
        open={confirmLeave}
        title="Leave the line?"
        message={`You'll lose your place (token ${ticket.number}). You can join again later, but you'll go to the end of the line.`}
        confirmLabel="Leave the line"
        danger
        onConfirm={leave}
        onCancel={() => setConfirmLeave(false)}
      />
    </section>
  );
}
