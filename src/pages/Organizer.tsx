import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatWait, timeAgo } from '../../shared/domain';
import { LIMITS, type EventView, type QueueStatus, type QueueView, type TagFullView } from '../../shared/protocol';
import { ChatThread } from '../components/ChatThread';
import { LiveDot } from '../components/ConnectionBar';
import { ConfirmDialog } from '../components/Dialog';
import { Field } from '../components/Field';
import { Loading, Problem, useTitle } from '../components/PageState';
import { QRCode } from '../components/QRCode';
import { Tabs } from '../components/Tabs';
import { useToast } from '../components/Toast';
import { savePlace } from '../lib/places';
import { onLinkClick } from '../lib/router';
import { useShareBase, type ShareBase } from '../lib/useShareBase';
import { OpFailure } from '../sync/client';
import { getSync, useEvent, useNow } from '../sync/hooks';
import { statusText } from './EventHub';

const capturedKeys = new Map<string, string>();

/** The key from a "#k=..." link, remembered per event (safe to call repeatedly). */
function keyFromLink(eventId: string): string | undefined {
  const cached = capturedKeys.get(eventId);
  if (cached) return cached;
  const match = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  if (match) {
    try {
      const key = decodeURIComponent(match[1]!);
      capturedKeys.set(eventId, key);
      return key;
    } catch {
      return undefined;
    }
  }
  return getSync().organizerKey(eventId);
}

