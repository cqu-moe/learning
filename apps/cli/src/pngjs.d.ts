declare module 'pngjs' {
  export interface PngImage {
    width: number;
    height: number;
    data: Buffer;
  }

  export interface DecodedPng {
    width: number;
    height: number;
    data: Buffer;
  }

  export const PNG: {
    new(options: { width: number; height: number }): PngImage;
    sync: {
      read(buffer: Buffer, options?: { checkCRC?: boolean }): DecodedPng;
      write(image: PngImage): Buffer;
    };
  };
}
