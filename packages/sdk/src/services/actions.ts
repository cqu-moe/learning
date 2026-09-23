import { LearningError } from '../types/errors.js';
import type { Json } from '../types/errors.js';
import { sha256Hex } from '../types/sha256.js';
import type { ActionInput, Preview, Receipt } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Clock, StateStore } from '../runtime/types.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export function digestOf(input: ActionInput): string {
  return sha256Hex(JSON.stringify(input));
}

interface StoredOperation {
  previewId: string;
  operationId: string;
  scope: Scope;
  kind: ActionInput['kind'];
  digest: string;
  generation: number;
  createdAtMs: number;
  expiresAtMs: number;
  description: string;
  startsTimer: boolean;
  finalSubmission: boolean;
  blockers: string[];
  phase: 'preview' | 'sending' | 'done';
  receipt: Receipt | null;
}

/** prepare → execute → reconcile with sending-record persistence and idempotent execution (S05). */
export class ActionStore {
  private readonly operations = new Map<string, StoredOperation>();
  private counter = 0;

  constructor(private readonly state: StateStore, private readonly clock: Clock) {}

  async prepare(
    input: ActionInput,
    generation: number,
    executor: () => Promise<Receipt>,
  ): Promise<Preview> {
    this.counter += 1;
    const id = `preview-${this.counter}`;
    const now = this.clock.nowMs();
    const record: StoredOperation = {
      previewId: id,
      operationId: `operation-${this.counter}`,
      scope: scopeOf(input),
      kind: input.kind,
      digest: digestOf(input),
      generation,
      createdAtMs: now,
      expiresAtMs: now + PREVIEW_TTL_MS,
      description: `${input.kind}`,
      startsTimer: input.kind === 'exam.start' || input.kind === 'live.join',
      finalSubmission: input.kind === 'exam.finalize',
      blockers: [],
      phase: 'preview',
      receipt: null,
    };
    this.operations.set(id, record);
    this.executors.set(id, executor);
    await this.state.commit({ expected: [{ key: `preview:${id}`, revision: null }], changes: [{ key: `preview:${id}`, value: record as unknown as Json }] });
    return {
      id,
      scope: record.scope,
      kind: record.kind,
      digest: record.digest,
      generation,
      expiresAtMs: record.expiresAtMs,
      description: record.description,
      startsTimer: record.startsTimer,
      finalSubmission: record.finalSubmission,
      blockers: [],
    };
  }

  private readonly executors = new Map<string, () => Promise<Receipt>>();

  async execute(previewId: string, current?: { generation?: number; digest?: string }): Promise<Receipt> {
    const record = this.operations.get(previewId);
    if (record === undefined) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown preview id', retryAfterMs: null, operationId: null });
    }
    if (this.clock.nowMs() > record.expiresAtMs) {
      throw new LearningError({ code: 'PREVIEW_EXPIRED', message: 'preview older than 10 minutes', retryAfterMs: null, operationId: record.operationId });
    }
    if (current?.generation !== undefined && current.generation !== record.generation) {
      throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'session generation changed since preview', retryAfterMs: null, operationId: record.operationId });
    }
    if (current?.digest !== undefined && current.digest !== record.digest) {
      throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'input content changed since preview', retryAfterMs: null, operationId: record.operationId });
    }
    if (record.phase === 'done' && record.receipt !== null) {
      return record.receipt; // idempotent re-execute returns the same receipt, no new write
    }
    record.phase = 'sending';
    try {
      const executor = this.executors.get(previewId);
      if (executor === undefined) {
        throw new LearningError({ code: 'INVALID_INPUT', message: 'preview has no bound executor', retryAfterMs: null, operationId: record.operationId });
      }
      const receipt = await executor();
      record.phase = 'done';
      record.receipt = receipt;
      return receipt;
    } catch (error) {
      void error;
      // The request may already have been sent; never auto-retry (A142).
      record.phase = 'done';
      record.receipt = { operationId: record.operationId, state: 'uncertain', message: 'outcome unknown after send', result: null };
      throw new LearningError({ code: 'UNCERTAIN', message: 'operation outcome unknown; use reconcile', retryAfterMs: null, operationId: record.operationId });
    }
  }

  async reconcile(previewId: string, verifier: () => Promise<Receipt | null>): Promise<Receipt> {
    const record = this.operations.get(previewId);
    if (record === undefined) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown preview id', retryAfterMs: null, operationId: null });
    }
    const verified = await verifier();
    if (verified === null) {
      const uncertain: Receipt = { operationId: record.operationId, state: 'uncertain', message: 'upstream state unavailable', result: null };
      record.receipt = uncertain;
      return uncertain;
    }
    record.phase = 'done';
    record.receipt = verified;
    return verified;
  }

  cancelAll(): void {
    for (const record of this.operations.values()) {
      if (record.phase === 'preview') record.phase = 'done';
    }
  }
}

function scopeOf(input: ActionInput): Scope {
  switch (input.kind) {
    case 'homework.apply':
    case 'exam.save':
    case 'exam.finalize':
      return input.draft.ref.resource.course.scope;
    case 'exam.start':
      return input.ref.resource.course.scope;
    case 'discussion.post':
      return input.draft.ref.resource.course.scope;
    case 'document.visit':
      return input.resource.course.scope;
    case 'study':
      return input.resources[0]?.course.scope ?? { userId: 'local', profileId: 'unknown', platform: 'ykt' };
    case 'live.join':
      return input.lesson.scope;
    case 'live.answer':
      return { userId: 'local', profileId: 'unknown', platform: 'ykt' }; // resolved from the live job at execution time by the caller
  }
}
