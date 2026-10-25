/**
 * The single source of truth for every event, queue, ticket and safety tag.
 *
 * All changes go through `apply()`, which:
 *   1. returns the stored answer if this opId was already applied (idempotency),
 *   2. checks permissions and input,
 *   3. mutates state and bumps the event's version number.
 * Clients compare version numbers to know whether their copy is stale.
 */
import { nextAverage } from '../shared/domain';
import type {
  ChatMessage,
  ChatRole,
  ErrorCode,
  EventPublicView,
  EventView,
  FinderLocation,
  Op,
  OpEnvelope,
  OpResult,
  QueueStatus,
  StaffView,
  QueueView,
  TagFullView,
  TagPublicView,
  TagStatus,
  TicketStatus,
  TicketView,
} from '../shared/protocol';
import { LIMITS } from '../shared/protocol';
import { hashSecret, newEventCode, newId, newSecret, secretMatches } from './ids';
import { cleanText } from './validate';

/* ---------- Stored records (contain secrets; never sent as-is) ---------- */

export interface TicketRec {
  id: string;
  queueId: string;
  number: number;
  deviceId: string;
  name: string;
  status: TicketStatus;
  joinedAt: number;
  calledAt: number | null;
  finishedAt: number | null;
}

export interface QueueRec {
  id: string;
  name: string;
  status: QueueStatus;
  nextNumber: number;
  /** Ticket ids, in line order. */
  waiting: string[];
  /** Ticket id at the counter. */
  current: string | null;
  avgServiceSec: number;
  samples: number;
  servedCount: number;
}

export interface TagRec {
  id: string;
  ownerDeviceId: string;
  finderDeviceId: string | null;
  label: string;
  note: string;
  status: TagStatus;
  createdAt: number;
  lostAt: number | null;
  foundAt: number | null;
  messages: ChatMessage[];
  location: FinderLocation | null;
}

export type OpResponse =
  | { ok: true; result: OpResult }
  | { ok: false; code: ErrorCode; message: string };

export interface EventRec {
  id: string;
  name: string;
  organizerKeyHash: string;
  createdAt: number;
  version: number;
  queues: QueueRec[];
  tickets: Record<string, TicketRec>;
  tags: Record<string, TagRec>;
  /** Recently applied op ids and their answers, oldest first. */
  appliedOps: [string, OpResponse][];
}

export interface Actor {
  deviceId: string;
  /** True when this connection proved it holds the organizer key. */
  isOrganizer: boolean;
}

const MAX_REMEMBERED_OPS = 2000;
const MAX_FINISHED_TICKETS_SHOWN = 30;

class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: ErrorCode, message: string): never {
  throw new OpError(code, message);
}

/* ---------- Views ---------- */

function queueView(event: EventRec, q: QueueRec): QueueView {
  const numberOf = (ticketId: string) => event.tickets[ticketId]?.number ?? -1;
  return {
    id: q.id,
    name: q.name,
    status: q.status,
    waiting: q.waiting.map(numberOf).filter((n) => n >= 0),
    nowServing: q.current ? numberOf(q.current) : null,
    avgServiceSec: q.avgServiceSec,
    servedCount: q.servedCount,
  };
}

function ticketView(t: TicketRec): TicketView {
  return {
    id: t.id,
    queueId: t.queueId,
    number: t.number,
    name: t.name,
    status: t.status,
    joinedAt: t.joinedAt,
    calledAt: t.calledAt,
    finishedAt: t.finishedAt,
  };
}

export function tagPublicView(tag: TagRec): TagPublicView {
  return { id: tag.id, label: tag.label, status: tag.status, claimed: tag.finderDeviceId !== null };
}

function tagFullView(tag: TagRec): TagFullView {
  return {
    ...tagPublicView(tag),
    note: tag.note,
    createdAt: tag.createdAt,
    lostAt: tag.lostAt,
    foundAt: tag.foundAt,
    messages: tag.messages,
    location: tag.location,
  };
}

export function publicView(event: EventRec): EventPublicView {
  return {
    id: event.id,
    name: event.name,
    createdAt: event.createdAt,
    queues: event.queues.map((q) => queueView(event, q)),
  };
}

