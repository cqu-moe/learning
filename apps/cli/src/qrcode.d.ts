declare module 'qrcode' {
  type QrByteSegment = { data: string | Uint8Array; mode: 'byte' };
  const qrcode: {
    create(value: string | QrByteSegment[], options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): {
      modules: { size: number; data: Uint8Array };
    };
    toBuffer(value: string, options: { type: 'png'; margin?: number; scale?: number }): Promise<Buffer>;
    toString(value: string, options: { type: 'terminal'; small: boolean }): Promise<string>;
  };
  export default qrcode;
}
