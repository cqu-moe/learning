declare module 'qrcode' {
  const qrcode: { toBuffer(value: string, options: { type: 'png' }): Promise<Buffer>; toString(value: string, options: { type: 'terminal'; small: boolean }): Promise<string> };
  export default qrcode;
}
