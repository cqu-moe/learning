import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/services/jobs.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock } from './helpers/replay.js';

const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };

function makeRunner() {
  return new JobRunner(new MemoryStateStore(), new FakeClock());
}

describe('job runner (T18, A181/A182)', () => {
  it('cancel stops future advances and keeps the record queryable (T18 snippet)', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'study', { total: 2 });
    await runner.cancel(job.id);
    let advanced = false;
    const after = await runner.advance(job.id, async () => {
      advanced = true;
      return { completed: false };
    });
    expect(advanced).toBe(false);
    expect(after.status).toBe('canceled');
    expect((await runner.get(job.id)).status).toBe('canceled');
  });

  it('concurrent advance on the same job returns CONFLICT', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'study', { total: 1 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runner.advance(job.id, async () => {
      await gate;
      return { completed: true };
    });
    await expect(
      runner.advance(job.id, async () => ({ completed: true })),
    ).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
    release?.();
    const result = await first;
    expect(result.status).toBe('succeeded');
  });

  it('events are persisted with a monotonic sequence and mergeable progress', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'export', { total: 1 });
    await runner.emitProgress(job.id, 'res-1', 0.5);
    await runner.emitProgress(job.id, 'res-1', 0.9, { title: '1.1 视频', durationSeconds: 630, serverSeconds: 65 }); // high-frequency progress merges
    await runner.emitState(job.id);
    const events = await runner.events(job.id, 0);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[0]).toMatchObject({ type: 'progress', serverFraction: 0.9, title: '1.1 视频', durationSeconds: 630, serverSeconds: 65 });
    expect(events[1]?.type).toBe('state');
  });

  it('an advancing slice marks partial failures accurately (A182)', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'export', { total: 2 });
    const result = await runner.advance(job.id, async () => ({
      completed: true,
      items: [
        { key: 'a', state: 'succeeded' as const, message: null, artifacts: [] },
        { key: 'b', state: 'failed' as const, message: 'boom', artifacts: [] },
      ],
    }));
    expect(result.status).toBe('partial');
    expect(result.items.map((item) => item.state)).toEqual(['succeeded', 'failed']);
  });

  it('repeated reads or duplicate creation do not duplicate jobs (A182)', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'study', { total: 1 });
    for (let i = 0; i < 3; i += 1) await runner.get(job.id);
    const all = await runner.list();
    expect(all.items).toHaveLength(1);
  });

  it('reopens persisted jobs and events from a new runner instance', async () => {
    const state = new MemoryStateStore();
    const clock = new FakeClock();
    const first = new JobRunner(state, clock);
    const job = await first.create(scope, 'export', { total: 2 });
    await first.emitProgress(job.id, 'resource-1', 0.5);
    const reopened = new JobRunner(state, clock);
    expect((await reopened.get(job.id)).id).toBe(job.id);
    expect((await reopened.list()).items.map((item) => item.id)).toEqual([job.id]);
    expect((await reopened.events(job.id, 0)).map((event) => event.sequence)).toEqual([1]);
    await reopened.cancel(job.id);
    expect((await new JobRunner(state, clock).get(job.id)).status).toBe('canceled');
  });

  it('marks an interrupted write slice uncertain before any retry', async () => {
    const state = new MemoryStateStore();
    const runner = new JobRunner(state, new FakeClock());
    const job = await runner.create(scope, 'study', { total: 1 });
    const pending = runner.advance(job.id, () => new Promise(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reopened = new JobRunner(state, new FakeClock());
    expect((await reopened.recoverInterrupted(job.id)).status).toBe('uncertain');
    await expect(reopened.resume(job.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    void pending;
  });

  it('does not advance a paused job until explicitly resumed', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'export', { total: 1 });
    expect((await runner.pause(job.id)).status).toBe('paused');
    let called = false;
    await expect(runner.advance(job.id, async () => { called = true; return { completed: true }; })).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
    expect(called).toBe(false);
    expect((await runner.resume(job.id)).status).toBe('queued');
  });

  it('persists generation, cursor and the next due time for a study slice', async () => {
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const runner = new JobRunner(state, clock);
    const job = await runner.create(scope, 'study', { total: 1, generation: 7, payload: { kind: 'study' } });
    expect((await runner.metadata(job.id)).generation).toBe(7);
    await runner.setCursor(job.id, 'video:1');
    const waiting = await runner.advance(job.id, async () => ({ completed: false, status: 'waiting' as const, nextRunAtMs: clock.nowMs() + 5000 }));
    expect(waiting.status).toBe('waiting');
    expect(waiting.nextRunAtMs).toBe(clock.nowMs() + 5000);
    const reopened = new JobRunner(state, clock);
    expect((await reopened.metadata(job.id)).cursor).toBe('video:1');
    let early = false;
    const skipped = await reopened.advance(job.id, async () => { early = true; return { completed: true }; });
    expect(early).toBe(false);
    expect(skipped.status).toBe('waiting');
  });

  it('leaves an interrupted read-only export paused for an explicit resume', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'export', { total: 1 });
    await expect(runner.advance(job.id, async () => { throw new Error('download stream stopped'); })).rejects.toThrow();
    expect((await runner.get(job.id)).status).toBe('paused');
    expect((await runner.resume(job.id)).status).toBe('queued');
  });

  it('requeues only the same live job after an explicit rejoin', async () => {
    const runner = makeRunner();
    const job = await runner.create(scope, 'live', { total: null });
    await runner.pause(job.id);
    expect((await runner.requeueLive(job.id)).id).toBe(job.id);
    expect((await runner.get(job.id)).status).toBe('queued');
    await runner.cancel(job.id);
    await expect(runner.requeueLive(job.id)).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
  });

  it('moves a waiting live job due when its mailbox wakes', async () => {
    const clock = new FakeClock();
    const runner = new JobRunner(new MemoryStateStore(), clock);
    const job = await runner.create(scope, 'live', { total: null });
    await runner.advance(job.id, async () => ({ completed: false, status: 'waiting' as const, nextRunAtMs: clock.nowMs() + 5000 }));
    await runner.wake(job.id);
    expect((await runner.get(job.id)).nextRunAtMs).toBe(clock.nowMs());
  });

  it('paginates more than 200 persisted jobs without losing a profile-filtered row', async () => {
    const runner = makeRunner();
    for (let index = 0; index < 205; index += 1) await runner.create(index % 3 === 0 ? { ...scope, profileId: 'other' } : scope, 'export', { total: 1 });
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await runner.list({ limit: 50, ...(cursor === undefined ? {} : { cursor }) }, scope);
      expect(page.items.length).toBeLessThanOrEqual(50);
      ids.push(...page.items.map((job) => job.id));
      cursor = page.nextCursor ?? undefined;
      if (page.nextCursor === null) break;
    }
    expect(ids).toHaveLength(136);
    expect(new Set(ids).size).toBe(136);
  });
});
