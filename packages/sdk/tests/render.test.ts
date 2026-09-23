import { describe, expect, it } from 'vitest';
import { matchGlyph, checkRenderBudget } from '../src/content/font-match.js';
import { composePdfFromImages } from '../src/content/pdf.js';
import { LocalHeavyRenderer } from '../src/runtime/node/render.js';

describe('font matching (T24, A241/A242)', () => {
  it('returns exact for unambiguous glyphs and unresolved for ambiguous or missing references', () => {
    const references = [
      { char: '甲', vector: [1, 0, 0] },
      { char: '乙', vector: [0, 1, 0] },
    ];
    expect(matchGlyph([1, 0, 0], references)).toMatchObject({ state: 'exact', char: '甲' });
    expect(matchGlyph([0.5, 0.5, 0], references)).toMatchObject({ state: 'unresolved' });
    expect(matchGlyph([1, 0, 0], [])).toMatchObject({ state: 'unresolved' });
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
  it('start/status/cancel covers font.decode with missing-after-cancel semantics', async () => {
    const renderer = new LocalHeavyRenderer();
    await renderer.start({ taskId: 't1', attempt: 1, request: { type: 'font.decode', fontArtifactId: 'f', characters: ['甲'] }, deadlineAtMs: 1_000_000_000_000 });
    const status = await renderer.status('t1', 1);
    expect(status.status).toBe('succeeded');
    const stale = await renderer.status('t1', 2);
    expect(stale).toMatchObject({ status: 'missing' });
    await renderer.cancel('t1', 1);
    expect((await renderer.status('t1', 1)).status).toBe('missing');
  });
});
