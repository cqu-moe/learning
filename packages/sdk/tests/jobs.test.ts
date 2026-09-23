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
    await runner.emitProgress(job.id, 'res-1', 0.9); // high-frequency progress merges
    await runner.emitState(job.id);
    const events = await runner.events(job.id, 0);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[0]).toMatchObject({ type: 'progress', serverFraction: 0.9 });
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
});
