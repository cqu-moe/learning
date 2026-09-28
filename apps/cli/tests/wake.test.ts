import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createCliRuntime } from '../src/runtime.js';

describe('foreground wake signal', () => {
  it('wakes a waiting scheduler early and cleans up an aborted wait', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-wake-'));
    const runtime = createCliRuntime(dir);
    try {
      const started = Date.now();
      const waiting = runtime.waitForWake(5000, new AbortController().signal);
      await runtime.wake();
      await waiting;
      expect(Date.now() - started).toBeLessThan(500);
      const controller = new AbortController();
      const canceled = runtime.waitForWake(5000, controller.signal);
      controller.abort();
      await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    } finally { runtime.state.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

it('pauses before advancing when its external signal is already canceled', async () => {
 const { vi } = await import('vitest');
 const { createLearningClient } = await import('@learning/sdk');
 const { runJobForeground } = await import('../src/foreground.js');
 const dir = mkdtempSync(resolve(tmpdir(), 'learning-cancel-'));
 const runtime = createCliRuntime(dir);
 const scope = { userId: 'local', profileId: 'one', platform: 'ykt' as const };
 const client = createLearningClient({ scope, runtime });
 const job = await client.jobs.createExport({ type: 'media', resources: [{ course: { scope, key: 'course', native: { kind: 'ykt', classroomId: '1' } }, key: 'video', native: { kind: 'ykt', leafId: '2', leafInfoId: null } }], quality: 'best', subtitles: false });
 const advance = vi.spyOn(client.jobs, 'advance').mockRejectedValue(new Error('advance must not run'));
 runtime.transport.fetch = async () => { throw new Error('network is not registered'); };
 const controller = new AbortController(); controller.abort();
 try {
  const final = await runJobForeground(client, runtime, job.id, { signal: controller.signal });
  expect(final.status).toBe('paused');
  expect(advance).not.toHaveBeenCalled();
 } finally { process.exitCode = 0; await client.close(); runtime.state.close(); rmSync(dir, { recursive: true, force: true }); }
});
