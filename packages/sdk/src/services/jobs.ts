import { LearningError } from '../types/errors.js';
import type { Json } from '../types/errors.js';
import { JobEventSchema, JobSchema } from '../types/models.js';
import type { ItemResult, Job, JobEvent, JobStatus, Question } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Clock, Options, StateStore, StoredValue } from '../runtime/types.js';
import { isCancellation, reportError } from '../runtime/diagnostics.js';
import type { DiagnosticLog } from '../runtime/diagnostics.js';
import { sha256Hex } from '../types/sha256.js';
import { PageInputSchema } from '../types/errors.js';
import type { PageInput } from '../types/errors.js';

interface Meta { inputDigest: string; generation: number; cursor: string | null; pendingOperationId: string | null; running: boolean }

function error(code: 'INVALID_INPUT' | 'CONFLICT' | 'UNCERTAIN', message: string, id: string): LearningError {
  return new LearningError({ code, message, retryAfterMs: null, operationId: id });
}

function parseMeta(value: Json | undefined): Meta {
  if (value === undefined) return { inputDigest: '', generation: 1, cursor: null, pendingOperationId: null, running: false };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw error('CONFLICT', 'job metadata is invalid', 'unknown');
  const row = value as Record<string, Json>;
  if (typeof row.inputDigest !== 'string' || typeof row.generation !== 'number' ||
    (row.cursor !== null && typeof row.cursor !== 'string') ||
    (row.pendingOperationId !== null && typeof row.pendingOperationId !== 'string') ||
    typeof row.running !== 'boolean') throw error('CONFLICT', 'job metadata is invalid', 'unknown');
  return { inputDigest: row.inputDigest, generation: row.generation, cursor: row.cursor, pendingOperationId: row.pendingOperationId, running: row.running };
}

/** State-backed fixed-kind jobs; transitions and events survive CLI process exit. */
export class JobRunner {
  private readonly log: DiagnosticLog | undefined;

  constructor(private readonly state: StateStore, private readonly clock: Clock, log?: DiagnosticLog) {
    this.log = log;
  }

  reportRecovery(stage: string, error: unknown, fields: Record<string, string | number | boolean | null> = {}): void {
    reportError(this.log, stage, error, fields);
  }
  private key(id: string) { return `job:${id}`; }
  private metaKey(id: string) { return `job-meta:${id}`; }
  private eventsKey(id: string) { return `job-events:${id}`; }
  private inputKey(id: string) { return `job-input:${id}`; }

  private async read(id: string): Promise<{ job: Job; stored: StoredValue; meta: Meta; metaStored: StoredValue | null }> {
    const stored = await this.state.get(this.key(id));
    if (stored === null) throw error('INVALID_INPUT', 'unknown job id', id);
    const metaStored = await this.state.get(this.metaKey(id));
    return { job: JobSchema.parse(stored.value), stored, meta: parseMeta(metaStored?.value), metaStored };
  }

  private async update(id: string, fn: (job: Job, meta: Meta) => { job: Job; meta: Meta } | null): Promise<Job> {
    const current = await this.read(id);
    const next = fn(current.job, current.meta);
    if (next === null) return current.job;
    const ok = await this.state.commit({
      expected: [
        { key: this.key(id), revision: current.stored.revision },
        { key: this.metaKey(id), revision: current.metaStored?.revision ?? null },
      ],
      changes: [
        { key: this.key(id), value: next.job as unknown as Json },
        { key: this.metaKey(id), value: next.meta as unknown as Json },
      ],
    });
    if (!ok) throw error('CONFLICT', 'job changed concurrently', id);
    return next.job;
  }

  async create(scope: Scope, kind: Job['kind'], input: { total: number | null; inputDigest?: string; payload?: Json; generation?: number; warnings?: Job['warnings'] }): Promise<Job> {
    const id = `job-${crypto.randomUUID()}`;
    const now = this.clock.nowMs();
    const job: Job = { id, scope, kind, status: 'queued', createdAtMs: now, updatedAtMs: now, nextRunAtMs: now, completed: 0, total: input.total, items: [], warnings: input.warnings ?? [] };
    const meta: Meta = { inputDigest: input.inputDigest ?? sha256Hex(JSON.stringify([scope, kind, input.total])), cursor: null, generation: input.generation ?? 1, pendingOperationId: null, running: false };
    const ok = await this.state.commit({
      expected: [this.key(id), this.metaKey(id), this.eventsKey(id), ...(input.payload === undefined ? [] : [this.inputKey(id)])].map((key) => ({ key, revision: null })),
      changes: [
        { key: this.key(id), value: job as unknown as Json },
        { key: this.metaKey(id), value: meta as unknown as Json },
        { key: this.eventsKey(id), value: [] },
        ...(input.payload === undefined ? [] : [{ key: this.inputKey(id), value: input.payload }]),
      ],
    });
    if (!ok) throw error('CONFLICT', 'job id collision', id);
    return job;
  }

  async get(id: string): Promise<Job> { return (await this.read(id)).job; }

  async metadata(id: string): Promise<Readonly<Meta>> { return (await this.read(id)).meta; }

