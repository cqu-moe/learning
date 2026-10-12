import jpeg from 'jpeg-js';
import { PNG, type PngImage } from 'pngjs';
import qrcode from 'qrcode';

type RgbaImage = {
  width: number;
  height: number;
  data: Buffer;
};

function rasterizeByteQr(bytes: Uint8Array, scale: number): { image: PngImage; modules: number } {
  const source = qrcode.create([{ data: bytes, mode: 'byte' }], { errorCorrectionLevel: 'M' });
  const quietZone = 4;
  const width = (source.modules.size + quietZone * 2) * scale;
  const image = new PNG({ width, height: width });
  image.data.fill(255);
  for (let y = 0; y < source.modules.size; y++) {
    for (let x = 0; x < source.modules.size; x++) {
      if (source.modules.data[y * source.modules.size + x] !== 1) continue;
      for (let offsetY = 0; offsetY < scale; offsetY++) {
        for (let offsetX = 0; offsetX < scale; offsetX++) {
          const offset = (((y + quietZone) * scale + offsetY) * width + (x + quietZone) * scale + offsetX) * 4;
          image.data[offset] = 0;
          image.data[offset + 1] = 0;
          image.data[offset + 2] = 0;
          image.data[offset + 3] = 255;
        }
      }
    }
  }
  return { image, modules: source.modules.size };
}

function resizeRgba(source: RgbaImage, width: number, height: number): RgbaImage {
  const target = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sourceY = ((y + 0.5) * source.height) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const verticalWeight = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = ((x + 0.5) * source.width) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const horizontalWeight = sourceX - x0;
      for (let channel = 0; channel < 4; channel++) {
        const top = source.data[(y0 * source.width + x0) * 4 + channel]! * (1 - horizontalWeight) +
          source.data[(y0 * source.width + x1) * 4 + channel]! * horizontalWeight;
        const bottom = source.data[(y1 * source.width + x0) * 4 + channel]! * (1 - horizontalWeight) +
          source.data[(y1 * source.width + x1) * 4 + channel]! * horizontalWeight;
        target.data[(y * width + x) * 4 + channel] = Math.round(top * (1 - verticalWeight) + bottom * verticalWeight);
      }
    }
  }
  return target;
}

function addCenterLogo(image: PngImage, modules: number): void {
  const pitch = image.width / (modules + 8);
  const radius = Math.max(2, Math.round(pitch * 1.2));
  const centerX = image.width / 2;
  const centerY = image.height / 2;
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y++) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x++) {
      const offset = (y * image.width + x) * 4;
      const insideLogo = Math.abs(x - centerX) <= radius * 0.55 && Math.abs(y - centerY) <= radius * 0.55;
      image.data[offset] = insideLogo ? 22 : 255;
      image.data[offset + 1] = insideLogo ? 119 : 255;
      image.data[offset + 2] = insideLogo ? 255 : 255;
      image.data[offset + 3] = 255;
    }
  }
}

export function byteQrPng(bytes: Uint8Array): Buffer {
  return PNG.sync.write(rasterizeByteQr(bytes, 8).image);
}

export function realisticByteQrJpeg(bytes: Uint8Array): Buffer {
  const raster = rasterizeByteQr(bytes, 8);
  const resized = resizeRgba(raster.image, 469, 467);
  addCenterLogo(resized, raster.modules);
  return jpeg.encode(resized, 82).data;
}
