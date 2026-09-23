import { LearningError } from '../types/errors.js';
import type { ErrorData } from '../types/errors.js';
import type { AuthEvent, Probe, SessionView } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Clock, StateStore } from '../runtime/types.js';
import { readSession, writeSession } from '../session/store.js';
import type { SessionRecord } from '../session/store.js';

export type { AuthEvent } from '../types/models.js';

const DEFAULT_BUDGET_MS = 10 * 60 * 1000;

export interface AuthFlowLike {
  id: string;
  events: AsyncIterable<AuthEvent>;
  result: Promise<SessionView>;
  cancel(): Promise<void>;
}

export interface AuthLaunchContext {
  generation: number;
  signal: AbortSignal;
  deadlineAtMs: number;
  emit(event: AuthEvent): void;
  finish(session: Omit<SessionRecord, 'scope'>): Promise<void>;
  fail(error: ErrorData): void;
}

export type AuthLaunch = (context: AuthLaunchContext) => Promise<void>;

interface QueuedEvent {
  event: AuthEvent | null; // null = stream closed
}

/**
 * Runtime-agnostic auth lifecycle: generation bookkeeping, 10-minute lazy
 * budget, cancel/late-result destruction, and guarded session writes.
 */
export class AuthLifecycle {
  private readonly scope: Scope;
  private readonly clock: Clock;
  private readonly state: StateStore;
  private readonly masterKey: Uint8Array;
  private readonly budgetMs: number;
  private generationCounter = 0;
  private activeId: string | null = null;

  constructor(options: {
    scope: Scope;
    clock: Clock;
    state: StateStore;
    masterKey: Uint8Array;
    budgetMs?: number;
  }) {
    this.scope = options.scope;
    this.clock = options.clock;
    this.state = options.state;
    this.masterKey = options.masterKey;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  begin(launch: AuthLaunch): AuthFlowLike {
    this.generationCounter += 1;
    const generation = this.generationCounter;
    const id = `auth-${generation}-${Math.random().toString(36).slice(2, 10)}`;
    const controller = new AbortController();
    const deadlineAtMs = this.clock.nowMs() + this.budgetMs;
    const queue: QueuedEvent[] = [];
    const waiters: ((result: IteratorResult<AuthEvent>) => void)[] = [];
    let phase: 'active' | 'superseded' | 'canceled' | 'done' = 'active';
    this.activeId = id;

    const closeStream = () => {
      queue.push({ event: null });
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    };
    const push = (event: AuthEvent) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: event, done: false });
      else queue.push({ event });
    };
    const isActive = () => phase === 'active' && this.activeId === id;

    let rejectResult: ((error: LearningError) => void) | undefined;
    let resolveResult: ((view: SessionView) => void) | undefined;
    const result = new Promise<SessionView>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const fail = (error: ErrorData) => {
      if (!isActive()) return;
      phase = 'done';
      this.activeId = null;
      controller.abort();
      push({ type: 'failed', error });
      closeStream();
      rejectResult?.(new LearningError(error));
    };

    const context: AuthLaunchContext = {
      generation,
      signal: controller.signal,
      deadlineAtMs,
      emit: (event) => {
        if (!isActive()) return;
        push(event);
      },
      finish: async (session) => {
        if (!isActive()) return; // late or superseded results are dropped
        if (this.clock.nowMs() > deadlineAtMs) {
          fail({ code: 'TIMEOUT', message: 'auth flow exceeded its total budget', retryAfterMs: null, operationId: null });
          return;
        }
        try {
          const record: SessionRecord = { scope: this.scope, ...session, generation };
          await writeSession(this.state, this.masterKey, record);
          const view: SessionView = {
            scope: this.scope,
            generation,
            displayName: session.displayName,
            platformUserId: session.platformUserId,
            identityVerified: session.identityVerified,
            checkedAtMs: session.checkedAtMs,
          };
          phase = 'done';
          this.activeId = null;
          push({ type: 'authenticated', session: view });
          closeStream();
          resolveResult?.(view);
        } catch (error) {
          fail(errorToData(error));
        }
      },
      fail,
    };

    const flow: AuthFlowLike = {
      id,
      events: {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<AuthEvent>> {
              const queued = queue.shift();
              if (queued !== undefined) {
                return queued.event === null ? { value: undefined, done: true } : { value: queued.event, done: false };
              }
              return await new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      },
      result,
      cancel: async () => {
        if (phase === 'done' || phase === 'canceled') return;
        phase = 'canceled';
        if (this.activeId === id) this.activeId = null;
        controller.abort();
        push({ type: 'canceled' });
        closeStream();
        rejectResult?.(
          new LearningError({ code: 'CANCELED', message: 'auth flow canceled by user', retryAfterMs: null, operationId: null }),
        );
      },
    };

    void (async () => {
      try {
        await launch(context);
      } catch (error) {
        if (controller.signal.aborted && phase !== 'active') return;
        fail(errorToData(error));
      }
    })();

    return flow;
  }

  /** Next generation to use, seeded from any stored session. */
  async currentGeneration(): Promise<number> {
    const record = await readSession(this.state, this.masterKey, this.scope);
    return record?.generation ?? 0;
  }
}

function errorToData(error: unknown): ErrorData {
  if (error instanceof LearningError) return error.data;
  return {
    code: 'PROTOCOL',
    message: error instanceof Error ? error.message : 'auth flow failed',
    retryAfterMs: null,
    operationId: null,
  };
}

export interface ProbeProvider {
  probe(record: SessionRecord | null): Promise<SessionView | null>;
}

/** Probe wrapper: network/unknown failures are indeterminate and never clear cookies (A052). */
export async function probeSession(options: {
  scope: Scope;
  state: StateStore;
  masterKey: Uint8Array;
  provider: ProbeProvider;
}): Promise<Probe> {
  const record = await readSession(options.state, options.masterKey, options.scope);
  if (record === null) return { state: 'expired' };
  try {
    const view = await options.provider.probe(record);
    return view === null ? { state: 'expired' } : { state: 'valid', session: view };
  } catch (error) {
    if (error instanceof LearningError && error.data.code !== 'NETWORK' && error.data.code !== 'TIMEOUT') {
      throw error;
    }
    return {
      state: 'indeterminate',
      error:
        error instanceof LearningError
          ? error.data
          : { code: 'NETWORK', message: 'probe could not reach the platform', retryAfterMs: null, operationId: null },
    };
  }
}
