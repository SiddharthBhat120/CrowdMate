/**
 * Pure helpers used by both server and client. No I/O, no clock reads:
 * everything that needs "now" takes it as an argument so it is testable.
 */
import type { QueueView, TicketView } from './protocol';

/** 1-based place in line, or null when the ticket is no longer waiting. */
export function positionInLine(queue: QueueView, ticketNumber: number): number | null {
  const index = queue.waiting.indexOf(ticketNumber);
  return index === -1 ? null : index + 1;
}

/**
 * Seconds until this ticket is called.
 * People ahead = position - 1, plus the person at the counter (if any)
 * who still needs on average half a service time.
 */
export function estimateWaitSec(queue: QueueView, position: number): number {
  const ahead = Math.max(0, position - 1);
  const atCounter = queue.nowServing === null ? 0 : 0.5;
  return Math.round((ahead + atCounter) * queue.avgServiceSec);
}

/**
 * Exponential moving average of real service durations, clamped so one
 * extreme sample (staff went for lunch) cannot wreck the estimate.
 */
export function nextAverage(
  previousAvg: number,
  sampleSec: number,
  sampleCount: number,
  limits: { min: number; max: number },
): number {
  const clampedSample = Math.min(limits.max, Math.max(limits.min, sampleSec));
  // Ignore samples above 4x the current average: almost always a pause, not a slow customer.
  if (sampleCount >= 3 && clampedSample > previousAvg * 4) return previousAvg;
  // First real samples move the estimate quickly; later ones smooth it.
  const alpha = sampleCount < 3 ? 0.5 : 0.25;
  const value = previousAvg + alpha * (clampedSample - previousAvg);
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

/** "about 4 min", "less than a minute", "about 1 hr 10 min" */
export function formatWait(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} hr` : `about ${hours} hr ${rest} min`;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd" */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "just now", "2 min ago", "1 hr ago" */
export function timeAgo(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

/**
 * Reconnect delay with "full jitter": a random value between 0 and an
 * exponentially growing cap. Spreads out thousands of phones that all
 * lost Wi-Fi at the same moment so they don't reconnect in one spike.
 */
export function backoffDelay(attempt: number, random: number, baseMs = 500, maxMs = 30_000): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random * cap);
}

export type TicketPhase =
  | { phase: 'waiting'; position: number; waitSec: number }
  | { phase: 'called' }
  | { phase: 'done'; status: 'served' | 'noshow' | 'left' }
  | { phase: 'paused'; position: number }
  | { phase: 'closed' };

/** Decide what the ticket screen should show. */
export function ticketPhase(queue: QueueView | undefined, ticket: TicketView): TicketPhase {
  if (ticket.status === 'served' || ticket.status === 'noshow' || ticket.status === 'left') {
    return { phase: 'done', status: ticket.status };
  }
  if (ticket.status === 'called') return { phase: 'called' };
  if (!queue) return { phase: 'closed' };
  const position = positionInLine(queue, ticket.number);
  if (position === null) return { phase: 'closed' };
  // A closed queue stops new people joining; those already in line are still served.
  if (queue.status === 'paused') return { phase: 'paused', position };
  return { phase: 'waiting', position, waitSec: estimateWaitSec(queue, position) };
}
