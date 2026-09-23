declare module 'qrcode' {
  const qrcode: { toString(value: string, options: { type: 'terminal'; small: boolean }): Promise<string> };
  export default qrcode;
}
