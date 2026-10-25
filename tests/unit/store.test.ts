// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { Op, OpEnvelope } from '../../shared/protocol';
import { Store, viewFor, type Actor, type EventRec } from '../../server/store';

const organizer: Actor = { deviceId: 'org-device', isOrganizer: true };
const alice: Actor = { deviceId: 'alice-device', isOrganizer: false };
const bob: Actor = { deviceId: 'bob-device', isOrganizer: false };

let store: Store;
let event: EventRec;
let opCounter = 0;
let clock = 1_000_000;

function run(actor: Actor, op: Op, opId = `op-${++opCounter}`) {
  const env: OpEnvelope = { opId, eventId: event.id, op, createdAt: clock };
  return store.apply(env, actor, clock);
}

function ok(actor: Actor, op: Op) {
  const { response } = run(actor, op);
  if (!response.ok) throw new Error(`expected ok, got ${response.code}: ${response.message}`);
  return response.result;
}

function makeQueue(): string {
  const result = ok(organizer, { type: 'queue.create', name: 'Food stall', avgServiceSec: 120 });
  if (result.kind !== 'queue') throw new Error('no queue');
  return result.queueId;
}

beforeEach(() => {
  store = new Store();
  event = store.createEvent('Spring Fair', clock).event;
  opCounter = 0;
});

describe('events', () => {
  it('creates a 6 character code and verifies the organizer key', () => {
    const { event: e, organizerKey } = store.createEvent('Fest', clock);
    expect(e.id).toMatch(/^[A-Z2-9]{6}$/);
    expect(store.isOrganizerKey(e.id, organizerKey)).toBe(true);
    expect(store.isOrganizerKey(e.id, 'wrong')).toBe(false);
    // The key itself is never stored, only its hash.
    expect(JSON.stringify(e)).not.toContain(organizerKey);
  });
});