  async setCursor(id: string, cursor: string | null): Promise<void> {
    await this.update(id, (job, meta) => ({ job, meta: { ...meta, cursor } }));
  }

  async setPendingOperation(id: string, operationId: string | null): Promise<void> {
    await this.update(id, (job, meta) => ({ job, meta: { ...meta, pendingOperationId: operationId } }));
  }

  async confirmPendingAndPause(id: string, operationId: string): Promise<Job> {
    return this.update(id, (job, meta) => {
      if (job.status !== 'uncertain' || meta.pendingOperationId !== operationId) throw error('CONFLICT', 'pending operation changed before reconciliation', id);
      return { job: { ...job, status: 'paused', nextRunAtMs: null, updatedAtMs: this.clock.nowMs() }, meta: { ...meta, pendingOperationId: null, running: false } };
    });
  }

  async input(id: string): Promise<Json | null> {
    await this.get(id);
    return (await this.state.get(this.inputKey(id)))?.value ?? null;
  }

  /** Call only after acquiring the local exclusive writer lock. A prior process
   * can no longer own an in-flight slice. Exports may restart from checkpoints
   * and live socket drains have no platform write to reconcile; other platform
   * writes remain uncertain pending read-only reconciliation. */
  async recoverInterrupted(id: string): Promise<Job> {
    return this.update(id, (job, meta) => {
      if (job.status !== 'running' && !meta.running) return null;
      return {
        job: { ...job, status: job.kind === 'export' || job.kind === 'live' ? 'paused' : 'uncertain', nextRunAtMs: null, updatedAtMs: this.clock.nowMs() },
        meta: { ...meta, running: false },
      };
    });
  }

  async list(input?: PageInput, scope?: Scope): Promise<{ items: Job[]; nextCursor: string | null; completeness: 'complete' | 'more'; warnings: [] }> {
    const pageInput = PageInputSchema.parse(input ?? {});
    const limit = pageInput.limit ?? 200;
    const items: Job[] = [];
    let cursor: string | null = pageInput.cursor ?? null;
    for (;;) {
      const page = await this.state.list('job:', cursor, 200);
      for (const [index, row] of page.items.entries()) {
        const job = JobSchema.parse(row.record.value);
        if (scope === undefined || job.scope.userId === scope.userId && job.scope.profileId === scope.profileId && job.scope.platform === scope.platform) items.push(job);
        cursor = row.key;
        if (items.length === limit) {
          const hasMore = index < page.items.length - 1 || page.nextCursor !== null;
          return { items, nextCursor: hasMore ? cursor : null, completeness: hasMore ? 'more' : 'complete', warnings: [] };
        }
      }
      if (page.nextCursor === null) return { items, nextCursor: null, completeness: 'complete', warnings: [] };
      cursor = page.nextCursor;
    }
  }

  async advance(
    id: string,
    handler: () => Promise<{ completed: boolean; items?: ItemResult[]; status?: 'waiting' | 'needs-input'; nextRunAtMs?: number | null }>,
    options?: Options,
  ): Promise<Job> {
    let entered = false;
    const current = await this.update(id, (job, meta) => {
      if (meta.running) throw error('CONFLICT', 'job advance is already running', id);
      if (['canceled', 'succeeded', 'failed', 'partial'].includes(job.status)) return null;
      if (job.status === 'paused' || job.status === 'needs-input') throw error('CONFLICT', 'job must be resumed before advancing', id);
      if (job.status === 'uncertain' || meta.pendingOperationId !== null) throw error('UNCERTAIN', 'pending operation must be reconciled first', id);
      if (job.nextRunAtMs !== null && job.nextRunAtMs > this.clock.nowMs()) return null;
      entered = true;
      return { job: { ...job, status: 'running', updatedAtMs: this.clock.nowMs() }, meta: { ...meta, running: true } };
    });
    if (!entered) return current;
    try {
      const result = await handler();
      const latest = await this.read(id);
      if (latest.job.status !== 'running') return latest.job;
      const items = result.items ?? latest.job.items;
      let status: JobStatus = 'running';
      if (result.completed) {
        const failures = items.filter((item) => item.state === 'failed').length;
        const needsInput = items.some((item) => item.state === 'needs-input');
        const uncertain = items.some((item) => item.state === 'uncertain');
        status = uncertain ? 'uncertain' : needsInput ? 'needs-input' : items.some(item => item.state === 'partial') ? 'partial' : failures === 0 ? 'succeeded' : failures === items.length ? 'failed' : 'partial';
      } else if (result.status !== undefined) status = result.status;
      const job = await this.update(id, (previous, meta) => ({
        job: { ...previous, status, items, completed: items.filter((item) => item.state === 'succeeded').length,
          updatedAtMs: this.clock.nowMs(), nextRunAtMs: result.completed || status === 'needs-input' ? null : result.nextRunAtMs ?? this.clock.nowMs() + 1000 },
        meta: { ...meta, running: false },
      }));
      await this.emitState(id);
      return job;
    } catch (cause) {
      if (!isCancellation(cause, options?.signal)) {
        this.reportRecovery(`job.advance.${current.kind}`, cause, {
          job_id: id,
          platform: current.scope.platform,
          recovered: current.kind === 'export',
        });
      }
      try {
        await this.update(id, (job, meta) => ({
          job: job.status === 'running' ? { ...job, status: job.kind === 'export' ? 'paused' : 'uncertain', nextRunAtMs: null, updatedAtMs: this.clock.nowMs() } : job,
          meta: { ...meta, running: false },
        }));
      } catch (stateError) {
        this.reportRecovery(`job.recovery.${current.kind}`, stateError, { job_id: id, platform: current.scope.platform });
        throw stateError;
      }
      throw cause;
    } finally {
      const latest = await this.read(id);
      if (latest.meta.running) await this.update(id, (job, meta) => ({ job, meta: { ...meta, running: false } }));
    }
  }

