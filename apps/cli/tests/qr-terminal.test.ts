import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { byteQrPng, realisticByteQrJpeg } from './helpers/qr-images.js';
import { renderImageQrTerminal } from '../src/qr-terminal.js';

const payload = Uint8Array.of(0x80, 0xff, 0x00, 0x42, 0x7f, 0xc3, 0x01, 0xfe);

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

function decodeImageQr(bytes: Uint8Array): Uint8Array {
  const image = bytes[0] === 0xff && bytes[1] === 0xd8
    ? jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
    : PNG.sync.read(Buffer.from(bytes));
  const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height, { inversionAttempts: 'dontInvert' });
  expect(decoded).not.toBeNull();
  return Uint8Array.from(decoded!.binaryData);
}

function decodeRenderedQr(rendered: string): Uint8Array {
  const matrix = rebuildRenderedModules(rendered);
  const scale = 2;
  const width = matrix[0]!.length * scale;
  const height = matrix.length * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      const value = dark ? 0 : 255;
      for (let offsetY = 0; offsetY < scale; offsetY++) {
        for (let offsetX = 0; offsetX < scale; offsetX++) {
          const offset = (((y * scale) + offsetY) * width + (x * scale) + offsetX) * 4;
          data[offset] = value;
          data[offset + 1] = value;
          data[offset + 2] = value;
          data[offset + 3] = 255;
        }
      }
    });
  });
  const decoded = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  expect(decoded).not.toBeNull();
  return Uint8Array.from(decoded!.binaryData);
}

function isQrSize(size: number): boolean {
  return size >= 21 && size <= 177 && (size - 21) % 4 === 0;
}

function expectTerminalQr(rendered: string): void {
  let rows = rebuildRenderedModules(rendered);
  if (rows.length > 23 && !isQrSize(rows.length - 2) && rows.at(-1)!.every(dark => !dark)) rows = rows.slice(0, -1);
  const size = rows.length - 2;
  expect(isQrSize(size)).toBe(true);
  expect(rows.slice(0, 1).every(row => row.every(dark => !dark))).toBe(true);
  expect(rows.slice(-1).every(row => row.every(dark => !dark))).toBe(true);
  expect(rows.every(row => row.slice(0, 1).every(dark => !dark))).toBe(true);
  expect(rows.every(row => row.slice(-1).every(dark => !dark))).toBe(true);

  const finder = [
    [true, true, true, true, true, true, true],
    [true, false, false, false, false, false, true],
    [true, false, true, true, true, false, true],
    [true, false, true, true, true, false, true],
    [true, false, true, true, true, false, true],
    [true, false, false, false, false, false, true],
    [true, true, true, true, true, true, true],
  ];
  for (const [x, y] of [[1, 1], [size - 6, 1], [1, size - 6]] as const) {
    for (let offsetY = 0; offsetY < 7; offsetY++) {
      expect(rows[y + offsetY]!.slice(x, x + 7)).toEqual(finder[offsetY]);
    }
  }
  expect(decodeRenderedQr(rendered)).toEqual(payload);
}

describe('image QR terminal rendering', () => {
  it('renders a byte-mode PNG QR with its content and quiet zone intact', () => {
    const png = byteQrPng(payload);
    const rendered = renderImageQrTerminal(png);

    expectTerminalQr(rendered);
    expect(decodeImageQr(png)).toEqual(payload);
  });

  it('renders a resized logo-bearing JPEG QR with the same byte content', () => {
    const jpegBytes = realisticByteQrJpeg(payload);
    const rendered = renderImageQrTerminal(jpegBytes);

    expectTerminalQr(rendered);
    expect(decodeImageQr(jpegBytes)).toEqual(payload);
  });

  it('rejects truncated and over-budget PNG headers before decoding', () => {
    const png = byteQrPng(payload);
    expect(() => renderImageQrTerminal(png.subarray(0, 20))).toThrow(/bounded PNG/);

    const overBudget = new Uint8Array(png);
    const view = new DataView(overBudget.buffer, overBudget.byteOffset, overBudget.byteLength);
    view.setUint32(16, 3000);
    view.setUint32(20, 3000);
    expect(() => renderImageQrTerminal(overBudget)).toThrow(/bounded PNG/);
  });
});
