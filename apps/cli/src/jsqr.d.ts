declare module 'jsqr' {
  export interface DecodedQr {
    data: string;
    binaryData: number[];
  }

  export interface Options {
    inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
  }

  export default function jsQR(data: Uint8ClampedArray, width: number, height: number, options?: Options): DecodedQr | null;
}
