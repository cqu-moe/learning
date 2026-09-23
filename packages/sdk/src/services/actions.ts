import { z } from 'zod';
import { LearningError } from '../types/errors.js';
import type { Json } from '../types/errors.js';
import { sha256Hex } from '../types/sha256.js';
import { ActionInputSchema, PreviewSchema, ReceiptSchema } from '../types/models.js';
import type { ActionInput, Preview, Receipt } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Clock, StateStore, StoredValue } from '../runtime/types.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const StoredOperationSchema = z.object({
  preview: PreviewSchema,
  operationId: z.string().min(1),
  input: ActionInputSchema,
  phase: z.enum(['preview', 'sending', 'done', 'canceled']),
  receipt: ReceiptSchema.nullable(),
});
type StoredOperation = z.infer<typeof StoredOperationSchema>;

function failure(code: 'INVALID_INPUT' | 'CONFLICT' | 'UNCERTAIN' | 'PREVIEW_EXPIRED' | 'PRECONDITION_CHANGED' | 'CANCELED', message: string, operationId: string | null): LearningError {
  return new LearningError({ code, message, retryAfterMs: null, operationId });
}

export function digestOf(input: ActionInput): string {
  return sha256Hex(JSON.stringify(input));
}

/** Durable preview → sending → done transition. A lost response is never resent. */
export class ActionStore {
  private readonly executors = new Map<string, () => Promise<Receipt>>();
  constructor(private readonly state: StateStore, private readonly clock: Clock) {}

  private key(id: string): string { return `preview:${id}`; }
  private indexKey(id: string): string { return `operation:${id}`; }

  private async load(id: string): Promise<{ stored: StoredValue; record: StoredOperation }> {
    let stored = await this.state.get(this.key(id));
    if (stored === null) {
      const index = await this.state.get(this.indexKey(id));
      if (typeof index?.value !== 'string') throw failure('INVALID_INPUT', 'unknown preview or operation id', null);
      stored = await this.state.get(this.key(index.value));
    }
    if (stored === null) throw failure('INVALID_INPUT', 'unknown preview or operation id', null);
    const parsed = StoredOperationSchema.safeParse(stored.value);
    if (!parsed.success) throw failure('CONFLICT', 'stored operation is invalid', null);
    return { stored, record: parsed.data };
  }

  async inspect(id: string): Promise<{ preview: Preview; operationId: string; phase: StoredOperation['phase']; receipt: Receipt | null }> {
    const { record } = await this.load(id);
    return { preview: record.preview, operationId: record.operationId, phase: record.phase, receipt: record.receipt };
  }

  private async update(previous: StoredValue, record: StoredOperation): Promise<void> {
    const ok = await this.state.commit({
      expected: [{ key: this.key(record.preview.id), revision: previous.revision }],
      changes: [{ key: this.key(record.preview.id), value: record as unknown as Json }],
    });
    if (!ok) throw failure('CONFLICT', 'operation changed concurrently', record.operationId);
  }

  async prepare(input: ActionInput, generation: number, executor: () => Promise<Receipt>): Promise<Preview> {
    const parsed = ActionInputSchema.parse(input);
    const id = `preview-${crypto.randomUUID()}`;
    const operationId = `operation-${crypto.randomUUID()}`;
    const preview: Preview = {
      id,
      scope: scopeOf(parsed),
      kind: parsed.kind,
      digest: digestOf(parsed),
      generation,
      expiresAtMs: this.clock.nowMs() + PREVIEW_TTL_MS,
      description: parsed.kind,
      startsTimer: parsed.kind === 'exam.start' || parsed.kind === 'live.join',
      finalSubmission: parsed.kind === 'exam.finalize',
      blockers: [],
    };
    const record: StoredOperation = { preview, operationId, input: parsed, phase: 'preview', receipt: null };
    const ok = await this.state.commit({
      expected: [{ key: this.key(id), revision: null }, { key: this.indexKey(operationId), revision: null }],
      changes: [{ key: this.key(id), value: record as unknown as Json }, { key: this.indexKey(operationId), value: id }],
    });
    if (!ok) throw failure('CONFLICT', 'operation id collision', operationId);
    this.executors.set(id, executor);
    return preview;
  }

