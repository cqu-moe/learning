import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error opentype.js 2.0.0 has no bundled declaration file.
import { Font, Glyph, Path } from 'opentype.js';
import { decodeFont } from '../src/runtime/node/font.js';

const referencePath = process.env.LEARNING_FONT_REFERENCE;
const fixtureDir = process.env.LEARNING_FONT_FIXTURES;
const localSamples = Boolean(referencePath && fixtureDir);

function squarePath(size = 600): Path {
  const path = new Path();
  path.moveTo(100, 100);
  path.lineTo(100 + size, 100);
  path.lineTo(100 + size, 100 + size);
  path.lineTo(100, 100 + size);
  path.close();
  return path;
}

function trianglePath(): Path {
  const path = new Path();
  path.moveTo(100, 100);
  path.lineTo(700, 100);
  path.lineTo(400, 700);
  path.close();
  return path;
}

function fontBytes(entries: Array<{ char: string; path: Path }>): Uint8Array {
  const glyphs = [
    new Glyph({ name: '.notdef', advanceWidth: 1000, path: new Path() }),
    ...entries.map(({ char, path }) => new Glyph({
      name: `glyph-${char.codePointAt(0)?.toString(16)}`,
      unicode: char.codePointAt(0),
      advanceWidth: 1000,
      path,
    })),
  ];
  const font = new Font({
    familyName: 'Decode Test',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });
  return new Uint8Array(font.toArrayBuffer());
}

describe('decodeFont', () => {
  it('decodes remapped synthetic glyphs without relying on glyph names', async () => {
    const reference = fontBytes([
      { char: 'A', path: squarePath() },
      { char: 'B', path: trianglePath() },
    ]);
    const obfuscated = fontBytes([{ char: '乙', path: squarePath() }]);

    const result = await decodeFont(obfuscated, reference, ['乙']);

    expect(result.mapping).toEqual([
      expect.objectContaining({ from: '乙', to: 'A', score: expect.any(Number) }),
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('keeps identical reference candidates unresolved', async () => {
    const reference = fontBytes([
      { char: 'A', path: squarePath() },
      { char: 'B', path: squarePath() },
    ]);
    const obfuscated = fontBytes([{ char: '乙', path: squarePath() }]);

    const result = await decodeFont(obfuscated, reference, ['乙']);

    expect(result.mapping).toEqual([]);
    expect(result.unresolved).toEqual(['乙']);
  });

  it('keeps low-confidence and absent input glyphs unresolved', async () => {
    const reference = fontBytes([{ char: 'A', path: squarePath() }]);
    const obfuscated = fontBytes([
      { char: '乙', path: trianglePath() },
      { char: '丁', path: new Path() },
    ]);

    const result = await decodeFont(obfuscated, reference, ['乙', '丁', '目']);

    expect(result.mapping).toEqual([]);
    expect(result.unresolved).toEqual(['乙', '丁', '目']);
  });

  it('rejects corrupt fonts and invalid budgets', async () => {
    const reference = fontBytes([{ char: 'A', path: squarePath() }]);
    await expect(decodeFont(new Uint8Array([1, 2, 3]), reference, ['A'])).rejects.toThrow(/font/i);
    await expect(decodeFont(reference, new Uint8Array([1, 2, 3]), ['A'])).rejects.toThrow(/font/i);
    await expect(decodeFont(reference.slice(0, 10), reference, ['A'])).rejects.toThrow(/font/i);
    await expect(decodeFont(reference, reference, ['A'], { deadlineAtMs: Date.now() - 1 })).rejects.toThrow(/deadline/i);

    const controller = new AbortController();
    controller.abort();
    await expect(decodeFont(reference, reference, ['A'], { signal: controller.signal })).rejects.toThrow(/abort/i);
  });

  describe.skipIf(!localSamples)('local YuKeTang fixtures', () => {
    const cases = [
      ['font_41eedd.ttf', '温列乙门坏早户理印甲纤请减'],
      ['font_0675f0.ttf', '引折尔求器领间着结续命难除'],
      ['font_7e1eae.ttf', '强众含清较收府材五次酶何项'],
    ] as const;
    const expected = '下列哪项是自然语言处理工具';

    it('decodes all three local request fonts', async () => {
      const referenceBytes = new Uint8Array(await readFile(referencePath!));
      for (const [filename, gibberish] of cases) {
        const fontBytes = new Uint8Array(await readFile(join(fixtureDir!, filename)));
        const result = await decodeFont(fontBytes, referenceBytes, [...gibberish]);

        expect(result.mapping.map(({ from, to }) => `${from}:${to}`).join('')).toBe(
          [...gibberish].map((from, index) => `${from}:${expected[index]}`).join(''),
        );
        expect(result.unresolved).toEqual([]);
        for (const item of result.mapping) expect(item.score).toBeGreaterThanOrEqual(0.95);
      }
    }, 120_000);

    it('honors cancellation after the reference cache is established', async () => {
      const referenceBytes = new Uint8Array(await readFile(referencePath!));
      const fontBytes = new Uint8Array(await readFile(join(fixtureDir!, 'font_41eedd.ttf')));
      await decodeFont(fontBytes, referenceBytes, ['温']);

      const characters = Array.from(
        { length: 4_096 },
        (_, index) => String.fromCodePoint(0x3400 + index),
      );
      const controller = new AbortController();
      const pending = decodeFont(fontBytes, referenceBytes, characters, {
        signal: controller.signal,
      });

      // Let the cached-reference decode queue its first setImmediate yield.
      // The abort callback then runs after that yield has resumed, exercising
      // cancellation between mapping batches rather than at function entry.
      await Promise.resolve();
      const abortImmediate = setImmediate(() => controller.abort());

      await expect(pending).rejects.toThrow(/abort/i);

      clearImmediate(abortImmediate);
      const result = await decodeFont(fontBytes, referenceBytes, ['温']);
      expect(Object.hasOwn(result, 'reference')).toBe(false);
    }, 120_000);
  });
});
