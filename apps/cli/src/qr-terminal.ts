import { PNG } from 'pngjs';

const MAX_QR_PIXELS = 4 * 1024 * 1024;
const MAX_QR_PNG_BYTES = 1024 * 1024;
const QUIET_ZONE_MODULES = 4;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

type Bitmap = {
  width: number;
  height: number;
  dark: boolean[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function otsuThreshold(luminance: number[]): number {
  const histogram = new Array<number>(256).fill(0);
  for (const value of luminance) histogram[Math.min(255, Math.max(0, Math.round(value)))]!++;

  let sum = 0;
  for (let value = 0; value < histogram.length; value++) sum += value * histogram[value]!;
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestThreshold = 128;
  let bestVariance = -1;
  for (let threshold = 0; threshold < 256; threshold++) {
    backgroundWeight += histogram[threshold]!;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = luminance.length - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += threshold * histogram[threshold]!;
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestThreshold = threshold;
      bestVariance = variance;
    }
  }
  return bestThreshold;
}

function decodeBitmap(bytes: Uint8Array): Bitmap {
  if (bytes.byteLength < 24 || bytes.byteLength > MAX_QR_PNG_BYTES ||
      !bytes.subarray(0, 8).every((byte, index) => byte === PNG_SIGNATURE[index]) ||
      String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
    throw new Error('input is not a bounded PNG image');
  }
  const declaredWidth = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
  const declaredHeight = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
  if (declaredWidth <= 0 || declaredHeight <= 0 || declaredWidth * declaredHeight > MAX_QR_PIXELS) {
    throw new Error('QR PNG dimensions exceed the local rendering budget');
  }
  const png = PNG.sync.read(Buffer.from(bytes));
  if (!Number.isSafeInteger(png.width) || !Number.isSafeInteger(png.height) ||
      png.width <= 0 || png.height <= 0 || png.width * png.height > MAX_QR_PIXELS ||
      png.data.length !== png.width * png.height * 4) {
    throw new Error('QR PNG dimensions or RGBA data are invalid');
  }

  const luminance: number[] = new Array(png.width * png.height);
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const alpha = png.data[offset + 3]! / 255;
    const red = png.data[offset]! * alpha + 255 * (1 - alpha);
    const green = png.data[offset + 1]! * alpha + 255 * (1 - alpha);
    const blue = png.data[offset + 2]! * alpha + 255 * (1 - alpha);
    luminance[offset / 4] = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  const threshold = otsuThreshold(luminance);
  const dark = luminance.map(value => value <= threshold);

  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!dark[y * png.width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('QR PNG contains no dark modules');
  return { width: png.width, height: png.height, dark, minX, minY, maxX, maxY };
}

function extractModules(image: Bitmap): boolean[][] {
  const width = image.maxX - image.minX + 1;
  const height = image.maxY - image.minY + 1;
  let finderRun = 0;
  while (image.minX + finderRun <= image.maxX && image.dark[image.minY * image.width + image.minX + finderRun]) finderRun++;

  const pitch = finderRun / 7;
  const modules = Math.round(width / pitch);
  if (finderRun === 0 || pitch < 1 || modules < 21 || modules > 177 || (modules - 21) % 4 !== 0 ||
      Math.abs(width / pitch - modules) > 0.25 || Math.abs(height / pitch - modules) > 0.25) {
    throw new Error('QR PNG module grid cannot be determined');
  }

  const matrix: boolean[][] = [];
  for (let y = 0; y < modules; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < modules; x++) {
      const sampleX = image.minX + Math.floor((x + 0.5) * pitch);
      const sampleY = image.minY + Math.floor((y + 0.5) * pitch);
      row.push(image.dark[sampleY * image.width + sampleX] === true);
    }
    matrix.push(row);
  }
  return matrix;
}

function terminalCharacter(top: boolean, bottom: boolean): string {
  if (top && bottom) return '█';
  if (top) return '▀';
  if (bottom) return '▄';
  return ' ';
}

export function renderPngQrTerminal(bytes: Uint8Array): string {
  const modules = extractModules(decodeBitmap(bytes));
  const size = modules.length + QUIET_ZONE_MODULES * 2;
  const rows: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const moduleY = y - QUIET_ZONE_MODULES;
      const moduleX = x - QUIET_ZONE_MODULES;
      const inModules = moduleY >= 0 && moduleY < modules.length && moduleX >= 0 && moduleX < modules.length;
      const top = inModules && modules[moduleY]![moduleX] === true;
      const nextY = moduleY + 1;
      const bottom = nextY >= 0 && nextY < modules.length && moduleX >= 0 && moduleX < modules.length && modules[nextY]![moduleX] === true;
      row += terminalCharacter(top, bottom);
    }
    rows.push(row);
  }
  const setup = '\x1b[47m\x1b[30m';
  const reset = '\x1b[0m';
  return rows.map(row => setup + row + reset).join('\n') + '\n';
}
