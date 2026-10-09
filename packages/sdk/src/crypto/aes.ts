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

/** Runtime-neutral AES-CBC/PKCS7 + base64 used by platform login forms. */
export class AesCipher {
  constructor(private readonly key: string, private readonly iv: string) {}

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
