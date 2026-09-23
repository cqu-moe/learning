import type { Socket } from '../../src/runtime/types.js';
import { FakeTransport } from './replay.js';

/** FakeTransport plus scripted WebSocket connects for wsapp login tests. */
export class FakeWsTransport extends FakeTransport {
  readonly servers: FakeWsPair['server'][] = [];
  private readonly pendingConnects: FakeWsPair[] = [];

  connectNext(): FakeWsPair['server'] {
    const pair = fakeWsPair();
    this.pendingConnects.push(pair);
    return pair.server;
  }

  override async connect(): Promise<Socket> {
    const pair = this.pendingConnects.shift();
    if (pair === undefined) throw new Error('no scripted ws connect');
    this.servers.push(pair.server);
    return pair.client;
  }
}

/** Event-target shaped fake that NodeSocket.fromWebSocket can wrap. */
export class FakeWebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(message: string): void {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    this.dispatch('close', {});
  }

  serverOpen(): void {
    this.dispatch('open', {});
  }

  serverPush(message: string): void {
    this.dispatch('message', { data: message });
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export interface FakeWsPair {
  client: Socket;
  server: { push(message: string): void; sent: string[]; closed: boolean };
}

/** In-memory socket pair for provider-level fakes. */
export function fakeWsPair(): FakeWsPair {
  const queued: (string | Uint8Array)[] = [];
  const waiters: ((result: IteratorResult<string | Uint8Array>) => void)[] = [];
  const sent: string[] = [];
  let closed = false;
  let done = false;
  const client: Socket = {
    async send(message: string): Promise<void> {
      sent.push(message);
    },
    messages: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string | Uint8Array>> {
            const queuedItem = queued.shift();
            if (queuedItem !== undefined) return { value: queuedItem, done: false };
            if (done) return { value: undefined, done: true };
            return await new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    async close(): Promise<void> {
      closed = true;
      done = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };
  return {
    client,
    server: {
      push(message: string): void {
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter({ value: message, done: false });
        else queued.push(message);
      },
      sent,
      get closed() {
        return closed;
      },
    },
  };
}
