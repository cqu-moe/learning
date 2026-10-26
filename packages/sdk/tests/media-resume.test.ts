import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NodeArtifactStore } from '../src/runtime/node/artifacts.js';
import { advanceMedia } from '../src/services/media-export.js';
import { downloadDirectMedia } from '../src/services/direct-media.js';
import { JobRunner } from '../src/services/jobs.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';

describe('media Range resume', () => {
  it('streams a synthetic multi-GiB response in bounded chunks and never publishes over-budget media', async () => {
    const scope = { userId: 'local', profileId: 'large-stream', platform: 'xuetang' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'S', skuId: '1' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const state = new MemoryStateStore();
    const clock = new FakeClock();
    const runner = new JobRunner(state, clock);
    const saved = { type: 'media' as const, resources: [resource], quality: 'best' as const, subtitles: false };
    const job = await runner.create(scope, 'export', { total: 1, payload: saved });
    let written = 0;
    let maxChunk = 0;
    let published = false;
    let aborted = false;
    const artifactId = `${job.id}:${resource.key}:media`;
    const artifacts: Runtime['artifacts'] = {
      create: async () => ({
        write: async (bytes) => { written += bytes.byteLength; maxChunk = Math.max(maxChunk, bytes.byteLength); },
        checkpoint: async () => ({ id: artifactId, bytes: written }),
        finish: async () => { published = true; return { bytes: written, sha256: '0'.repeat(64) }; },
        abort: async () => { aborted = true; },
      }),
      resume: async () => { throw Error('unexpected resume'); },
      open: async () => { throw Error('unexpected open'); },
      remove: async () => {},
    };
    const runtime: Runtime = { transport: new FakeTransport(), state, clock, artifacts, masterKey: new Uint8Array(32), heavy: null, model: null, log: () => {}, wake: async () => {} };
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent <= 512) { controller.enqueue(chunk); sent += 1; }
      else controller.close();
    } });
    await expect(advanceMedia({ runner, runtime, job, scope,
      getMedia: async () => ({ resource, variants: [{ id: 'https://www.xuetangx.com/large.mp4', quality: 'hd', mimeType: 'video/mp4', durationSeconds: null }] }),
      getTranscript: async () => { throw Error('unused'); },
      getAsset: async () => ({ status: 200, headers: new Headers({ etag: 'fixture' }), mimeType: 'video/mp4', stream }),
    }, saved)).rejects.toThrow(/4 GiB/);
    expect(written).toBe(4 * 1024 * 1024 * 1024);
    expect(maxChunk).toBe(8 * 1024 * 1024);
    expect(published).toBe(false);
    expect(aborted).toBe(true);
    expect((await runner.get(job.id)).status).toBe('paused');
  }, 20_000);

  it('checkpoints a partial MP4 and appends only with 206 and the same validator', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-range-'));
    try {
      const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
      const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'S', skuId: '1' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
      const state = new MemoryStateStore();
      const clock = new FakeClock();
      const artifacts = new NodeArtifactStore(dir);
      const runtime: Runtime = { transport: new FakeTransport(), state, clock, artifacts, masterKey: new Uint8Array(32), heavy: null, model: null, log: () => {}, wake: async () => {} };
      const runner = new JobRunner(state, clock);
      const saved = { type: 'media' as const, resources: [resource], quality: 'best' as const, subtitles: false };
      const job = await runner.create(scope, 'export', { total: 1, payload: saved });
      let request = 0;
      const deps = {
        runner, runtime, scope, getMedia: async () => ({ resource, variants: [{ id: 'https://www.xuetangx.com/video.mp4', quality: 'hd', mimeType: 'video/mp4', durationSeconds: 10 }] }),
        getTranscript: async () => { throw Error('unused'); },
        getAsset: async (_url: string, _max: number, headers?: Record<string, string>) => {
          request += 1;
          if (request === 1) {
            expect(headers).toBeUndefined();
            let pull = 0;
            return { status: 200, headers: new Headers({ etag: '"v1"' }), mimeType: 'video/mp4', stream: new ReadableStream<Uint8Array>({ pull(controller) { pull += 1; if (pull === 1) controller.enqueue(new TextEncoder().encode('abc')); else controller.error(new Error('interrupted')); } }) };
          }
          expect(headers).toEqual({ range: 'bytes=3-', 'if-range': '"v1"' });
          return { status: 206, headers: new Headers({ etag: '"v1"', 'content-range': 'bytes 3-5/6' }), mimeType: 'video/mp4', stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('def')); controller.close(); } }) };
        },
      };
      await expect(advanceMedia({ ...deps, job }, saved)).rejects.toThrow();
      expect((await runner.get(job.id)).status).toBe('paused');
      expect(await state.get(`download:${job.id}:video`)).not.toBeNull();
      await runner.resume(job.id);
      const done = await advanceMedia({ ...deps, job: await runner.get(job.id) }, saved);
      expect(done.status).toBe('succeeded');
      expect(request).toBe(2);
      const reader = (await artifacts.open(done.items[0]!.artifacts[0]!.id)).getReader();
      const parts: Uint8Array[] = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
      expect(Buffer.concat(parts).toString()).toBe('abcdef');
      expect(await state.get(`download:${job.id}:video`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a completed video when optional transcript lookup fails', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-subtitle-'));
    try {
      const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
      const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'S', skuId: '1' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
      const state = new MemoryStateStore();
      const clock = new FakeClock();
      const artifacts = new NodeArtifactStore(dir);
      const cause = new Error('subtitle service unavailable');
      const events: Array<Parameters<Runtime['log']>[0]> = [];
      const runtime: Runtime = { transport: new FakeTransport(), state, clock, artifacts, masterKey: new Uint8Array(32), heavy: null, model: null, log: event => events.push(event), wake: async () => {} };
      const runner = new JobRunner(state, clock);
      const saved = { type: 'media' as const, resources: [resource], quality: 'best' as const, subtitles: true };
      const job = await runner.create(scope, 'export', { total: 1, payload: saved });
      const result = await advanceMedia({ runner, runtime, job, scope,
        getMedia: async () => ({ resource, variants: [{ id: 'https://www.xuetangx.com/video.mp4', quality: 'hd', mimeType: 'video/mp4', durationSeconds: 10 }] }),
        getTranscript: async () => { throw cause; },
        getAsset: async () => ({ status: 200, headers: new Headers({ etag: '"v1"' }), mimeType: 'video/mp4', stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('video')); controller.close(); } }) }),
      }, saved);
      expect(result.status).toBe('succeeded');
      expect(result.items[0]?.artifacts).toHaveLength(1);
      expect(result.items[0]?.message).toContain('transcript');
      expect(events).toEqual([{
        level: 'error',
        message: 'Learning SDK operation failed',
        error: cause,
        fields: { stage: 'export.transcript', job_id: job.id, resource_key: 'video', recovered: true },
    }, {
      level: 'warn',
      message: 'transcript unavailable; video kept',
      fields: { resourceKey: 'video' },
      }]);
      expect((await artifacts.open(result.items[0]!.artifacts[0]!.id)).getReader).toBeTypeOf('function');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const responseMode of ['full-200', 'range-416', 'changed-validator'] as const) {
    it(`restarts from byte zero after ${responseMode}`, async () => {
      const dir = mkdtempSync(resolve(tmpdir(), 'learning-restart-'));
      try {
        const runtime: Runtime = { transport: new FakeTransport(), state: new MemoryStateStore(), clock: new FakeClock(), artifacts: new NodeArtifactStore(dir), masterKey: new Uint8Array(32), heavy: null, model: null, log: () => {}, wake: async () => {} };
        let calls = 0;
        const body = (value: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
        const getAsset = async (_url: string, _max: number, headers?: Record<string, string>) => {
          calls += 1;
          if (calls === 1) {
            let pull = 0;
            return { status: 200, headers: new Headers({ etag: '"v1"' }), mimeType: 'video/mp4', stream: new ReadableStream<Uint8Array>({ pull(controller) { pull += 1; if (pull === 1) controller.enqueue(new TextEncoder().encode('old')); else controller.error(Error('disconnect')); } }) };
          }
          if (calls === 2) {
            expect(headers).toEqual({ range: 'bytes=3-', 'if-range': '"v1"' });
            if (responseMode === 'full-200') return { status: 200, headers: new Headers({ etag: '"v2"' }), mimeType: 'video/mp4', stream: body('fresh') };
            if (responseMode === 'range-416') return { status: 416, headers: new Headers(), mimeType: 'video/mp4', stream: body('') };
            return { status: 206, headers: new Headers({ etag: '"v2"', 'content-range': 'bytes 3-7/8' }), mimeType: 'video/mp4', stream: body('wrong') };
          }
          expect(headers).toBeUndefined();
          return { status: 200, headers: new Headers({ etag: '"v2"' }), mimeType: 'video/mp4', stream: body('fresh') };
        };
        const input = { runtime, jobId: 'job-restart', resourceKey: 'video', artifactId: 'media', url: 'https://www.xuetangx.com/video.mp4', getAsset };
        await expect(downloadDirectMedia(input)).rejects.toThrow();
        await downloadDirectMedia(input);
        expect(calls).toBe(responseMode === 'full-200' ? 2 : 3);
        const reader = (await runtime.artifacts.open('media')).getReader();
        const parts: Uint8Array[] = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
        expect(Buffer.concat(parts).toString()).toBe('fresh');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it('reports a rejected resume before restarting a direct download', async () => {
    const cause = new Error('partial file checksum mismatch');
    const events: Array<Parameters<Runtime['log']>[0]> = [];
    const body = (value: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
    const runtime: Runtime = {
      transport: new FakeTransport(),
      state: new MemoryStateStore(),
      clock: new FakeClock(),
      artifacts: {
        create: async () => ({
          write: async () => {},
          checkpoint: async () => ({ bytes: 0 }),
          finish: async () => ({ bytes: 5, sha256: '0'.repeat(64) }),
          abort: async () => {},
        }),
        resume: async () => { throw cause; },
        open: async () => body('fresh'),
        remove: async () => {},
      },
      masterKey: new Uint8Array(32),
      heavy: null,
      model: null,
      log: event => events.push(event),
      wake: async () => {},
    };
    await runtime.state.commit({
      expected: [],
      changes: [{
        key: 'download:job:video',
        value: { url: 'https://www.xuetangx.com/video.mp4?token=SECRET', validator: 'v1', bytes: 3, checkpoint: { id: 'media', bytes: 3, sha256: '0'.repeat(64) } },
      }],
    });
    const getAsset = async (_url: string, _max: number, headers?: Record<string, string>) => headers === undefined
      ? { status: 200, headers: new Headers({ etag: 'v2' }), mimeType: 'video/mp4', stream: body('fresh') }
      : { status: 206, headers: new Headers({ etag: 'v1', 'content-range': 'bytes 3-5/6' }), mimeType: 'video/mp4', stream: body('') };

    await downloadDirectMedia({ runtime, jobId: 'job', resourceKey: 'video', artifactId: 'media', url: 'https://www.xuetangx.com/video.mp4?token=SECRET', getAsset });

    expect(events).toEqual([{
      level: 'error',
      message: 'Learning SDK operation failed',
      error: cause,
      fields: {
        stage: 'media.resume',
        job_id: 'job',
        resource_key: 'video',
        endpoint: 'https://www.xuetangx.com/video.mp4',
        recovered: true,
      },
    }]);
    expect(JSON.stringify(events[0]?.fields)).not.toContain('SECRET');
  });
});