describe('queues', () => {
  it('only lets the organizer create queues', () => {
    const { response } = run(alice, { type: 'queue.create', name: 'Mine', avgServiceSec: 60 });
    expect(response).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('gives tickets increasing numbers and one active ticket per phone', () => {
    const queueId = makeQueue();
    const a1 = ok(alice, { type: 'ticket.join', queueId, name: 'Alice' });
    const b1 = ok(bob, { type: 'ticket.join', queueId, name: '' });
    const a2 = ok(alice, { type: 'ticket.join', queueId, name: 'Alice again' });
    expect(a1).toMatchObject({ kind: 'ticket', number: 1 });
    expect(b1).toMatchObject({ kind: 'ticket', number: 2 });
    expect(a2).toEqual(a1); // same ticket, no second place in line
  });

  it('calls people in order and records who was served', () => {
    const queueId = makeQueue();
    ok(alice, { type: 'ticket.join', queueId, name: '' });
    ok(bob, { type: 'ticket.join', queueId, name: '' });

    expect(ok(organizer, { type: 'queue.callNext', queueId })).toEqual({ kind: 'called', number: 1 });
    clock += 60_000;
    expect(ok(organizer, { type: 'queue.callNext', queueId })).toEqual({ kind: 'called', number: 2 });
    clock += 60_000;
    expect(ok(organizer, { type: 'queue.callNext', queueId })).toEqual({ kind: 'called', number: null });

    const q = viewFor(event, organizer).queues[0]!;
    expect(q.servedCount).toBe(2);
    expect(q.waiting).toEqual([]);
    // Two real 60s services pulled the estimate down from 120s.
    expect(q.avgServiceSec).toBeLessThan(120);
  });

  it('marks a no-show and moves on to the next person', () => {
    const queueId = makeQueue();
    ok(alice, { type: 'ticket.join', queueId, name: '' });
    ok(bob, { type: 'ticket.join', queueId, name: '' });
    ok(organizer, { type: 'queue.callNext', queueId });
    expect(ok(organizer, { type: 'queue.markNoShow', queueId })).toEqual({ kind: 'called', number: 2 });
    expect(viewFor(event, alice).tickets[0]!.status).toBe('noshow');
    expect(viewFor(event, bob).tickets[0]!.status).toBe('called');
  });

  it('lets a person leave the line', () => {
    const queueId = makeQueue();
    const t = ok(alice, { type: 'ticket.join', queueId, name: '' });
    ok(bob, { type: 'ticket.join', queueId, name: '' });
    if (t.kind !== 'ticket') throw new Error();
    expect(run(bob, { type: 'ticket.leave', ticketId: t.ticketId }).response).toMatchObject({ ok: false, code: 'forbidden' });
    ok(alice, { type: 'ticket.leave', ticketId: t.ticketId });
    expect(viewFor(event, alice).queues[0]!.waiting).toEqual([2]);
  });

  it('refuses new people when closed but still serves those in line', () => {
    const queueId = makeQueue();
    ok(alice, { type: 'ticket.join', queueId, name: '' });
    ok(organizer, { type: 'queue.setStatus', queueId, status: 'closed' });
    expect(run(bob, { type: 'ticket.join', queueId, name: '' }).response).toMatchObject({ ok: false, code: 'queue_closed' });
    expect(ok(organizer, { type: 'queue.callNext', queueId })).toEqual({ kind: 'called', number: 1 });
  });

  it('will not call the next person while paused', () => {
    const queueId = makeQueue();
    ok(alice, { type: 'ticket.join', queueId, name: '' });
    ok(organizer, { type: 'queue.setStatus', queueId, status: 'paused' });
    expect(run(organizer, { type: 'queue.callNext', queueId }).response).toMatchObject({ ok: false, code: 'queue_closed' });
  });
});

describe('idempotency', () => {
  it('applies a re-sent op only once and returns the same answer', () => {
    const queueId = makeQueue();
    const first = run(alice, { type: 'ticket.join', queueId, name: '' }, 'same-op');
    const versionAfterFirst = event.version;
    const second = run(alice, { type: 'ticket.join', queueId, name: '' }, 'same-op');
    expect(second.response).toEqual(first.response);
    expect(second.changed).toBe(false);
    expect(event.version).toBe(versionAfterFirst);
  });

  it('remembers failures too', () => {
    const first = run(alice, { type: 'queue.create', name: 'x', avgServiceSec: 60 }, 'bad-op');
    const second = run(organizer, { type: 'queue.create', name: 'x', avgServiceSec: 60 }, 'bad-op');
    expect(second.response).toEqual(first.response);
  });
});

describe('privacy of views', () => {
  it('never shows other people’s names or tickets to visitors', () => {
    const queueId = makeQueue();
    ok(alice, { type: 'ticket.join', queueId, name: 'Alice Secret' });
    const bobView = viewFor(event, bob);
    expect(JSON.stringify(bobView)).not.toContain('Alice Secret');
    expect(bobView.staff).toBeNull();
    expect(viewFor(event, organizer).staff!.tickets[0]!.name).toBe('Alice Secret');
  });

  it('never exposes device ids', () => {
    const queueId = makeQueue();
    ok(alice, { type: 'ticket.join', queueId, name: '' });
    ok(alice, { type: 'tag.create', label: 'Aarav, 6, red shirt', note: '' });
    expect(JSON.stringify(viewFor(event, organizer))).not.toContain('alice-device');
  });
});

describe('safety tags', () => {
  function makeTag(): string {
    const result = ok(alice, { type: 'tag.create', label: 'Aarav, 6, red shirt', note: 'Allergic to peanuts' });
    if (result.kind !== 'tag') throw new Error();
    return result.tagId;
  }

  it('lets one finder claim a tag and chat with the family', () => {
    const tagId = makeTag();
    ok(bob, { type: 'tag.claimFound', tagId });
    const stranger: Actor = { deviceId: 'stranger', isOrganizer: false };
    expect(run(stranger, { type: 'tag.claimFound', tagId }).response).toMatchObject({ ok: false, code: 'already_claimed' });

    ok(bob, { type: 'tag.message', tagId, text: 'He is with me near gate 2' });
    ok(alice, { type: 'tag.message', tagId, text: 'Coming now!' });
    ok(organizer, { type: 'tag.message', tagId, text: 'Staff on the way' });
    expect(run(stranger, { type: 'tag.message', tagId, text: 'hi' }).response).toMatchObject({ ok: false, code: 'forbidden' });

    const familyTag = viewFor(event, alice).tags[0]!;
    expect(familyTag.status).toBe('found');
    expect(familyTag.messages.map((m) => m.role)).toEqual(['finder', 'family', 'staff']);
    expect(viewFor(event, bob).finding[0]!.id).toBe(tagId);
  });

  it('only the finder can share a location', () => {
    const tagId = makeTag();
    expect(run(bob, { type: 'tag.shareLocation', tagId, lat: 12.9, lng: 77.6, accuracyM: 20 }).response).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    ok(bob, { type: 'tag.claimFound', tagId });
    ok(bob, { type: 'tag.shareLocation', tagId, lat: 12.9, lng: 77.6, accuracyM: 20.4 });
    expect(viewFor(event, alice).tags[0]!.location).toMatchObject({ lat: 12.9, lng: 77.6, accuracyM: 20 });
  });

  it('wipes the chat and location once the family is together again', () => {
    const tagId = makeTag();
    ok(alice, { type: 'tag.setLost', tagId, lost: true });
    expect(viewFor(event, organizer).staff!.tags[0]!.status).toBe('lost');
    ok(bob, { type: 'tag.claimFound', tagId });
    ok(bob, { type: 'tag.message', tagId, text: 'Found him' });
    ok(alice, { type: 'tag.resolve', tagId });
    const tag = viewFor(event, alice).tags[0]!;
    expect(tag).toMatchObject({ status: 'safe', claimed: false, messages: [], location: null });
    expect(viewFor(event, bob).finding).toEqual([]);
  });

  it('limits tags per phone and cleans user text', () => {
    for (let i = 0; i < 6; i++) ok(alice, { type: 'tag.create', label: `Child ${i}`, note: '' });
    expect(run(alice, { type: 'tag.create', label: 'One more', note: '' }).response).toMatchObject({ ok: false, code: 'bad_request' });
    const r = ok(bob, { type: 'tag.create', label: '  Ravi \u0007  ', note: '' });
    if (r.kind !== 'tag') throw new Error();
    expect(viewFor(event, bob).tags[0]!.label).toBe('Ravi');
  });
});
