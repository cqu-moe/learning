import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode';
import { renderPngQrTerminal } from '../src/qr-terminal.js';

function rebuildRenderedModules(rendered: string): boolean[][] {
  const lines = stripVTControlCharacters(rendered)
    .split('\n')
    .filter(line => line.length > 0);
  const matrix: boolean[][] = [];
  for (const line of lines) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const char of line) {
      if (char === '█') { top.push(true); bottom.push(true); }
      else if (char === '▀') { top.push(true); bottom.push(false); }
      else if (char === '▄') { top.push(false); bottom.push(true); }
      else if (char === ' ') { top.push(false); bottom.push(false); }
      else throw new Error(`unexpected QR terminal character: U+${char.codePointAt(0)!.toString(16)}`);
    }
    matrix.push(top, bottom);
  }
  return matrix;
}

describe('PNG QR terminal rendering', () => {
  it('preserves the source QR module matrix and quiet zone', async () => {
    const value = 'https://example.com/zhs-terminal-qr';
    const source = qrcode.create(value, { errorCorrectionLevel: 'M' });
    const size = source.modules.size;
    const png = await qrcode.toBuffer(value, { type: 'png', margin: 4, scale: 4 });
    const displayed = rebuildRenderedModules(renderPngQrTerminal(png)).slice(0, size + 8);

    expect(displayed.length).toBe(size + 8);
    expect(displayed[0]!.every(dark => !dark)).toBe(true);
    expect(displayed.at(-1)!.every(dark => !dark)).toBe(true);
    for (let y = 0; y < size; y++) {
      expect(displayed[y + 4]!.slice(4, size + 4)).toEqual([...source.modules.data.slice(y * size, (y + 1) * size)].map(Boolean));
    }
  });
});
