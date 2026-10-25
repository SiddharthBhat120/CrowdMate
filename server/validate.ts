/**
 * Hand-written validation for everything that arrives over the network.
 * Anything that doesn't match exactly is rejected; the server never trusts
 * the shape of client data.
 */
import type { ClientMessage, Op, OpEnvelope, QueueStatus } from '../shared/protocol';
import { LIMITS } from '../shared/protocol';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Collapse whitespace and strip control characters from user text. */
export function cleanText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseOp(raw: unknown): Op | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'queue.create':
      if (!isStr(raw.name, 200) || !isNum(raw.avgServiceSec)) return null;
      return { type: raw.type, name: raw.name, avgServiceSec: raw.avgServiceSec };
    case 'queue.setStatus': {
      const statuses: QueueStatus[] = ['open', 'paused', 'closed'];
      if (!isId(raw.queueId) || !statuses.includes(raw.status as QueueStatus)) return null;
      return { type: raw.type, queueId: raw.queueId, status: raw.status as QueueStatus };
    }
    case 'queue.callNext':
    case 'queue.markNoShow':
    case 'queue.finishCurrent':
      if (!isId(raw.queueId)) return null;
      return { type: raw.type, queueId: raw.queueId };
    case 'ticket.join':
      if (!isId(raw.queueId) || !isStr(raw.name, 200)) return null;
      return { type: raw.type, queueId: raw.queueId, name: raw.name };
    case 'ticket.leave':
      if (!isId(raw.ticketId)) return null;
      return { type: raw.type, ticketId: raw.ticketId };
    case 'tag.create':
      if (!isStr(raw.label, 300) || !isStr(raw.note, 1000)) return null;
      return { type: raw.type, label: raw.label, note: raw.note };
    case 'tag.setLost':
      if (!isId(raw.tagId) || typeof raw.lost !== 'boolean') return null;
      return { type: raw.type, tagId: raw.tagId, lost: raw.lost };
    case 'tag.claimFound':
    case 'tag.resolve':
    case 'tag.remove':
      if (!isId(raw.tagId)) return null;
      return { type: raw.type, tagId: raw.tagId };
    case 'tag.message':
      if (!isId(raw.tagId) || !isStr(raw.text, 2000)) return null;
      return { type: raw.type, tagId: raw.tagId, text: raw.text };
    case 'tag.shareLocation':
      if (!isId(raw.tagId) || !isNum(raw.lat) || !isNum(raw.lng) || !isNum(raw.accuracyM)) return null;
      if (Math.abs(raw.lat) > 90 || Math.abs(raw.lng) > 180 || raw.accuracyM < 0) return null;
      return { type: raw.type, tagId: raw.tagId, lat: raw.lat, lng: raw.lng, accuracyM: raw.accuracyM };
    default:
      return null;
  }
}

function parseEnvelope(raw: unknown): OpEnvelope | null {
  if (!isObj(raw) || !isId(raw.opId) || !isId(raw.eventId) || !isNum(raw.createdAt)) return null;
  const op = parseOp(raw.op);
  return op ? { opId: raw.opId, eventId: raw.eventId, op, createdAt: raw.createdAt } : null;
}

export function parseClientMessage(text: string): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  switch (raw.t) {
    case 'hello':
      return isId(raw.deviceId) ? { t: 'hello', deviceId: raw.deviceId } : null;
    case 'subscribe': {
      if (!isId(raw.eventId) || !isNum(raw.sinceVersion)) return null;
      const key = raw.organizerKey;
      if (key !== undefined && !isStr(key, 100)) return null;
      return key === undefined
        ? { t: 'subscribe', eventId: raw.eventId, sinceVersion: raw.sinceVersion }
        : { t: 'subscribe', eventId: raw.eventId, sinceVersion: raw.sinceVersion, organizerKey: key };
    }
    case 'unsubscribe':
      return isId(raw.eventId) ? { t: 'unsubscribe', eventId: raw.eventId } : null;
    case 'op': {
      const env = parseEnvelope(raw.env);
      return env ? { t: 'op', env } : null;
    }
    case 'ping':
      return isNum(raw.at) ? { t: 'ping', at: raw.at } : null;
    default:
      return null;
  }
}

export function parseEventName(raw: unknown): string | null {
  if (!isObj(raw) || !isStr(raw.name, 500)) return null;
  const name = cleanText(raw.name, LIMITS.eventName);
  return name.length > 0 ? name : null;
}
