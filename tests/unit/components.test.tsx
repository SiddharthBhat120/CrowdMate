import 'fake-indexeddb/auto';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueueView, TicketView } from '../../shared/protocol';
import { Field } from '../../src/components/Field';
import { Tabs } from '../../src/components/Tabs';
import { ToastProvider } from '../../src/components/Toast';
import { resetDbForTests } from '../../src/lib/idb';
import { Ticket } from '../../src/pages/Ticket';
import { SyncClient } from '../../src/sync/client';
import { setSyncForTests } from '../../src/sync/hooks';
import { FakeSocket, makeView } from './fakes';

describe('Field', () => {
  it('connects the label, hint and error for screen readers', () => {
    render(<Field label="Event code" hint="Printed under the QR code." error="Codes have 6 characters." value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Event code');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Printed under the QR code. Codes have 6 characters.');
  });
});

describe('Tabs', () => {
  function Harness() {
    const [selected, setSelected] = useState('a');
    return (
      <Tabs
        label="Sections"
        selected={selected}
        onSelect={setSelected}
        items={[
          { id: 'a', label: 'Queues', panel: <p>Queue panel</p> },
          { id: 'b', label: 'Lost and found', panel: <p>Lost panel</p> },
          { id: 'c', label: 'Share', panel: <p>Share panel</p> },
        ]}
      />
    );
  }

  it('has one tab stop and moves with the arrow, Home and End keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    await user.click(tabs[0]!);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Lost and found' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Lost panel');

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Share' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}'); // wraps around
    expect(screen.getByRole('tab', { name: 'Queues' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Queues');
  });
});

describe('Ticket screen', () => {
  let client: SyncClient;

  const queue = (patch: Partial<QueueView> = {}): QueueView => ({
    id: 'q1',
    name: 'Food stall',
    status: 'open',
    waiting: [4, 5],
    nowServing: 3,
    avgServiceSec: 120,
    servedCount: 2,
    ...patch,
  });
  const ticket = (patch: Partial<TicketView> = {}): TicketView => ({
    id: 't5',
    queueId: 'q1',
    number: 5,
    name: 'Priya',
    status: 'waiting',
    joinedAt: 0,
    calledAt: null,
    finishedAt: null,
    ...patch,
  });

  beforeEach(async () => {
    resetDbForTests();
    FakeSocket.instances = [];
    client = new SyncClient({
      socketUrl: () => 'ws://test/ws',
      deviceId: 'device-under-test-1',
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      fetchImpl: () => Promise.reject(new Error('offline')),
      isOnline: () => true,
    });
    setSyncForTests(client);
    client.start();
    await client.whenReady();
    await new Promise((r) => setTimeout(r, 0));
    FakeSocket.latest().serverOpen();
  });

  afterEach(() => {
    client.stop();
    setSyncForTests(null);
  });

  function push(view: ReturnType<typeof makeView>, version: number) {
    act(() => FakeSocket.latest().serverSend({ t: 'snapshot', eventId: 'ABCDEF', version, view }));
  }

  it('shows the place in line, then the turn, live', () => {
    render(
      <ToastProvider>
        <Ticket params={{ eventId: 'ABCDEF', ticketId: 't5' }} />
      </ToastProvider>,
    );
    push(makeView({ queues: [queue()], tickets: [ticket()] }), 2);

    const slip = screen.getByRole('article');
    expect(within(slip).getByRole('heading', { name: 'Food stall' })).toBeInTheDocument();
    expect(within(slip).getByLabelText('Token number 5')).toBeInTheDocument();
    expect(slip).toHaveTextContent("You're 2nd in line");
    expect(slip).toHaveTextContent('Now serving 3');

    // Person ahead is served: position changes and is announced politely.
    push(makeView({ queues: [queue({ waiting: [5], nowServing: 4 })], tickets: [ticket()] }), 3);
    expect(slip).toHaveTextContent("You're next");
    expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('You are 1st in line'))).toBe(true);

    // Called: the urgent alert region speaks immediately.
    push(makeView({ queues: [queue({ waiting: [], nowServing: 5 })], tickets: [ticket({ status: 'called', calledAt: 1 })] }), 4);
    expect(slip).toHaveTextContent("It's your turn");
    expect(screen.getByRole('alert')).toHaveTextContent("It's your turn. Please go to Food stall now.");
    expect(document.title).toContain('Your turn');
  });

  it('offers to rejoin after a missed turn', () => {
    render(
      <ToastProvider>
        <Ticket params={{ eventId: 'ABCDEF', ticketId: 't5' }} />
      </ToastProvider>,
    );
    push(makeView({ queues: [queue()], tickets: [ticket({ status: 'noshow', finishedAt: 2 })] }), 2);
    expect(screen.getByRole('article')).toHaveTextContent('You missed your turn.');
    expect(screen.getByRole('button', { name: 'Join the line again' })).toBeEnabled();
  });

  it('explains when the token belongs to another phone', () => {
    render(
      <ToastProvider>
        <Ticket params={{ eventId: 'ABCDEF', ticketId: 'someone-else' }} />
      </ToastProvider>,
    );
    push(makeView({ queues: [queue()], tickets: [] }), 2);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Token not found on this phone');
  });
});