  async execute(previewId: string, current?: { generation?: number; digest?: string }): Promise<Receipt> {
    const { stored, record } = await this.load(previewId);
    if (record.preview.id !== previewId) throw failure('INVALID_INPUT', 'execute requires a preview id', record.operationId);
    if (record.phase === 'done' && record.receipt?.state !== 'uncertain' && record.receipt !== null) return record.receipt;
    if (record.phase === 'sending' || record.receipt?.state === 'uncertain') throw failure('UNCERTAIN', 'operation outcome unknown; use reconcile', record.operationId);
    if (record.phase === 'canceled') throw failure('CANCELED', 'preview was canceled', record.operationId);
    if (this.clock.nowMs() > record.preview.expiresAtMs) throw failure('PREVIEW_EXPIRED', 'preview older than 10 minutes', record.operationId);
    if (current?.generation !== undefined && current.generation !== record.preview.generation) throw failure('PRECONDITION_CHANGED', 'session generation changed since preview', record.operationId);
    if (current?.digest !== undefined && current.digest !== record.preview.digest) throw failure('PRECONDITION_CHANGED', 'input content changed since preview', record.operationId);
    const executor = this.executors.get(previewId);
    if (executor === undefined) throw failure('PRECONDITION_CHANGED', 'preview executor is unavailable after process restart; prepare again', record.operationId);
    await this.update(stored, { ...record, phase: 'sending' });
    try {
      const outcome = ReceiptSchema.parse(await executor());
      const receipt: Receipt = { ...outcome, operationId: record.operationId };
      const sending = await this.load(previewId);
      await this.update(sending.stored, { ...sending.record, phase: 'done', receipt });
      return receipt;
    } catch {
      const latest = await this.load(previewId);
      if (latest.record.phase === 'sending') {
        const uncertain: Receipt = { operationId: record.operationId, state: 'uncertain', message: 'outcome unknown after send', result: null };
        try { await this.update(latest.stored, { ...latest.record, phase: 'done', receipt: uncertain }); } catch { /* sending record already remains durable */ }
      }
      throw failure('UNCERTAIN', 'operation outcome unknown; use reconcile', record.operationId);
    }
  }

  async reconcile(id: string, verifier: () => Promise<Receipt | null>): Promise<Receipt> {
    const { stored, record } = await this.load(id);
    if (record.phase === 'preview' || record.phase === 'canceled') throw failure('PRECONDITION_CHANGED', 'operation was not sent', record.operationId);
    if (record.phase === 'done' && record.receipt?.state !== 'uncertain' && record.receipt !== null) return record.receipt;
    const verified = await verifier();
    const receipt: Receipt = verified === null
      ? { operationId: record.operationId, state: 'uncertain', message: 'upstream state unavailable', result: null }
      : { ...ReceiptSchema.parse(verified), operationId: record.operationId };
    await this.update(stored, { ...record, phase: 'done', receipt });
    return receipt;
  }

  async cancelAll(): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.state.list('preview:', cursor, 100);
      for (const row of page.items) {
        const parsed = StoredOperationSchema.safeParse(row.record.value);
        if (parsed.success && parsed.data.phase === 'preview') await this.update(row.record, { ...parsed.data, phase: 'canceled' });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    this.executors.clear();
  }
}

function scopeOf(input: ActionInput): Scope {
  switch (input.kind) {
    case 'homework.apply':
    case 'exam.save':
    case 'exam.finalize': return input.draft.ref.resource.course.scope;
    case 'exam.start': return input.ref.resource.course.scope;
    case 'discussion.post': return input.draft.ref.resource.course.scope;
    case 'document.visit': return input.resource.course.scope;
    case 'study': return input.resources[0]?.course.scope ?? { userId: 'local', profileId: 'unknown', platform: 'ykt' };
    case 'live.join': return input.lesson.scope;
    case 'live.answer': return { userId: 'local', profileId: 'unknown', platform: 'ykt' };
  }
}
