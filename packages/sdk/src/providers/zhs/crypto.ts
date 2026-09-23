import { md5Hex } from './md5.js';

export const IV = '1g3qqdh4jvbskb9x';
export const HOME_KEY = '7q9oko0vqb3la20r';
export const VIDEO_KEY = 'azp53h0kft7qi78q';
export const HIKE_SALT = 'o6xpt3b#Qy$Z';

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function aesKey(key: string) {
  return crypto.subtle.importKey('raw', toBytes(key), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

/** AES-128-CBC + PKCS7 (WebCrypto pads natively) + base64 — zhihuishu secretStr. */
export class AesCipher {
  constructor(private readonly key: string, private readonly iv: string = IV) {}

  async encrypt(plain: string): Promise<string> {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: toBytes(this.iv) },
      await aesKey(this.key),
      toBytes(plain),
    );
    return toBase64(new Uint8Array(ciphertext));
  }

  async decrypt(sealed: string): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: toBytes(this.iv) },
      await aesKey(this.key),
      fromBase64(sealed),
    );
    return new TextDecoder().decode(plaintext);
  }
}

/** ev / sdsew: ';'-joined values XORed against a cyclic key, hex encoded. */
export function getEv(values: Array<string | number>, key = 'zzpttjd'): string {
  const text = values.map((v) => String(v)).join(';');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    out += code.toString(16).padStart(2, '0');
  }
  return out;
}

export function revEv(ev: string, key = 'zzpttjd'): string {
  let out = '';
  for (let i = 0; i < ev.length; i += 2) {
    const byte = Number.parseInt(ev.slice(i, i + 2), 16);
    out += String.fromCharCode(byte ^ key.charCodeAt((i / 2) % key.length));
  }
  return out;
}

/** share-course watchPoint: sample int(t/5+2) every 2 seconds of video time. */
export class WatchPoint {
  static readonly INTERVAL = 2;
  private wp: number[] = [0, 1];
  private last = 1;

  constructor(init = 0) {
    this.reset(init);
  }

  reset(init = 0): void {
    this.wp = [0, 1];
    this.last = Math.trunc(init) || 1;
  }

  add(end: number, start?: number): void {
    const from = start === undefined ? this.last : Math.trunc(start);
    const to = Math.trunc(end);
    this.last = to;
    for (let t = from; t <= to; t += WatchPoint.INTERVAL) {
      this.wp.push(Math.trunc(t / 5) + 2);
    }
  }

  get(): string {
    return this.wp.join(',');
  }
}

/** hike saveStuStudyRecord signature: salt + fixed field order + uuid, MD5. */
export function hikeSign(
  uuid: string,
  courseId: string | number,
  fileId: string | number,
  studyTotalTime: string | number,
  startDate: string | number,
  endDate: string | number,
  endWatchTime: string | number,
  startWatchTime: string | number,
): string {
  const raw = `${HIKE_SALT}${uuid}${courseId}${fileId}${studyTotalTime}${startDate}${endDate}${endWatchTime}${startWatchTime}${uuid}`;
  return md5Hex(raw);
}

/** Frontend H:MM:SS format. */
export function hms(seconds: number): string {
  const total = Math.trunc(seconds);
  const h = Math.trunc(total / 3600);
  const m = Math.trunc((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
