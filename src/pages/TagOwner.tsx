import { useEffect, useRef, useState } from 'react';
import { timeAgo } from '../../shared/domain';
import type { TagFullView } from '../../shared/protocol';
import { ChatThread } from '../components/ChatThread';
import { LiveDot } from '../components/ConnectionBar';
import { ConfirmDialog } from '../components/Dialog';
import { Loading, Problem, useTitle } from '../components/PageState';
import { QRCode } from '../components/QRCode';
import { useToast } from '../components/Toast';
import { alertUser } from '../lib/alerts';
import { forgetPlace } from '../lib/places';
import { navigate, onLinkClick } from '../lib/router';
import { useShareBase } from '../lib/useShareBase';
import { OpFailure } from '../sync/client';
import { getSync, useEvent, useNow } from '../sync/hooks';

/** The family's view of one safety tag. */
export default function TagOwner({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const tagId = params.tagId!;
  const state = useEvent(eventId);
  const tag = state.view?.tags.find((t) => t.id === tagId);
  useTitle(tag ? (tag.status === 'found' ? `${tag.label}: found` : tag.label) : 'Safety tag');

  if (!state.view || !tag) {
    if (state.error?.code === 'not_found') return <Problem title="Event not found" />;
    if (state.view && state.live && !tag) {
      return (
        <Problem title="This tag isn't on this phone">
          <p>A safety tag can only be managed from the phone that created it.</p>
        </Problem>
      );
    }
    return <Loading label="Opening safety tag" />;
  }

  return (
    <div className="stack-xl narrow">
      <p className="page-kicker">
        <a href={`/e/${eventId}`} onClick={onLinkClick}>
          {state.view.name}
        </a>
      </p>
      <header className="page-head">
        <h1>{tag.label}</h1>
        <p className="page-meta">
          <LiveDot live={state.live} label={state.live ? 'Live' : 'Offline, showing saved copy'} />
        </p>
      </header>
      <FoundAlert tag={tag} />
      {tag.status === 'found' ? (
        <FoundPanel eventId={eventId} tag={tag} />
      ) : (
        <SafePanel eventId={eventId} eventName={state.view.name} tag={tag} />
      )}
    </div>
  );
}

/** Buzz and announce the moment someone finds them. */
function FoundAlert({ tag }: { tag: TagFullView }) {
  const previous = useRef(tag.status);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (tag.status === 'found' && previous.current !== 'found') {
      setMessage(`Someone found ${tag.label}. Open the chat below.`);
      void alertUser(`Someone found ${tag.label.split(',')[0]}`, 'Open CrowdMate to chat with them now.', location.pathname);
    }
    previous.current = tag.status;
  }, [tag.status, tag.label]);
  return (
    <div className="visually-hidden" role="alert">
      {message}
    </div>
  );
}

