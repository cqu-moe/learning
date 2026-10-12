import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import qrcode from 'qrcode';

const MAX_QR_PIXELS = 4 * 1024 * 1024;
const MAX_QR_IMAGE_BYTES = 1024 * 1024;
const QUIET_ZONE_MODULES = 1;
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

type RawImage = {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
};

type QrModules = {
  size: number;
  data: Uint8Array;
};

function decodePng(bytes: Uint8Array): RawImage {
  if (bytes.byteLength < 24) throw new Error('input is not a bounded PNG image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0 || width * height > MAX_QR_PIXELS) {
    throw new Error('input is not a bounded PNG image');
  }
  return PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
}

function decodeImage(bytes: Uint8Array): RawImage {
  if (bytes.byteLength > MAX_QR_IMAGE_BYTES) throw new Error('QR image exceeds the local rendering budget');
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) &&
      String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
    return decodePng(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: MAX_QR_PIXELS / (1024 * 1024),
      maxMemoryUsageInMB: 64,
    });
  }
  throw new Error('input is not a bounded PNG or JPEG image');
}

function decodeQrModules(image: RawImage): QrModules {
  const pixelCount = image.width * image.height;
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width <= 0 || image.height <= 0 || pixelCount > MAX_QR_PIXELS ||
      image.data.length !== pixelCount * 4) {
    throw new Error('QR image dimensions or RGBA data are invalid');
  }

  const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height, { inversionAttempts: 'attemptBoth' });
  if (decoded === null) throw new Error('QR image could not be decoded locally');
  return encodeQrModules(Uint8Array.from(decoded.binaryData));
}

function encodeQrModules(content: Uint8Array): QrModules {
  try {
    const segment = { data: content, mode: 'byte' as const };
    return qrcode.create([segment], { errorCorrectionLevel: 'M' }).modules;
  } catch {
    throw new Error('decoded QR content cannot be rendered in the terminal');
  }
}

function terminalCharacter(top: boolean, bottom: boolean): string {
  if (top && bottom) return '█';
  if (top) return '▀';
  if (bottom) return '▄';
  return ' ';
}

export function renderImageQrTerminal(bytes: Uint8Array): string {
  return renderQrModules(decodeQrModules(decodeImage(bytes)));
}

export function renderTextQrTerminal(value: string): string {
  if (value === '') throw new Error('QR content is empty');
  return renderQrModules(encodeQrModules(new TextEncoder().encode(value)));
}

function renderQrModules(modules: QrModules): string {
  const size = modules.size + QUIET_ZONE_MODULES * 2;
  const rows: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let row = '';
    for (let x = 0; x < size; x++) {
      const moduleY = y - QUIET_ZONE_MODULES;
      const moduleX = x - QUIET_ZONE_MODULES;
      const inModules = moduleY >= 0 && moduleY < modules.size && moduleX >= 0 && moduleX < modules.size;
      const top = inModules && modules.data[moduleY * modules.size + moduleX] === 1;
      const nextY = moduleY + 1;
      const bottom = nextY >= 0 && nextY < modules.size && moduleX >= 0 && moduleX < modules.size &&
        modules.data[nextY * modules.size + moduleX] === 1;
      row += terminalCharacter(top, bottom);
    }
    rows.push(row);
  }
  const setup = '\x1b[47m\x1b[30m';
  const reset = '\x1b[0m';
  return rows.map(row => setup + row + reset).join('\n') + '\n';
}
