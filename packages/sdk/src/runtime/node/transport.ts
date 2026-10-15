import { LearningError } from '../../types/errors.js';
import type { Socket, Transport } from '../types.js';

const MAX_FRAMES = 256;
const MAX_FRAME_BYTES = 1024 * 1024;

interface WsLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(message: string): void;
  close(): void;
}

/** Node transport: fetch single-hop (redirect handled by SessionHttp) + native WebSocket. */
export class NodeFetchTransport implements Transport {
  async fetch(input: Request): Promise<Response> {
    return fetch(input);
  }

  async connect(input: { url: string; headers?: Record<string, string>; signal: AbortSignal }): Promise<Socket> {
    return NodeSocket.open(input.url, input.signal, input.headers);
  }
}

/** WebSocket wrapper with a bounded mailbox: 256 frames, 1MiB per frame. */
export class NodeSocket implements Socket {
  private readonly ws: WsLike;
  private readonly queue: (string | Uint8Array)[] = [];
  private readonly waiters: ((result: IteratorResult<string | Uint8Array>) => void)[] = [];
  private failure: LearningError | null = null;
  private closed = false;
  private readonly detachAbort: () => void;

  private constructor(ws: WsLike, signal: AbortSignal) {
    this.ws = ws;
    const onAbort = () => { void this.close(); };
    this.detachAbort = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    ws.addEventListener('message', (event) => {
      const data = event.data;
      const frame = typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer);
      if (frameLength(frame) > MAX_FRAME_BYTES) {
        this.fail(new LearningError({ code: 'PROTOCOL', message: 'ws frame exceeds 1MiB', retryAfterMs: null, operationId: null }));
        return;
      }
      if (this.queue.length >= MAX_FRAMES) {
        this.fail(new LearningError({ code: 'PROTOCOL', message: 'ws mailbox overflow (256 frames)', retryAfterMs: null, operationId: null }));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter({ value: frame, done: false });
      else this.queue.push(frame);
    });
    ws.addEventListener('close', () => {
      this.detachAbort();
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    });
    if (signal.aborted) void this.close();
  }

  static async open(url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<NodeSocket> {
    if (process.versions.bun !== undefined) {
      // Bun 1.4.3 accepts native options but does not select an env proxy for WS.
      // Native TLS verification, NODE_EXTRA_CA_CERTS and NO_PROXY remain in Bun.
      const env = process.env;
      const proxy = (url.startsWith('wss:') ? env.https_proxy ?? env.HTTPS_PROXY : undefined)
        ?? env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
      const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string>; proxy?: string }) => WsLike;
      return NodeSocket.fromWebSocket(new BunWebSocket(url, { headers, ...(proxy ? { proxy } : {}) }), signal);
    }
    return NodeSocket.fromWebSocket(new WebSocket(url) as unknown as WsLike, signal);
  }

  static async fromWebSocket(ws: WsLike, signal: AbortSignal): Promise<NodeSocket> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        ws.close();
        reject(new LearningError({ code: 'CANCELED', message: 'ws connect canceled', retryAfterMs: null, operationId: null }));
        return;
      }
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new LearningError({ code: 'NETWORK', message: 'ws connect failed', retryAfterMs: null, operationId: null }));
      };
      const onAbort = () => {
        cleanup();
        ws.close();
        reject(new LearningError({ code: 'CANCELED', message: 'ws connect canceled', retryAfterMs: null, operationId: null }));
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort);
    });
    return new NodeSocket(ws, signal);
  }

  async send(message: string): Promise<void> {
    if (this.closed || this.failure !== null) {
      throw new LearningError({ code: 'NETWORK', message: 'ws socket is closed', retryAfterMs: null, operationId: null });
    }
    this.ws.send(message);
  }

  readonly messages = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<string | Uint8Array>> => {
        if (this.failure !== null) return Promise.reject(this.failure);
        const queued = this.queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push((result) => (result.done ? resolve(result) : resolve(result)));
          if (this.failure !== null) reject(this.failure);
        });
      },
    }),
  };

  async close(): Promise<void> {
    this.detachAbort();
    this.closed = true;
    this.ws.close();
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  private fail(error: LearningError): void {
    this.failure = error;
    this.ws.close();
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

function frameLength(frame: string | Uint8Array): number {
  return typeof frame === 'string' ? frame.length : frame.byteLength;
}