/** Reads the organizer key from the link, then removes it from the address bar. */
function useOrganizerKey(eventId: string): string | undefined {
  const [key] = useState(() => keyFromLink(eventId));
  useEffect(() => {
    // Keep the secret out of screenshots, browser history and screen shares.
    if (/(?:^#|&)k=/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
  }, []);
  return key;
}

export default function Organizer({ params }: { params: Record<string, string> }) {
  const eventId = params.eventId!;
  const key = useOrganizerKey(eventId);
  const [knownKey, setKnownKey] = useState(key);
  const state = useEvent(eventId, knownKey);
  const [tab, setTab] = useState('queues');
  const view = state.view;
  useTitle(view ? `Organize ${view.name}` : 'Organizer');

  // A key may still be loading from IndexedDB when the page first renders.
  useEffect(() => {
    if (knownKey) return;
    let cancelled = false;
    void getSync()
      .whenReady()
      .then(() => {
        if (!cancelled) setKnownKey(getSync().organizerKey(eventId));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, knownKey]);

  const eventName = view?.name;
  useEffect(() => {
    if (eventName && view?.role === 'organizer') void savePlace('organizer', eventId, eventName, eventId, eventName);
  }, [eventId, eventName, view?.role]);

  if (!knownKey && state.live) {
    return (
      <Problem title="Organizer link needed">
        <p>To manage this event, open the organizer link you got when the event was created.</p>
      </Problem>
    );
  }
  if (state.error?.code === 'forbidden') {
    return (
      <Problem title="This organizer link isn't valid">
        <p>Ask the person who created the event to send you the staff link again.</p>
      </Problem>
    );
  }
  if (state.error?.code === 'not_found') return <Problem title="Event not found" />;
  if (!view || view.role !== 'organizer' || !view.staff) return <Loading label="Opening dashboard" />;

  const needingHelp = view.staff.tags.filter((t) => t.status !== 'safe').length;

  return (
    <div className="stack-xl">
      <header className="page-head">
        <h1>{view.name}</h1>
        <p className="page-meta">
          <LiveDot live={state.live} label={state.live ? 'Live' : 'Offline'} />
          <span>
            Event code <strong className="code">{view.id}</strong>
          </span>
        </p>
      </header>
      <Tabs
        label="Organizer sections"
        selected={tab}
        onSelect={setTab}
        items={[
          { id: 'queues', label: 'Queues', panel: <QueuesTab eventId={eventId} view={view} /> },
          {
            id: 'lost',
            label: needingHelp > 0 ? `Lost and found (${needingHelp})` : 'Lost and found',
            panel: <LostTab eventId={eventId} tags={view.staff.tags} />,
          },
          { id: 'share', label: 'Share', panel: <ShareTab eventId={eventId} organizerKey={knownKey} view={view} /> },
        ]}
      />
    </div>
  );
}

/* ---------------- Queues ---------------- */

function QueuesTab({ eventId, view }: { eventId: string; view: EventView }) {
  const share = useShareBase();
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState('2');
  const [error, setError] = useState<string | null>(null);

  async function addQueue(event: FormEvent) {
    event.preventDefault();
    const mins = Number(minutes);
    if (!name.trim()) return setError('Name the queue, for example "Food stall" or "Registration desk".');
    if (!Number.isFinite(mins) || mins <= 0 || mins > 60) return setError('Enter the minutes per person, between 0.5 and 60.');
    setError(null);
    try {
      await getSync().perform(eventId, { type: 'queue.create', name: name.trim(), avgServiceSec: Math.round(mins * 60) });
      setName(''); // the new queue appears in the list below, so no extra message is needed
    } catch (err) {
      setError(err instanceof OpFailure ? err.message : 'Could not add the queue.');
    }
  }

  return (
    <div className="stack-xl">
      <form className="panel stack add-queue" onSubmit={addQueue} noValidate>
        <h2>Add a queue</h2>
        <div className="form-row form-row-3">
          <Field label="Queue name" value={name} maxLength={LIMITS.queueName} onChange={(e) => setName(e.target.value)} error={error} />
          <Field
            label="Minutes per person"
            type="number"
            inputMode="decimal"
            min={0.5}
            max={60}
            step={0.5}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            Add queue
          </button>
        </div>
        <p className="field-hint">Minutes per person is a first guess. It adjusts itself from real serving times.</p>
      </form>

      {view.queues.length === 0 ? (
        <ol className="steps">
          <li>Add a queue for each counter, stall or desk.</li>
          <li>Print its QR code and stick it where people line up.</li>
          <li>Open the counter screen and press N to call the next person.</li>
        </ol>
      ) : (
        <>
          <ul className="stack">
            {view.queues.map((q) => (
              <QueueAdmin key={q.id} eventId={eventId} queue={q} share={share} />
            ))}
          </ul>
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
              Print QR posters for all queues
            </button>
          </div>
          <PrintPosters eventId={eventId} eventName={view.name} queues={view.queues} share={share} />
        </>
      )}
    </div>
  );
}

function QueueAdmin({ eventId, queue, share }: { eventId: string; queue: QueueView; share: ShareBase }) {
  const toast = useToast();
  const [showQr, setShowQr] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const joinUrl = `${share.base}/q/${eventId}/${queue.id}`;

  async function setStatus(status: QueueStatus) {
    try {
      await getSync().perform(eventId, { type: 'queue.setStatus', queueId: queue.id, status });
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not change the queue.', { tone: 'error' });
    }
  }

  return (
    <li className="panel queue-admin">
      <div className="queue-card-head">
        <h3>{queue.name}</h3>
        <span className={`badge badge-${queue.status}`}>{statusText(queue.status)}</span>
      </div>
      <p className="queue-admin-stats">
        <span>
          <strong>{queue.waiting.length}</strong> waiting
        </span>
        <span>
          Now serving <strong>{queue.nowServing ?? '–'}</strong>
        </span>
        <span>
          <strong>{queue.servedCount}</strong> served
        </span>
      </p>
      <div className="button-row">
        <a className="btn btn-primary" href={`/counter/${eventId}/${queue.id}`} onClick={onLinkClick}>
          Open counter screen
        </a>
        <button type="button" className="btn btn-secondary" aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>
          {showQr ? 'Done' : 'More'}
        </button>
      </div>
      {showQr && (
        <div className="queue-more reveal">
          <div className="qr-block">
            <QRCode value={joinUrl} label={`QR code to join ${queue.name}`} size={160} />
            <div className="stack">
              <p className="muted">Visitors scan this to join. About {formatWait(queue.avgServiceSec).replace('about ', '')} per person.</p>
              <p className="qr-url">{joinUrl}</p>
            </div>
          </div>
          <div className="button-row">
            {queue.status === 'open' ? (
              <button type="button" className="btn btn-secondary" onClick={() => setStatus('paused')}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => setStatus('open')}>
                {queue.status === 'paused' ? 'Resume' : 'Reopen'}
              </button>
            )}
            {queue.status !== 'closed' && (
              <button type="button" className="btn btn-quiet" onClick={() => setConfirmClose(true)}>
                Close to new people
              </button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmClose}
        title={`Close ${queue.name}?`}
        message="Nobody new can join. People already in line keep their place and you can still call them."
        confirmLabel="Close to new people"
        onConfirm={() => {
          setConfirmClose(false);
          void setStatus('closed');
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </li>
  );
}

/** Hidden on screen; this is what "Print QR posters" prints. */
function PrintPosters({ eventId, eventName, queues, share }: { eventId: string; eventName: string; queues: QueueView[]; share: ShareBase }) {
  return (
    <div className="print-only" aria-hidden="true">
      {queues.map((q) => (
        <section key={q.id} className="poster">
          <p className="poster-event">{eventName}</p>
          <h2 className="poster-title">{q.name}</h2>
          <p className="poster-lead">Scan to get a token and wait anywhere</p>
          <QRCode value={`${share.base}/q/${eventId}/${q.id}`} label="" size={360} />
          <p className="poster-code">
            No camera? Open {share.base.replace(/^https?:\/\//, '')} and enter code {eventId}
          </p>
        </section>
      ))}
    </div>
  );
}

/* ---------------- Lost and found ---------------- */

function LostTab({ eventId, tags }: { eventId: string; tags: TagFullView[] }) {
  const needing = useMemo(
    () =>
      tags
        .filter((t) => t.status !== 'safe')
        .sort((a, b) => (a.status === b.status ? (b.lostAt ?? b.foundAt ?? 0) - (a.lostAt ?? a.foundAt ?? 0) : a.status === 'lost' ? -1 : 1)),
    [tags],
  );
  const safeCount = tags.length - needing.length;

  return (
    <div className="stack-xl">
      <p className="muted">
        {tags.length === 0
          ? 'No safety tags yet. Families create them from the event page.'
          : `${tags.length} ${tags.length === 1 ? 'person is' : 'people are'} wearing a safety tag. ${safeCount} with their family.`}
      </p>
      {needing.length === 0 ? (
        <p className="empty">Nobody is missing. When a family reports someone missing, or a stranger scans a tag, it appears here instantly.</p>
      ) : (
        <ul className="stack">
          {needing.map((tag) => (
            <LostCard key={tag.id} eventId={eventId} tag={tag} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LostCard({ eventId, tag }: { eventId: string; tag: TagFullView }) {
  const now = useNow();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);

  async function resolve() {
    setConfirm(false);
    try {
      await getSync().perform(eventId, { type: 'tag.resolve', tagId: tag.id });
      toast.show(`${tag.label.split(',')[0]} is marked as back with their family.`, { tone: 'success' });
    } catch (err) {
      toast.show(err instanceof OpFailure ? err.message : 'Could not update the tag.', { tone: 'error' });
    }
  }

  return (
    <li className={`panel lost-card lost-${tag.status}`}>
      <div className="queue-card-head">
        <h3>{tag.label}</h3>
        <span className={`badge badge-${tag.status}`}>{tag.status === 'lost' ? 'Missing' : 'Found by a helper'}</span>
      </div>
      <p className="muted">
        {tag.status === 'lost' && tag.lostAt && `Reported missing ${timeAgo(tag.lostAt, now)}.`}
        {tag.status === 'found' && tag.foundAt && `Tag scanned ${timeAgo(tag.foundAt, now)}.`}
      </p>
      {tag.note && <p>{tag.note}</p>}
      {tag.location && (
        <p>
          <a
            href={`https://www.openstreetmap.org/?mlat=${tag.location.lat}&mlon=${tag.location.lng}#map=19/${tag.location.lat}/${tag.location.lng}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Helper's location (about {tag.location.accuracyM} m)
          </a>
        </p>
      )}
      {tag.status === 'found' && (
        <ChatThread
          messages={tag.messages}
          me="staff"
          emptyText="No messages yet."
          inputLabel={`Message about ${tag.label}`}
          onSend={async (text) => {
            await getSync().perform(eventId, { type: 'tag.message', tagId: tag.id, text });
          }}
        />
      )}
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>
          Mark as back with family
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Back with their family?"
        message="This closes the case and deletes the chat and location."
        confirmLabel="Yes, they're together"
        onConfirm={resolve}
        onCancel={() => setConfirm(false)}
      />
    </li>
  );
}

/* ---------------- Share ---------------- */

function ShareTab({ eventId, organizerKey, view }: { eventId: string; organizerKey: string | undefined; view: EventView }) {
  const share = useShareBase();
  const toast = useToast();
  const visitorUrl = `${share.base}/e/${eventId}`;
  const staffUrl = organizerKey ? `${share.base}/organize/${eventId}#k=${encodeURIComponent(organizerKey)}` : null;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(`${what} copied.`, { tone: 'success' });
    } catch {
      window.prompt(`Copy the ${what.toLowerCase()}:`, text);
    }
  }

  return (
    <div className="stack-xl">
      {share.localOnly && (
        <p className="notice">
          {share.lanAddress
            ? `You opened CrowdMate on localhost, which phones can't reach. Links and QR codes below use this computer's Wi-Fi address (${share.lanAddress}) so phones on the same Wi-Fi can open them.`
            : "You opened CrowdMate on localhost, which phones can't reach. Open it using this computer's Wi-Fi address so QR codes work on phones."}
        </p>
      )}
      <section className="panel stack" aria-labelledby="visitor-link">
        <h2 id="visitor-link">For visitors</h2>
        <p className="muted">
          Put this on an entrance poster. Visitors see every queue and can create safety tags. Event code:{' '}
          <strong className="code">{view.id}</strong>
        </p>
        <QRCode value={visitorUrl} label="QR code for the event page" size={200} />
        <p className="qr-url">{visitorUrl}</p>
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => copy(visitorUrl, 'Visitor link')}>
            Copy visitor link
          </button>
        </div>
      </section>
      {staffUrl && (
        <section className="panel stack" aria-labelledby="staff-link">
          <h2 id="staff-link">For your staff</h2>
          <p>
            Anyone with this link can run every counter and see the lost and found board. Share it only with your team, in
            person or a private message.
          </p>
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => copy(staffUrl, 'Staff link')}>
              Copy staff link
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