export function viewFor(event: EventRec, actor: Actor): EventView {
  const allTickets = Object.values(event.tickets);
  const allTags = Object.values(event.tags).sort((a, b) => a.createdAt - b.createdAt);
  const mine = allTickets
    .filter((t) => t.deviceId === actor.deviceId)
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .slice(0, 20);

  let staff: StaffView | null = null;
  if (actor.isOrganizer) {
    const active = allTickets.filter((t) => t.status === 'waiting' || t.status === 'called');
    const finished = allTickets
      .filter((t) => t.finishedAt !== null)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, MAX_FINISHED_TICKETS_SHOWN);
    staff = { tickets: [...active, ...finished].map(ticketView), tags: allTags.map(tagFullView) };
  }

  return {
    ...publicView(event),
    role: actor.isOrganizer ? 'organizer' : 'visitor',
    tickets: mine.map(ticketView),
    tags: allTags.filter((t) => t.ownerDeviceId === actor.deviceId).map(tagFullView),
    finding: allTags.filter((t) => t.finderDeviceId === actor.deviceId).map(tagFullView),
    staff,
  };
}

/* ---------- Store ---------- */

export class Store {
  private events = new Map<string, EventRec>();

  constructor(initial: EventRec[] = []) {
    for (const e of initial) this.events.set(e.id, e);
  }

  all(): EventRec[] {
    return [...this.events.values()];
  }

  get(eventId: string): EventRec | undefined {
    return this.events.get(eventId);
  }

  createEvent(name: string, now: number): { event: EventRec; organizerKey: string } {
    let id = newEventCode();
    while (this.events.has(id)) id = newEventCode();
    const organizerKey = newSecret();
    const event: EventRec = {
      id,
      name,
      organizerKeyHash: hashSecret(organizerKey),
      createdAt: now,
      version: 1,
      queues: [],
      tickets: {},
      tags: {},
      appliedOps: [],
    };
    this.events.set(id, event);
    return { event, organizerKey };
  }

  isOrganizerKey(eventId: string, key: string): boolean {
    const event = this.events.get(eventId);
    return !!event && secretMatches(key, event.organizerKeyHash);
  }

  /** Apply one op. Never throws; errors come back as `{ ok: false }`. */
  apply(env: OpEnvelope, actor: Actor, now: number): { response: OpResponse; changed: boolean } {
    const event = this.events.get(env.eventId);
    if (!event) return { response: { ok: false, code: 'not_found', message: 'This event no longer exists.' }, changed: false };

    const seen = event.appliedOps.find(([id]) => id === env.opId);
    if (seen) return { response: seen[1], changed: false };

    let response: OpResponse;
    let changed = false;
    try {
      const result = applyOp(event, env.op, actor, now);
      response = { ok: true, result };
      changed = true;
      event.version += 1;
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      response = { ok: false, code: err.code, message: err.message };
    }
    event.appliedOps.push([env.opId, response]);
    if (event.appliedOps.length > MAX_REMEMBERED_OPS) event.appliedOps.splice(0, event.appliedOps.length - MAX_REMEMBERED_OPS);
    return { response, changed };
  }
}

/* ---------- Op handlers ---------- */

function requireOrganizer(actor: Actor) {
  if (!actor.isOrganizer) fail('forbidden', 'Only the organizer can do this.');
}

function findQueue(event: EventRec, queueId: string): QueueRec {
  return event.queues.find((q) => q.id === queueId) ?? fail('not_found', 'That queue was not found.');
}

function findTag(event: EventRec, tagId: string): TagRec {
  return event.tags[tagId] ?? fail('not_found', 'That safety tag was not found.');
}

function finishTicket(q: QueueRec, t: TicketRec, status: 'served' | 'noshow' | 'left', now: number) {
  t.status = status;
  t.finishedAt = now;
  if (status === 'served') {
    q.servedCount += 1;
    if (t.calledAt !== null) {
      q.avgServiceSec = nextAverage(q.avgServiceSec, (now - t.calledAt) / 1000, q.samples, {
        min: LIMITS.minServiceSec,
        max: LIMITS.maxServiceSec,
      });
      q.samples += 1;
    }
  }
  if (q.current === t.id) q.current = null;
}

