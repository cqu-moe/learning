import { LearningError } from '../types/errors.js';

const IV_BYTES = 12;
const KEY_BYTES = 32;

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

async function importKey(masterKey: Uint8Array) {
  if (masterKey.byteLength !== KEY_BYTES) {
    throw new LearningError({
      code: 'INVALID_INPUT',
      message: 'master key must be 32 bytes',
      retryAfterMs: null,
      operationId: null,
    });
  }
  return crypto.subtle.importKey('raw', masterKey.buffer instanceof ArrayBuffer ? masterKey.buffer : masterKey, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM with a fresh random IV and caller-provided AAD; output is "iv.ciphertext" (base64). */
export async function encryptJson(
  masterKey: Uint8Array,
  plaintext: string,
  aad: string,
): Promise<string> {
  const key = await importKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: toBytes(aad) },
    key,
    toBytes(plaintext),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptJson(
  masterKey: Uint8Array,
  payload: string,
  aad: string,
): Promise<string> {
  const [ivPart, dataPart] = payload.split('.');
  if (ivPart === undefined || dataPart === undefined) {
    throw new LearningError({ code: 'STORAGE', message: 'malformed ciphertext', retryAfterMs: null, operationId: null });
  }
  const key = await importKey(masterKey);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(ivPart), additionalData: toBytes(aad) },
      key,
      fromBase64(dataPart),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new LearningError({
      code: 'STORAGE',
      message: 'decryption failed (wrong key, AAD, or corrupted record)',
      retryAfterMs: null,
      operationId: null,
    });
  }
}
