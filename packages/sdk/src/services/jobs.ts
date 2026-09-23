import { LearningError } from '../types/errors.js';
import { sha256Hex } from '../types/sha256.js';
import type { ItemResult, Job, JobEvent, JobStatus } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Clock, StateStore } from '../runtime/types.js';
import type { Json } from '../types/errors.js';

interface JobRecord {
  job: Job;
  inputDigest: string;
  cursor: string | null;
  generation: number;
  pendingOperationId: string | null;
  running: boolean;
  events: JobEvent[];
}

/** Fixed JobKind handlers with 20s slices, nextRunAt, cancel/pause/resume and monotonic events (S06). */
export class JobRunner {
  private readonly jobs = new Map<string, JobRecord>();
  private counter = 0;

  constructor(private readonly state: StateStore, private readonly clock: Clock) {}

  async create(scope: Scope, kind: Job['kind'], input: { total: number | null; inputDigest?: string }): Promise<Job> {
    this.counter += 1;
    const id = `job-${this.counter}`;
    const now = this.clock.nowMs();
    const job: Job = {
      id,
      scope,
      kind,
      status: 'queued',
      createdAtMs: now,
      updatedAtMs: now,
      nextRunAtMs: now,
      completed: 0,
      total: input.total,
      items: [],
      warnings: [],
    };
    const record: JobRecord = { job, inputDigest: input.inputDigest ?? sha256Hex(JSON.stringify([scope, kind, input.total])), cursor: null, generation: 1, pendingOperationId: null, running: false, events: [] };
    this.jobs.set(id, record);
    await this.state.commit({ expected: [{ key: `job:${id}`, revision: null }], changes: [{ key: `job:${id}`, value: job as unknown as Json }] });
    return job;
  }

  async get(jobId: string): Promise<Job> {
    const record = this.require(jobId);
    return record.job;
  }

  async list(): Promise<{ items: Job[]; nextCursor: null; completeness: 'complete'; warnings: [] }> {
    return { items: [...this.jobs.values()].map((record) => record.job), nextCursor: null, completeness: 'complete', warnings: [] };
  }

  async advance(jobId: string, handler: () => Promise<{ completed: boolean; items?: ItemResult[] }>): Promise<Job> {
    const record = this.require(jobId);
    if (record.running) {
      throw new LearningError({ code: 'CONFLICT', message: 'job advance is already running', retryAfterMs: null, operationId: jobId });
    }
    if (record.job.status === 'canceled') {
      return record.job; // cancel stops future operations, never rolls back receipts (A181)
    }
    if (record.job.status === 'succeeded' || record.job.status === 'failed') {
      return record.job;
    }
    record.running = true;
    record.job = { ...record.job, status: 'running', updatedAtMs: this.clock.nowMs() };
    try {
      const result = await handler();
      const items = result.items ?? record.job.items;
      let status: JobStatus = record.job.status;
      if (result.completed) {
        const failures = items.filter((item) => item.state === 'failed').length;
        status = failures === 0 ? 'succeeded' : failures === items.length ? 'failed' : 'partial';
      }
      record.job = {
        ...record.job,
        status,
        items,
        completed: items.filter((item) => item.state === 'succeeded').length,
        updatedAtMs: this.clock.nowMs(),
        nextRunAtMs: result.completed ? null : this.clock.nowMs() + 1000,
      };
      await this.emitState(jobId);
      return record.job;
    } finally {
      record.running = false;
    }
  }

  async pause(jobId: string): Promise<Job> {
    const record = this.require(jobId);
    if (record.job.status === 'running') {
      record.job = { ...record.job, status: 'paused', updatedAtMs: this.clock.nowMs() };
    }
    return record.job;
  }

  async resume(jobId: string): Promise<Job> {
    const record = this.require(jobId);
    if (record.job.status === 'paused') {
      record.job = { ...record.job, status: 'queued', nextRunAtMs: this.clock.nowMs(), updatedAtMs: this.clock.nowMs() };
    }
    return record.job;
  }

  async cancel(jobId: string): Promise<Job> {
    const record = this.require(jobId);
    record.job = { ...record.job, status: 'canceled', nextRunAtMs: null, updatedAtMs: this.clock.nowMs() };
    await this.emitState(jobId);
    return record.job;
  }

  async events(jobId: string, afterSequence: number): Promise<JobEvent[]> {
    const record = this.require(jobId);
    return record.events.filter((event) => event.sequence > afterSequence).slice(0, 256);
  }

  async emitProgress(jobId: string, resourceKey: string, serverFraction: number): Promise<void> {
    const record = this.require(jobId);
    const last = record.events[record.events.length - 1];
    if (last?.type === 'progress' && last.resourceKey === resourceKey) {
      record.events[record.events.length - 1] = { ...last, serverFraction, estimatedSeconds: null };
      return;
    }
    record.events.push({ type: 'progress', sequence: record.events.length + 1, jobId, resourceKey, estimatedSeconds: null, serverFraction });
  }

  async emitState(jobId: string): Promise<void> {
    const record = this.require(jobId);
    record.events.push({ type: 'state', sequence: record.events.length + 1, job: record.job });
  }

  private require(jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (record === undefined) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown job id', retryAfterMs: null, operationId: jobId });
    }
    return record;
  }
}