function SafePanel({ eventId, eventName, tag }: { eventId: string; eventName: string; tag: TagFullView }) {
  const share = useShareBase();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const finderUrl = `${share.base}/f/${eventId}/${tag.id}`;
  const lost = tag.status === 'lost';

  async function setLost(value: boolean) {
    try {
      await getSync().perform(eventId, { type: 'tag.setLost', tagId: tag.id, lost: value });
      toast.show(value ? 'Event staff can now see that they are missing.' : 'Glad you found them.', { tone: value ? 'info' : 'success' });
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not update the tag.', { tone: 'error' });
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Tag link copied. Anyone who opens it can alert you.', { tone: 'success' });
    } catch {
      window.prompt('Copy the tag link:', url); // clipboard needs https; this works everywhere
    }
  }

  async function remove() {
    setConfirmDelete(false);
    try {
      await getSync().perform(eventId, { type: 'tag.remove', tagId: tag.id });
      await forgetPlace(`tag:${eventId}:${tag.id}`);
      navigate(`/e/${eventId}`, { replace: true });
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not delete the tag.', { tone: 'error' });
    }
  }

  return (
    <>
      {lost ? (
        <section className="alert-panel" aria-labelledby="lost-heading">
          <h2 id="lost-heading">Marked as missing</h2>
          <p>
            Event staff can see this now. Anyone who scans the tag alerts you here instantly. Keep this page open.
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => setLost(false)}>
            I found them myself
          </button>
        </section>
      ) : (
        <section className="panel" aria-labelledby="print-heading">
          <h2 id="print-heading">Print or show this tag</h2>
          <p className="muted">
            Stick it on a wristband, ID card or the back of a phone. Anyone who scans it can message you without seeing your
            number.
          </p>
          <div className="tag-print">
            <div className="tag-card">
              <QRCode value={finderUrl} label={`QR code for ${tag.label}'s safety tag`} size={168} />
              <p className="tag-card-text">If I'm lost, please scan me</p>
              <p className="tag-card-small">
                {eventName}, CrowdMate
              </p>
            </div>
          </div>
          {share.localOnly && !share.lanAddress && (
            <p className="notice">This page runs on localhost, so other phones can't open this QR code. Open CrowdMate using this computer's Wi-Fi address instead.</p>
          )}
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => window.print()}>
              Print tag
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => copyLink(finderUrl)}>
              Copy tag link
            </button>
            <button type="button" className="btn btn-alert" onClick={() => setLost(true)}>
              Report missing
            </button>
          </div>
        </section>
      )}
      {tag.note && (
        <section className="panel panel-tight">
          <h2 className="h-small">Shown to whoever finds them</h2>
          <p>{tag.note}</p>
        </section>
      )}
      <div>
        <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(true)}>
          Delete this tag
        </button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this safety tag?"
        message="Printed copies will stop working. You can create a new tag any time."
        confirmLabel="Delete tag"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

function FoundPanel({ eventId, tag }: { eventId: string; tag: TagFullView }) {
  const toast = useToast();
  const now = useNow();
  const [confirm, setConfirm] = useState(false);
  const firstName = tag.label.split(',')[0];

  async function resolve() {
    setConfirm(false);
    try {
      await getSync().perform(eventId, { type: 'tag.resolve', tagId: tag.id });
      toast.show(`So glad you're together again. The chat has been deleted.`, { tone: 'success' });
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not update the tag.', { tone: 'error' });
    }
  }

  return (
    <>
      <section className="alert-panel alert-found" aria-labelledby="found-heading">
        <h2 id="found-heading">Someone found {firstName}</h2>
        <p>{tag.foundAt ? `They scanned the tag ${timeAgo(tag.foundAt, now)}.` : 'They scanned the tag.'} Chat with them below.</p>
      </section>
      {tag.location && (
        <section className="panel panel-tight" aria-labelledby="loc-heading">
          <h2 id="loc-heading" className="h-small">
            Shared location
          </h2>
          <p>
            Accurate to about {tag.location.accuracyM} m, shared {timeAgo(tag.location.at, now)}.
          </p>
          <a
            className="btn btn-secondary"
            href={`https://www.openstreetmap.org/?mlat=${tag.location.lat}&mlon=${tag.location.lng}#map=19/${tag.location.lat}/${tag.location.lng}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open in map
          </a>
        </section>
      )}
      <section className="panel" aria-labelledby="chat-heading">
        <h2 id="chat-heading">Chat with the helper</h2>
        <ChatThread
          messages={tag.messages}
          me="family"
          emptyText="No messages yet. Ask where they are."
          inputLabel="Message to the helper"
          onSend={async (text) => {
            await getSync().perform(eventId, { type: 'tag.message', tagId: tag.id, text });
          }}
        />
      </section>
      <div>
        <button type="button" className="btn btn-primary btn-large" onClick={() => setConfirm(true)}>
          We're together again
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Are you together again?"
        message="This closes the chat and deletes the messages and location. The tag stays active for the rest of the event."
        confirmLabel="Yes, we're together"
        onConfirm={resolve}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}
