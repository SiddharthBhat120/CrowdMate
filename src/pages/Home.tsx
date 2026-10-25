import { useEffect, useState, type FormEvent } from 'react';
import { isEventCode, LIMITS } from '../../shared/protocol';
import { Field } from '../components/Field';
import { useTitle } from '../components/PageState';
import type { Place } from '../lib/idb';
import { forgetPlace, listPlaces, placeHref, savePlace } from '../lib/places';
import { navigate, onLinkClick } from '../lib/router';
import { useConnection } from '../sync/hooks';

const KIND_TEXT: Record<Place['kind'], string> = {
  organizer: 'You run this event',
  ticket: 'Your token',
  tag: 'Safety tag',
  event: 'Visited',
};

export function Home() {
  useTitle('');
  const [places, setPlaces] = useState<Place[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPlaces().then((list) => {
      if (!cancelled) setPlaces(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function forget(key: string) {
    await forgetPlace(key);
    setPlaces((list) => list?.filter((p) => p.key !== key) ?? null);
  }

  return (
    <div className="stack-xl">
      <section className="hero hero-grid">
        <div>
          <h1 className="hero-title">Skip the line. Stay together.</h1>
          <p className="lede">
            Scan a QR code to get a live token for any queue, then walk away. Your phone tells you when it's your turn. No app
            needed.
          </p>
        </div>
        <LiveDemo />
      </section>

      <div className="path-grid">
        <JoinByCode />
        <CreateEvent />
      </div>

      {places && places.length > 0 && (
        <section className="stack" aria-labelledby="on-phone">
          <h2 id="on-phone">Saved on this phone</h2>
          <ul className="place-list">
            {places.map((place) => (
              <li key={place.key} className="place">
                <a href={placeHref(place)} onClick={onLinkClick} className="place-link">
                  <span className="place-label">{place.label}</span>
                  <span className="place-meta">
                    {KIND_TEXT[place.kind]}, {place.eventName}
                  </span>
                </a>
                <button type="button" className="btn btn-quiet btn-small" onClick={() => forget(place.key)} aria-label={`Remove ${place.label} from this list`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A sample token that counts down by itself, so first-time visitors see what "live" means. */
function LiveDemo() {
  const [ahead, setAhead] = useState(4);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setAhead((n) => (n === 0 ? 4 : n - 1)), 2200);
    return () => clearInterval(timer);
  }, []);
  const called = ahead === 0;
  return (
    <figure className="hero-figure">
      <div className={`slip slip-sample ${called ? 'slip-called' : 'slip-waiting'}`} aria-hidden="true">
        <div className="slip-top">
          <p className="slip-queue">Food court</p>
        </div>
        <p className="slip-number">42</p>
        <div className="slip-bottom">
          <p key={ahead} className="slip-status pop">
            {called ? "It's your turn" : ahead === 1 ? "You're next" : `${ahead} people ahead`}
          </p>
        </div>
      </div>
      <figcaption className="slip-sample-caption">A visitor's phone, updating live</figcaption>
    </figure>
  );
}

function JoinByCode() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = code.trim().toUpperCase();
    if (!isEventCode(value)) {
      setError('Event codes have 6 letters or numbers, like K7P2QX.');
      return;
    }
    navigate(`/e/${value}`);
  }

  return (
    <section className="path-card path-join" aria-labelledby="join-heading">
      <h2 id="join-heading">I'm visiting</h2>
      <p className="muted">Enter the code from the event poster.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <Field
          label="Event code"
                    value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError(null);
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={6}
          className="code-input"
          error={error}
        />
        <button type="submit" className="btn btn-primary">
          Open event
        </button>
      </form>
    </section>
  );
}

function CreateEvent() {
  const { status } = useConnection();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setError('Give your event a name, for example "Spring Fair 2026".');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      });
      const data = (await res.json()) as { eventId?: string; organizerKey?: string; error?: string };
      if (!res.ok || !data.eventId || !data.organizerKey) throw new Error(data.error ?? 'Could not create the event.');
      await savePlace('organizer', data.eventId, value, data.eventId, value);
      // The key travels in the #fragment, which browsers never send to servers or in Referer headers.
      navigate(`/organize/${data.eventId}#k=${encodeURIComponent(data.organizerKey)}`);
    } catch (err) {
      setError(
        status === 'offline'
          ? 'Creating an event needs an internet connection. Try again when you are back online.'
          : err instanceof Error
            ? err.message
            : 'Could not create the event.',
      );
      setBusy(false);
    }
  }

  return (
    <section className="path-card path-run" aria-labelledby="create-heading">
      <h2 id="create-heading">I'm organizing</h2>
      <p className="muted">Set up queues for a fair, fest, clinic or office.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <Field
          label="Event name"
          value={name}
          maxLength={LIMITS.eventName}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          error={error}
        />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create event'}
        </button>
      </form>
    </section>
  );
}
