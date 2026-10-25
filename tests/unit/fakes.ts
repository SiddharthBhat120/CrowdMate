import type { ClientMessage, EventView, ServerMessage } from '../../shared/protocol';

/** A WebSocket stand-in the test controls completely. */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static latest(): FakeSocket {
    const s = FakeSocket.instances.at(-1);
    if (!s) throw new Error('no socket created');
    return s;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  /* test controls */
  serverOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSend(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverDrop() {
    this.close();
  }
  sentOfType<T extends ClientMessage['t']>(t: T): Extract<ClientMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { t: T }> => m.t === t);
  }
}

export function makeView(patch: Partial<EventView> = {}): EventView {
  return {
    id: 'ABCDEF',
    name: 'Spring Fair',
    createdAt: 0,
    role: 'visitor',
    queues: [],
    tickets: [],
    tags: [],
    finding: [],
    staff: null,
    ...patch,
  };
}
