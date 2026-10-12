declare module 'pngjs' {
  export interface DecodedPng {
    width: number;
    height: number;
    data: Buffer;
  }

  export const PNG: {
    sync: { read(buffer: Buffer, options?: { checkCRC?: boolean }): DecodedPng };
  };
}
