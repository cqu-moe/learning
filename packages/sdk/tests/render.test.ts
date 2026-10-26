import { describe, expect, it } from 'vitest';
import { matchGlyph, checkRenderBudget } from '../src/content/font-match.js';
import { composePdfFromImages } from '../src/content/pdf.js';
import { LocalHeavyRenderer } from '../src/runtime/node/render.js';
import { NodeArtifactStore } from '../src/runtime/node/artifacts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe('font matching (T24, A241/A242)', () => {
  it('returns exact for unambiguous glyphs and unresolved for ambiguous or missing references', () => {
    const references = [
      { char: '甲', vector: [1, 0, 0] },
      { char: '乙', vector: [0, 1, 0] },
    ];
    expect(matchGlyph([1, 0, 0], references)).toMatchObject({ state: 'exact', char: '甲' });
    expect(matchGlyph([0.5, 0.5, 0], references)).toMatchObject({ state: 'unresolved' });
    expect(matchGlyph([1, 0, 0], [])).toMatchObject({ state: 'unresolved' });
    expect(matchGlyph([1, 0, 999], [{ char: '甲', vector: [1, 0] }])).toMatchObject({ state: 'unresolved' });
    expect(matchGlyph([1, Number.NaN], [{ char: '甲', vector: [1, 0] }])).toMatchObject({ state: 'unresolved' });
    expect(matchGlyph([1, 0], [{ char: '甲', vector: [1, 0] }, { char: '乙', vector: [0.99, 0.1] }])).toMatchObject({ state: 'unresolved' });
  });

  it('rejects over-budget inputs before any render work', () => {
    expect(() => checkRenderBudget({ pages: 501, pixels: 0, deadlineAtMs: 0, nowMs: 0 })).toThrow(/pages/);
    expect(() => checkRenderBudget({ pages: 1, pixels: 100_000_001, deadlineAtMs: 0, nowMs: 0 })).toThrow(/pixels/);
    expect(() => checkRenderBudget({ pages: 1, pixels: 1, deadlineAtMs: 100, nowMs: 200 })).toThrow(/deadline/);
    expect(checkRenderBudget({ pages: 10, pixels: 1000, deadlineAtMs: 10_000, nowMs: 0 })).toBe(true);
  });
});

describe('pdf compose (T24)', () => {
  it('builds a bounded pdf from synthetic png pages with a versioned digest', async () => {
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const result = await composePdfFromImages([new Uint8Array(png1x1), new Uint8Array(png1x1)], '测试');
    expect(result.pdfBytes.byteLength).toBeGreaterThan(100);
    expect(result.rendererVersion).toMatch(/^render-node\/1/);
  });
});

