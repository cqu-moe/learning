import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createCliRuntime } from '../src/runtime.js';
import { Writable } from 'node:stream';
import { createOutput } from '../src/output.js';
import { JobRunner } from '../../../packages/sdk/src/services/jobs.js';
import { createLearningClient } from '@learning/sdk';
import { runJobForeground } from '../src/foreground.js';

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

it('keeps the latest video details through waiting states and reloads course settings on resume', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'learning-progress-'));
  const runtime = createCliRuntime(dir);
  const scope = { userId: 'local', profileId: 'one', platform: 'ykt' as const };
  const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '1' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '2', leafInfoId: null } };
  const runner = new JobRunner(runtime.state, runtime.clock);
  const job = await runner.create(scope, 'study', { total: 2, generation: 1, payload: { kind: 'study', resources: [resource], settings: { speed: 2, targetFraction: 1, questionMode: 'pause', maxDurationSeconds: 3600 } } });
  await runtime.state.commit({ expected: [{ key: 'cli:course:course', revision: null }, { key: 'cli:resource-title:video', revision: null }], changes: [{ key: 'cli:course:course', value: { ref: resource.course, title: '心理健康教育', system: null, term: null, teachers: [], locked: false } }, { key: 'cli:resource-title:video', value: '第一讲' }] });
  await runner.emitProgress(job.id, resource.key, 0.2, { title: null, serverSeconds: 20, durationSeconds: 100 });
  await runner.advance(job.id, async () => ({ completed: false, status: 'waiting', nextRunAtMs: Date.now() + 5000 }));
  let screen = '';
  const stream = new Writable({ write(chunk, _encoding, done) { screen += String(chunk); done(); } });
  const output = createOutput({ format: 'pretty', interactive: true, quiet: false, color: false, debug: false }, { stdout: stream, stderr: stream });
  const controller = new AbortController();
  const client = createLearningClient({ scope, runtime });
  runtime.transport.fetch = async () => { throw new Error('no platform requests allowed'); };
  runtime.waitForWake = async () => {
    const currentFrame = screen.split('\u001b[0J').at(-1);
    expect(currentFrame).toContain('心理健康教育');
    expect(currentFrame).toContain('第一讲');
    expect(currentFrame).toContain('2×');
    expect(currentFrame).toContain('平台已确认 20.0%');
    controller.abort();
  };
  try {
    const result = await runJobForeground(client, Object.assign(runtime, { output }), job.id, { signal: controller.signal });
    expect(result.status).toBe('paused');
  } finally { process.exitCode = 0; output.close(); await client.close(); runtime.state.close(); rmSync(dir, { recursive: true, force: true }); }
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

it('keeps the stopped video visible when a task needs input', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'learning-stopped-progress-'));
  const runtime = createCliRuntime(dir);
  const scope = { userId: 'local', profileId: 'one', platform: 'ykt' as const };
  const runner = new JobRunner(runtime.state, runtime.clock);
  const job = await runner.create(scope, 'study', { total: 2, generation: 1 });
  await runner.advance(job.id, async () => {
    await runner.emitProgress(job.id, 'video', 0.2, { title: '第一讲', serverSeconds: 20, durationSeconds: 100 });
    return { completed: false, status: 'needs-input', items: [{ key: 'video', state: 'needs-input', message: '请处理题目', artifacts: [] }] };
  });
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  const output = createOutput({ format: 'plain', interactive: false, quiet: false, color: false, debug: false }, { stdout: stream, stderr: stream });
  const client = createLearningClient({ scope, runtime });
  try {
    await runJobForeground(client, Object.assign(runtime, { output }), job.id);
    expect(text.trim().split('\n').at(-1)).toContain('需要人工处理 · 0/2 个资源 · 第一讲 · 0:20/1:40');
  } finally { output.close(); await client.close(); runtime.state.close(); rmSync(dir, { recursive: true, force: true }); }
});