function callNext(event: EventRec, q: QueueRec, now: number): number | null {
  const nextId = q.waiting.shift();
  if (!nextId) return null;
  const t = event.tickets[nextId];
  if (!t) return null;
  t.status = 'called';
  t.calledAt = now;
  q.current = t.id;
  return t.number;
}

function roleFor(tag: TagRec, actor: Actor): ChatRole | null {
  if (tag.ownerDeviceId === actor.deviceId) return 'family';
  if (tag.finderDeviceId === actor.deviceId) return 'finder';
  if (actor.isOrganizer) return 'staff';
  return null;
}

function applyOp(event: EventRec, op: Op, actor: Actor, now: number): OpResult {
  switch (op.type) {
    case 'queue.create': {
      requireOrganizer(actor);
      const name = cleanText(op.name, LIMITS.queueName);
      if (!name) fail('bad_request', 'Give the queue a name.');
      if (event.queues.length >= LIMITS.queuesPerEvent) fail('bad_request', `An event can have at most ${LIMITS.queuesPerEvent} queues.`);
      const avg = Math.round(Math.min(LIMITS.maxServiceSec, Math.max(LIMITS.minServiceSec, op.avgServiceSec)));
      const queue: QueueRec = {
        id: newId(),
        name,
        status: 'open',
        nextNumber: 1,
        waiting: [],
        current: null,
        avgServiceSec: avg,
        samples: 0,
        servedCount: 0,
      };
      event.queues.push(queue);
      return { kind: 'queue', queueId: queue.id };
    }

    case 'queue.setStatus': {
      requireOrganizer(actor);
      findQueue(event, op.queueId).status = op.status;
      return { kind: 'none' };
    }

    case 'queue.callNext': {
      requireOrganizer(actor);
      const q = findQueue(event, op.queueId);
      if (q.status === 'paused') fail('queue_closed', 'Resume the queue before calling the next person.');
      const current = q.current ? event.tickets[q.current] : undefined;
      if (current) finishTicket(q, current, 'served', now);
      return { kind: 'called', number: callNext(event, q, now) };
    }

    case 'queue.markNoShow': {
      requireOrganizer(actor);
      const q = findQueue(event, op.queueId);
      const current = q.current ? event.tickets[q.current] : undefined;
      if (!current) fail('bad_request', 'Nobody is at the counter right now.');
      else finishTicket(q, current, 'noshow', now);
      const number = q.status === 'paused' ? null : callNext(event, q, now);
      return { kind: 'called', number };
    }

    case 'queue.finishCurrent': {
      requireOrganizer(actor);
      const q = findQueue(event, op.queueId);
      const current = q.current ? event.tickets[q.current] : undefined;
      if (!current) fail('bad_request', 'Nobody is at the counter right now.');
      else finishTicket(q, current, 'served', now);
      return { kind: 'none' };
    }

    case 'ticket.join': {
      const q = findQueue(event, op.queueId);
      const existing = Object.values(event.tickets).find(
        (t) => t.queueId === q.id && t.deviceId === actor.deviceId && (t.status === 'waiting' || t.status === 'called'),
      );
      // One active ticket per phone per queue: stops one person grabbing ten places.
      if (existing) return { kind: 'ticket', ticketId: existing.id, number: existing.number };
      if (q.status === 'closed') fail('queue_closed', `${q.name} is not taking new people right now.`);
      const ticket: TicketRec = {
        id: newId(),
        queueId: q.id,
        number: q.nextNumber,
        deviceId: actor.deviceId,
        name: cleanText(op.name, LIMITS.personName),
        status: 'waiting',
        joinedAt: now,
        calledAt: null,
        finishedAt: null,
      };
      q.nextNumber += 1;
      q.waiting.push(ticket.id);
      event.tickets[ticket.id] = ticket;
      return { kind: 'ticket', ticketId: ticket.id, number: ticket.number };
    }

    case 'ticket.leave': {
      const t = event.tickets[op.ticketId] ?? fail('not_found', 'That ticket was not found.');
      if (t.deviceId !== actor.deviceId && !actor.isOrganizer) fail('forbidden', 'This ticket belongs to another phone.');
      if (t.status !== 'waiting' && t.status !== 'called') return { kind: 'none' };
      const q = findQueue(event, t.queueId);
      q.waiting = q.waiting.filter((id) => id !== t.id);
      finishTicket(q, t, 'left', now);
      return { kind: 'none' };
    }

    case 'tag.create': {
      const label = cleanText(op.label, LIMITS.tagLabel);
      if (!label) fail('bad_request', 'Add a name or description for the tag.');
      const owned = Object.values(event.tags).filter((t) => t.ownerDeviceId === actor.deviceId).length;
      if (owned >= LIMITS.tagsPerDevice) fail('bad_request', `One phone can create at most ${LIMITS.tagsPerDevice} tags.`);
      const tag: TagRec = {
        id: newId(),
        ownerDeviceId: actor.deviceId,
        finderDeviceId: null,
        label,
        note: cleanText(op.note, LIMITS.tagNote),
        status: 'safe',
        createdAt: now,
        lostAt: null,
        foundAt: null,
        messages: [],
        location: null,
      };
      event.tags[tag.id] = tag;
      return { kind: 'tag', tagId: tag.id };
    }

    case 'tag.setLost': {
      const tag = findTag(event, op.tagId);
      if (tag.ownerDeviceId !== actor.deviceId && !actor.isOrganizer) fail('forbidden', 'Only the family can change this tag.');
      if (op.lost) {
        if (tag.status === 'safe') {
          tag.status = 'lost';
          tag.lostAt = now;
        }
      } else if (tag.status === 'lost') {
        tag.status = 'safe';
        tag.lostAt = null;
      }
      return { kind: 'none' };
    }

    case 'tag.claimFound': {
      const tag = findTag(event, op.tagId);
      if (tag.ownerDeviceId === actor.deviceId) fail('bad_request', 'This is your own tag.');
      if (tag.finderDeviceId === actor.deviceId) return { kind: 'tag', tagId: tag.id };
      if (tag.finderDeviceId !== null) fail('already_claimed', 'Someone is already helping this person. Please take them to the help desk.');
      tag.finderDeviceId = actor.deviceId;
      tag.status = 'found';
      tag.foundAt = now;
      return { kind: 'tag', tagId: tag.id };
    }

    case 'tag.message': {
      const tag = findTag(event, op.tagId);
      const role = roleFor(tag, actor) ?? fail('forbidden', 'You are not part of this conversation.');
      const text = cleanText(op.text, LIMITS.chatText);
      if (!text) fail('bad_request', 'Type a message first.');
      tag.messages.push({ id: newId(), role, text, at: now });
      if (tag.messages.length > LIMITS.messagesPerTag) tag.messages.splice(0, tag.messages.length - LIMITS.messagesPerTag);
      return { kind: 'none' };
    }

    case 'tag.shareLocation': {
      const tag = findTag(event, op.tagId);
      if (tag.finderDeviceId !== actor.deviceId) fail('forbidden', 'Only the person who found them can share a location.');
      tag.location = { lat: op.lat, lng: op.lng, accuracyM: Math.round(op.accuracyM), at: now };
      return { kind: 'none' };
    }

    case 'tag.resolve': {
      const tag = findTag(event, op.tagId);
      if (tag.ownerDeviceId !== actor.deviceId && !actor.isOrganizer) fail('forbidden', 'Only the family or staff can close this.');
      // Reunited: wipe the conversation and location so nothing personal lingers.
      tag.status = 'safe';
      tag.finderDeviceId = null;
      tag.lostAt = null;
      tag.foundAt = null;
      tag.messages = [];
      tag.location = null;
      return { kind: 'none' };
    }

    case 'tag.remove': {
      const tag = findTag(event, op.tagId);
      if (tag.ownerDeviceId !== actor.deviceId && !actor.isOrganizer) fail('forbidden', 'Only the family can delete this tag.');
      delete event.tags[tag.id];
      return { kind: 'none' };
    }
  }
}