  async pause(id: string): Promise<Job> {
    const job = await this.update(id, (current, meta) => ['queued', 'running', 'waiting'].includes(current.status)
      ? { job: { ...current, status: 'paused', nextRunAtMs: null, updatedAtMs: this.clock.nowMs() }, meta } : null);
    await this.emitState(id);
    return job;
  }

  async resume(id: string): Promise<Job> {
    const job = await this.update(id, (current, meta) => {
      if (meta.running) throw error('CONFLICT', 'job is still advancing', id);
      if (current.status === 'uncertain' || meta.pendingOperationId !== null) throw error('UNCERTAIN', 'pending operation must be reconciled first', id);
      return current.status === 'paused' || current.status === 'needs-input' && current.kind === 'study'
        ? { job: { ...current, status: 'queued', items: current.items.filter((item) => item.state !== 'needs-input'), nextRunAtMs: this.clock.nowMs(), updatedAtMs: this.clock.nowMs() }, meta } : null;
    });
    await this.emitState(id);
    return job;
  }

  async requeueLive(id: string): Promise<Job> {
    const job = await this.update(id, (current, meta) => {
      if (current.kind !== 'live' || !['paused', 'waiting', 'needs-input', 'uncertain'].includes(current.status) || meta.running || meta.pendingOperationId !== null) throw error('CONFLICT', 'live job cannot be rejoined from this state', id);
      return { job: { ...current, status: 'queued', nextRunAtMs: this.clock.nowMs(), updatedAtMs: this.clock.nowMs() }, meta: { ...meta, running: false } };
    });
    await this.emitState(id);
    return job;
  }

  async wake(id: string): Promise<Job> {
    return this.update(id, (job, meta) => job.status === 'waiting' && (job.nextRunAtMs ?? 0) > this.clock.nowMs()
      ? { job: { ...job, nextRunAtMs: this.clock.nowMs() }, meta } : null);
  }

  async cancel(id: string): Promise<Job> {
    const job = await this.update(id, (current, meta) => ({ job: { ...current, status: 'canceled', nextRunAtMs: null, updatedAtMs: this.clock.nowMs() }, meta }));
    await this.emitState(id);
    return job;
  }

  async events(id: string, afterSequence: number): Promise<JobEvent[]> {
    await this.get(id);
    const stored = await this.state.get(this.eventsKey(id));
    const events = stored === null ? [] : JobEventSchema.array().parse(stored.value);
    return events.filter((event) => event.sequence > afterSequence).slice(0, 256);
  }

  private async appendEvent(id: string, event: JobEvent, merge: boolean): Promise<void> {
    await this.get(id);
    const key = this.eventsKey(id);
    const stored = await this.state.get(key);
    const events = stored === null ? [] : JobEventSchema.array().parse(stored.value);
    const last = events[events.length - 1];
    if (merge && last?.type === 'progress' && event.type === 'progress' && last.resourceKey === event.resourceKey) {
      events[events.length - 1] = { ...event, sequence: last.sequence };
    } else events.push({ ...event, sequence: (last?.sequence ?? 0) + 1 });
    const ok = await this.state.commit({ expected: [{ key, revision: stored?.revision ?? null }], changes: [{ key, value: events as unknown as Json }] });
    if (!ok) throw error('CONFLICT', 'job events changed concurrently', id);
  }

  async emitProgress(id: string, resourceKey: string, serverFraction: number | null, details: { title?: string | null; durationSeconds?: number | null; serverSeconds?: number | null } = {}): Promise<void> {
    await this.appendEvent(id, { type: 'progress', sequence: 0, jobId: id, resourceKey, estimatedSeconds: null, serverFraction, ...details }, true);
  }

  async emitState(id: string): Promise<void> {
    await this.appendEvent(id, { type: 'state', sequence: 0, job: await this.get(id) }, false);
  }

  async emitQuestion(id: string, phaseId: string, question: Question, closesAtMs: number | null): Promise<void> {
    await this.appendEvent(id, { type: 'question', sequence: 0, jobId: id, phaseId, question, closesAtMs }, false);
  }

  async emitGap(id: string, message: string): Promise<void> {
    await this.appendEvent(id, { type: 'gap', sequence: 0, jobId: id, message }, false);
  }
}
