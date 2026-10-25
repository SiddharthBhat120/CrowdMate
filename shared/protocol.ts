/**
 * Wire protocol shared by the browser client and the Node server.
 *
 * Every change a client wants to make is an "op" with a unique opId.
 * The server remembers opIds it has already applied, so an op that is
 * re-sent after a dropped connection is applied exactly once.
 */

export type QueueStatus = 'open' | 'paused' | 'closed';
export type TicketStatus = 'waiting' | 'called' | 'served' | 'noshow' | 'left';
export type TagStatus = 'safe' | 'lost' | 'found';
export type ChatRole = 'family' | 'finder' | 'staff';

/* ---------- Views the server sends (never contain secrets) ---------- */

export interface QueueView {
  id: string;
  name: string;
  status: QueueStatus;
  /** Ticket numbers still waiting, in order. Position = index + 1. */
  waiting: number[];
  /** Ticket number currently being served, if any. */
  nowServing: number | null;
  /** Estimated seconds to serve one person (rolling average). */
  avgServiceSec: number;
  /** How many people have been served so far today. */
  servedCount: number;
}

/** Full ticket detail, sent only to the ticket's own device or to staff. */
export interface TicketView {
  id: string;
  queueId: string;
  number: number;
  name: string;
  status: TicketStatus;
  joinedAt: number;
  calledAt: number | null;
  finishedAt: number | null;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
}

export interface FinderLocation {
  lat: number;
  lng: number;
  accuracyM: number;
  at: number;
}

/** What a stranger sees after scanning a safety tag. */
export interface TagPublicView {
  id: string;
  label: string;
  status: TagStatus;
  /** True once some other device has said "I found them". */
  claimed: boolean;
}

/** What the family (and staff) see for a tag. */
export interface TagFullView extends TagPublicView {
  note: string;
  createdAt: number;
  lostAt: number | null;
  foundAt: number | null;
  messages: ChatMessage[];
  location: FinderLocation | null;
}

export interface EventPublicView {
  id: string;
  name: string;
  createdAt: number;
  queues: QueueView[];
}

/** Extra data only the organizer and counter staff receive. */
export interface StaffView {
  /** Every waiting/called ticket plus the most recently finished ones. */
  tickets: TicketView[];
  /** Every safety tag in the event. */
  tags: TagFullView[];
}

/** Personalised view: public data + this device's own tickets and tags. */
export interface EventView extends EventPublicView {
  role: 'visitor' | 'organizer';
  /** Tickets this phone took (newest first). */
  tickets: TicketView[];
  /** Safety tags this phone created. */
  tags: TagFullView[];
  /** Tags this phone is helping as the finder. */
  finding: TagFullView[];
  /** Present only for organizer connections. */
  staff: StaffView | null;
}

/* ---------- Ops (client -> server) ---------- */

export type Op =
  | { type: 'queue.create'; name: string; avgServiceSec: number }
  | { type: 'queue.setStatus'; queueId: string; status: QueueStatus }
  | { type: 'queue.callNext'; queueId: string }
  | { type: 'queue.markNoShow'; queueId: string }
  | { type: 'queue.finishCurrent'; queueId: string }
  | { type: 'ticket.join'; queueId: string; name: string }
  | { type: 'ticket.leave'; ticketId: string }
  | { type: 'tag.create'; label: string; note: string }
  | { type: 'tag.setLost'; tagId: string; lost: boolean }
  | { type: 'tag.claimFound'; tagId: string }
  | { type: 'tag.message'; tagId: string; text: string }
  | { type: 'tag.shareLocation'; tagId: string; lat: number; lng: number; accuracyM: number }
  | { type: 'tag.resolve'; tagId: string }
  | { type: 'tag.remove'; tagId: string };

export type OpType = Op['type'];

export interface OpEnvelope {
  opId: string;
  eventId: string;
  op: Op;
  /** When the user performed the action (may be long before it reaches the server). */
  createdAt: number;
}

export type OpResult =
  | { kind: 'none' }
  | { kind: 'ticket'; ticketId: string; number: number }
  | { kind: 'tag'; tagId: string }
  | { kind: 'queue'; queueId: string }
  | { kind: 'called'; number: number | null };

export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'queue_closed'
  | 'already_claimed'
  | 'rate_limited';

/* ---------- Messages ---------- */

export type ClientMessage =
  | {
      t: 'hello';
      deviceId: string;
    }
  | {
      t: 'subscribe';
      eventId: string;
      /** Last version this client has; server replies upToDate if unchanged. */
      sinceVersion: number;
      organizerKey?: string;
    }
  | { t: 'unsubscribe'; eventId: string }
  | { t: 'op'; env: OpEnvelope }
  | { t: 'ping'; at: number };

export type ServerMessage =
  | { t: 'welcome'; serverTime: number }
  | { t: 'snapshot'; eventId: string; version: number; view: EventView }
  | { t: 'upToDate'; eventId: string; version: number }
  | { t: 'subscribeError'; eventId: string; code: ErrorCode; message: string }
  | { t: 'ack'; opId: string; ok: true; result: OpResult }
  | { t: 'ack'; opId: string; ok: false; code: ErrorCode; message: string }
  | { t: 'pong'; at: number; serverTime: number };

/* ---------- Limits shared by client validation and server checks ---------- */

export const LIMITS = {
  eventName: 60,
  queueName: 40,
  personName: 40,
  tagLabel: 60,
  tagNote: 200,
  chatText: 500,
  queuesPerEvent: 20,
  tagsPerDevice: 6,
  messagesPerTag: 300,
  minServiceSec: 10,
  maxServiceSec: 3600,
} as const;

/** Event codes use letters and digits that can't be confused when read aloud. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const EVENT_CODE_LENGTH = 6;

export function isEventCode(value: string): boolean {
  if (value.length !== EVENT_CODE_LENGTH) return false;
  for (const ch of value) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}