describe('local heavy renderer (T24)', () => {
  it('reports both a failed PDF write and a failing cleanup', async () => {
    const primary = new Error('PDF write failed');
    const cleanup = new Error('PDF cleanup failed');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const unexpected = async (): Promise<never> => { throw new Error('unexpected artifact operation'); };
    const errors: unknown[] = [];
    const renderer = new LocalHeavyRenderer({
      artifacts: {
        create: async () => ({ write: async () => { throw primary; }, finish: unexpected, checkpoint: unexpected, abort: async () => { throw cleanup; } }),
        open: async () => new ReadableStream({ start(controller) { controller.enqueue(png); controller.close(); } }),
        resume: unexpected,
        remove: unexpected,
      },
      scope: { userId: 'local', profileId: 'fixture', platform: 'ykt' },
    }, event => errors.push(event.error));
    await renderer.start({ taskId: 'dual-failure', attempt: 1, request: { type: 'pdf.compose', imageArtifactIds: ['page'], title: 'fixture' }, deadlineAtMs: Date.now() + 60_000 });
    expect(errors).toEqual([primary, cleanup]);
    expect(await renderer.status('dual-failure', 1)).toMatchObject({ status: 'failed' });
  });

  it('reports a failed reader cleanup while preserving the primary read failure', async () => {
    const primary = new DOMException('artifact read timed out', 'AbortError');
    const cleanup = new Error('reader cancel failed');
    const events: Array<Record<string, unknown>> = [];
    const failingReader = {
      read: () => Promise.reject(primary),
      cancel: () => Promise.reject(cleanup),
    };
    const renderer = new LocalHeavyRenderer({
      artifacts: {
        open: async () => ({ getReader: () => failingReader }) as unknown as ReadableStream<Uint8Array>,
        create: async () => { throw new Error('unexpected artifact operation'); },
        resume: async () => { throw new Error('unexpected artifact operation'); },
        remove: async () => {},
      },
      scope: { userId: 'local', profileId: 'fixture', platform: 'ykt' },
    }, event => events.push(event));

    await renderer.start({
      taskId: 'read-cleanup',
      attempt: 2,
      request: { type: 'pdf.compose', imageArtifactIds: ['page'], title: 'fixture' },
      deadlineAtMs: Date.now() + 60_000,
    });

    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      {
        level: 'error',
        message: 'Learning SDK operation failed',
        error: primary,
        fields: { stage: 'render.task.pdf.compose', attempt_id: 2 },
      },
      {
        level: 'error',
        message: 'Learning SDK operation failed',
        error: cleanup,
        fields: { stage: 'render.read.cleanup', attempt_id: 2 },
      },
    ]));
    expect(await renderer.status('read-cleanup', 2)).toMatchObject({
      status: 'failed',
      error: { code: 'INTEGRITY' },
    });
  });

  it('never claims font decoding succeeded without the reference corpus', async () => {
    const renderer = new LocalHeavyRenderer();
    await renderer.start({ taskId: 't1', attempt: 1, request: { type: 'font.decode', fontArtifactId: 'f', characters: ['甲'] }, deadlineAtMs: Date.now() + 60_000 });
    const status = await renderer.status('t1', 1);
    expect(status).toMatchObject({ status: 'failed', error: { code: 'MISSING_RUNTIME' } });
    const stale = await renderer.status('t1', 2);
    expect(stale).toMatchObject({ status: 'missing' });
    await renderer.cancel('t1', 1);
    expect((await renderer.status('t1', 1)).status).toBe('missing');
  });

  it('publishes an actual PDF artifact from a bounded PNG and rejects changed retry input', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-render-'));
    try {
      const artifacts = new NodeArtifactStore(dir);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const source = await artifacts.create({ id: 'image-1', mimeType: 'image/png' });
      await source.write(png);
      await source.finish();
      const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
      const renderer = new LocalHeavyRenderer({ artifacts, scope });
      const request = { type: 'pdf.compose' as const, imageArtifactIds: ['image-1'], title: 'lesson' };
      await renderer.start({ taskId: 'pdf1', attempt: 1, request, deadlineAtMs: Date.now() + 60_000 });
      const status = await renderer.status('pdf1', 1);
      expect(status).toMatchObject({ status: 'succeeded', result: { type: 'pdf.compose', artifact: { scope, mimeType: 'application/pdf' } } });
      if (status.status !== 'succeeded' || status.result.type !== 'pdf.compose') throw Error('missing PDF result');
      const reader = (await artifacts.open(status.result.artifact.id)).getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value ?? []).toString('utf8', 0, 4)).toBe('%PDF');
      await reader.cancel();
      await expect(renderer.start({ taskId: 'pdf1', attempt: 1, request: { ...request, title: 'changed' }, deadlineAtMs: Date.now() + 60_000 })).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
      expect((await renderer.status('pdf1', 1)).status).toBe('succeeded');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports renderer failures before storing safe RenderState error data', async () => {
    const cause = new Error('artifact disk unavailable');
    const events: unknown[] = [];
    const renderer = new LocalHeavyRenderer({
      artifacts: {
        create: async () => { throw cause; },
        resume: async () => { throw cause; },
        open: async () => { throw cause; },
        remove: async () => {},
      },
      scope: { userId: 'local', profileId: 'p1', platform: 'ykt' },
    }, event => events.push(event));

    await renderer.start({
      taskId: 'render-diagnostic',
      attempt: 1,
      request: { type: 'pdf.compose', imageArtifactIds: ['missing'], title: 'lesson' },
      deadlineAtMs: Date.now() + 60_000,
    });
    const state = await renderer.status('render-diagnostic', 1);

    expect(state).toMatchObject({ status: 'failed', error: { code: 'INTEGRITY' } });
    expect(events).toEqual([{
      level: 'error',
      message: 'Learning SDK operation failed',
      error: cause,
      fields: { stage: 'render.task.pdf.compose', attempt_id: 1 },
    }]);
  });
});
