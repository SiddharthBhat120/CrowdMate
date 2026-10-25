import { useEffect, useRef, useState } from 'react';
import type { TagFullView, TagPublicView } from '../../shared/protocol';
import { ChatThread } from '../components/ChatThread';
import { Loading, Problem, useTitle } from '../components/PageState';
import { useToast } from '../components/Toast';
import { navigate } from '../lib/router';
import { OpFailure } from '../sync/client';
import { getSync, useConnection, useEvent } from '../sync/hooks';

type Lookup = { state: 'loading' } | { state: 'missing' } | { state: 'ok'; tag: TagPublicView } | { state: 'offline' };

/**
 * Opened by a stranger who scanned a safety tag. Must load fast and be
 * impossible to misunderstand: one big button, then a chat.
 */
export function Finder({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const tagId = params.tagId!;
  const event = useEvent(eventId);
  const toast = useToast();
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const { status } = useConnection();
  useTitle('You found someone');

  const mine = event.view?.tags.find((t) => t.id === tagId);
  const helping = event.view?.finding.find((t) => t.id === tagId);
  // Remember that this phone helped, so we can say thank you once the case is closed.
  const helped = useRef(false);
  if (helping) helped.current = true;

  // The family scanning their own tag gets their own page instead.
  useEffect(() => {
    if (mine) navigate(`/tag/${eventId}/${tagId}`, { replace: true });
  }, [mine, eventId, tagId]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${encodeURIComponent(eventId)}/tags/${encodeURIComponent(tagId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) setLookup({ state: 'missing' });
        else if (res.ok) setLookup({ state: 'ok', tag: (await res.json()) as TagPublicView });
        else setLookup({ state: 'offline' });
      })
      .catch(() => {
        if (!cancelled) setLookup({ state: 'offline' });
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, tagId]);

  async function claim() {
    setClaiming(true);
    setClaimError(null);
    try {
      await getSync().perform(eventId, { type: 'tag.claimFound', tagId });
    } catch (err) {
      setClaimError(err instanceof OpFailure ? err.message : 'Could not alert the family. Try again.');
    } finally {
      setClaiming(false);
    }
  }

  if (helping) return <Helping eventId={eventId} tag={helping} onShareError={(m) => toast.show(m, { tone: 'error' })} />;

  if (helped.current && event.live) {
    return (
      <section className="stack-xl narrow">
        <h1>They're back with their family</h1>
        <p className="lede">Thank you for helping. The conversation and any shared location have been deleted.</p>
      </section>
    );
  }

  if (lookup.state === 'loading' && !event.view) return <Loading label="Reading the tag" />;

  if (lookup.state === 'missing' || event.error?.code === 'not_found') {
    return (
      <Problem title="This tag isn't active">
        <p>Please take the person to the event's help desk or security staff.</p>
      </Problem>
    );
  }

  const tag = lookup.state === 'ok' ? lookup.tag : null;
  // Wait for our own live data before deciding: the "someone" helping may be this phone.
  if (tag?.claimed && !event.live) return <Loading label="Reading the tag" />;
  if (tag?.claimed) {
    return (
      <Problem title="Someone is already helping">
        <p>Another person has already contacted {tag.label.split(',')[0]}'s family. Please take them to the help desk or event staff.</p>
      </Problem>
    );
  }

  return (
    <div className="stack-xl narrow">
      <header className="page-head">
        <h1>You found someone who needs help</h1>
        {tag && <p className="found-label">{tag.label}</p>}
      </header>
      <p className="lede">Thank you for stopping. Tap the button and their family is alerted on their phone right away. You can then chat with them here.</p>
      <ul className="checklist">
        <li>Your phone number and name stay private.</li>
        <li>If it's safe, please stay where you are with them.</li>
      </ul>
      <div>
        <button type="button" className="btn btn-alert btn-large" onClick={claim} disabled={claiming}>
          {claiming ? 'Alerting their family…' : 'Alert their family'}
        </button>
      </div>
      {claiming && status !== 'online' && (
        <p className="notice" role="status">
          No signal right now. Your alert is saved and will be sent the moment your phone reconnects. Event staff can also help.
        </p>
      )}
      {lookup.state === 'offline' && !claiming && (
        <p className="muted">You seem to be offline. You can still tap the button; the alert sends when you reconnect.</p>
      )}
      {claimError && (
        <p className="field-error" role="alert">
          {claimError}
        </p>
      )}
    </div>
  );
}

function Helping({ eventId, tag, onShareError }: { eventId: string; tag: TagFullView; onShareError: (message: string) => void }) {
  const [sharing, setSharing] = useState(false);
  const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext;

  function shareLocation() {
    if (!canLocate) return;
    setSharing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        getSync()
          .perform(eventId, {
            type: 'tag.shareLocation',
            tagId: tag.id,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: pos.coords.accuracy,
          })
          .catch((err: unknown) => onShareError(err instanceof OpFailure ? err.message : 'Could not share your location.'))
          .finally(() => setSharing(false));
      },
      () => {
        setSharing(false);
        onShareError('Location is turned off or blocked. Describe where you are in the chat instead.');
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  }

  return (
    <div className="stack-xl narrow">
      <header className="page-head">
        <h1>Their family has been alerted</h1>
        <p className="found-label">{tag.label}</p>
      </header>
      {tag.note && (
        <div className="panel panel-tight">
          <h2 className="h-small">From the family</h2>
          <p>{tag.note}</p>
        </div>
      )}
      <section className="panel" aria-labelledby="chat-heading">
        <h2 id="chat-heading">Chat with the family</h2>
        <ChatThread
          messages={tag.messages}
          me="finder"
          emptyText="Say where you are, for example: near the main gate, next to the ice-cream stall."
          inputLabel="Message to the family"
          onSend={async (text) => {
            await getSync().perform(eventId, { type: 'tag.message', tagId: tag.id, text });
          }}
        />
      </section>
      {canLocate ? (
        <div className="stack">
          <button type="button" className="btn btn-secondary" onClick={shareLocation} disabled={sharing}>
            {sharing ? 'Finding your location…' : tag.location ? 'Update my location' : 'Share my location'}
          </button>
          <p className="muted">Only the family and event staff can see it, and it's deleted once they're together again.</p>
        </div>
      ) : (
        <p className="muted">Location sharing needs a secure (https) connection. Describe where you are in the chat.</p>
      )}
    </div>
  );
}
