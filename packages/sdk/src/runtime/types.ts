import type { Json } from '../types/errors.js';
import type { Artifact, RenderInput, RenderOutput, RenderState, SlideDeck } from '../types/models.js';

export interface Options {
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

export interface StoredValue {
  revision: number;
  value: Json;
}

export interface StateStore {
  get(key: string): Promise<StoredValue | null>;
  list(
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: { key: string; record: StoredValue }[]; nextCursor: string | null }>;
  commit(input: {
    expected: { key: string; revision: number | null }[];
    changes: { key: string; value: Json | null }[];
  }): Promise<boolean>;
}

export interface Socket {
  send(message: string): Promise<void>;
  messages: AsyncIterable<string | Uint8Array>;
  close(): Promise<void>;
}

export interface Transport {
  fetch(input: Request): Promise<Response>;
  connect(input: { url: string; headers: Record<string, string>; signal: AbortSignal }): Promise<Socket>;
}

export interface Clock {
  nowMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface BlobWriter {
  write(bytes: Uint8Array): Promise<void>;
  checkpoint(): Promise<Json>;
  finish(): Promise<{ bytes: number; sha256: string }>;
  abort(): Promise<void>;
}

export interface ArtifactStore {
  create(input: { id: string; mimeType: string }): Promise<BlobWriter>;
  resume(input: { id: string; checkpoint: Json }): Promise<BlobWriter>;
  open(id: string, options?: Options): Promise<ReadableStream<Uint8Array>>;
  remove(id: string): Promise<void>;
}

export interface HeavyRenderer {
  start(input: { taskId: string; attempt: number; request: RenderInput; deadlineAtMs: number }, options?: Options): Promise<void>;
  status(taskId: string, attempt: number, options?: Options): Promise<RenderState>;
  cancel(taskId: string, attempt: number): Promise<void>;
}

export interface ModelClient {
  propose(input: { purpose: 'answers' | 'discussion'; content: Json; signal: AbortSignal }): Promise<unknown>;
}

export interface Runtime {
  transport: Transport;
  state: StateStore;
  artifacts: ArtifactStore;
  clock: Clock;
  masterKey: Uint8Array;
  heavy: HeavyRenderer | null;
  model: ModelClient | null;
  log(event: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; fields: Record<string, string | number | boolean | null> }): void;
  wake(): Promise<void>;
}

export type { Artifact, RenderInput, RenderOutput, RenderState, SlideDeck };
