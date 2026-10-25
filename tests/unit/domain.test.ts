// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  estimateWaitSec,
  formatWait,
  nextAverage,
  ordinal,
  positionInLine,
  ticketPhase,
  timeAgo,
} from '../../shared/domain';
import type { QueueView, TicketView } from '../../shared/protocol';
import { isEventCode } from '../../shared/protocol';

const queue = (patch: Partial<QueueView> = {}): QueueView => ({
  id: 'q1',
  name: 'Food stall',
  status: 'open',
  waiting: [4, 5, 6],
  nowServing: 3,
  avgServiceSec: 120,
  servedCount: 2,
  ...patch,
});

const ticket = (patch: Partial<TicketView> = {}): TicketView => ({
  id: 't1',
  queueId: 'q1',
  number: 5,
  name: '',
  status: 'waiting',
  joinedAt: 0,
  calledAt: null,
  finishedAt: null,
  ...patch,
});

describe('positionInLine', () => {
  it('is 1-based', () => {
    expect(positionInLine(queue(), 4)).toBe(1);
    expect(positionInLine(queue(), 6)).toBe(3);
  });
  it('is null when not waiting', () => {
    expect(positionInLine(queue(), 3)).toBeNull();
  });
});

describe('estimateWaitSec', () => {
  it('counts people ahead plus half of the person at the counter', () => {
    // 2nd in line: 1 ahead + 0.5 at counter = 1.5 * 120
    expect(estimateWaitSec(queue(), 2)).toBe(180);
  });
  it('is zero for first in line with nobody at the counter', () => {
    expect(estimateWaitSec(queue({ nowServing: null }), 1)).toBe(0);
  });
});

describe('nextAverage', () => {
  const limits = { min: 10, max: 3600 };
  it('moves quickly with the first samples', () => {
    expect(nextAverage(120, 60, 0, limits)).toBe(90);
  });
  it('smooths later samples', () => {
    expect(nextAverage(100, 200, 5, limits)).toBe(125);
  });
  it('ignores a huge outlier once it has enough samples', () => {
    expect(nextAverage(60, 3000, 5, limits)).toBe(60);
  });
  it('respects the limits', () => {
    expect(nextAverage(12, 1, 0, limits)).toBe(11);
    expect(nextAverage(10, 1, 5, limits)).toBe(10);
  });
});

describe('formatting', () => {
  it('formats waits', () => {
    expect(formatWait(30)).toBe('less than a minute');
    expect(formatWait(240)).toBe('about 4 min');
    expect(formatWait(3600)).toBe('about 1 hr');
    expect(formatWait(4200)).toBe('about 1 hr 10 min');
  });
  it('makes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th',
    ]);
  });
  it('says how long ago', () => {
    expect(timeAgo(0, 10_000)).toBe('just now');
    expect(timeAgo(0, 5 * 60_000)).toBe('5 min ago');
    expect(timeAgo(0, 2 * 3_600_000)).toBe('2 hr ago');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffDelay(0, 1)).toBe(500);
    expect(backoffDelay(3, 1)).toBe(4000);
    expect(backoffDelay(20, 1)).toBe(30_000);
  });
  it('uses full jitter', () => {
    expect(backoffDelay(3, 0)).toBe(0);
    expect(backoffDelay(3, 0.5)).toBe(2000);
  });
});

describe('ticketPhase', () => {
  it('shows position and wait while waiting', () => {
    expect(ticketPhase(queue(), ticket())).toEqual({ phase: 'waiting', position: 2, waitSec: 180 });
  });
  it('keeps serving people already in line after the queue closes', () => {
    expect(ticketPhase(queue({ status: 'closed' }), ticket()).phase).toBe('waiting');
  });
  it('reports a paused queue', () => {
    expect(ticketPhase(queue({ status: 'paused' }), ticket())).toEqual({ phase: 'paused', position: 2 });
  });
  it('reports called and finished tickets', () => {
    expect(ticketPhase(queue(), ticket({ status: 'called' })).phase).toBe('called');
    expect(ticketPhase(queue(), ticket({ status: 'noshow' }))).toEqual({ phase: 'done', status: 'noshow' });
  });
});

describe('isEventCode', () => {
  it('accepts valid codes and rejects confusing characters', () => {
    expect(isEventCode('K7P2QX')).toBe(true);
    expect(isEventCode('K7P2Q0')).toBe(false); // zero is not in the alphabet
    expect(isEventCode('K7P2Q')).toBe(false);
  });
});
