import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LearningError } from '../../types/errors.js';
import { REFERENCE_FONT } from './reference-font-source.js';

function failure(code: 'INTEGRITY' | 'CANCELED' | 'BUDGET' | 'MISSING_RUNTIME', message: string) {
  return new LearningError({ code, message, retryAfterMs: null, operationId: null });
}
function verified(bytes: Uint8Array): boolean {
  return bytes.length === REFERENCE_FONT.bytes && createHash('sha256').update(bytes).digest('hex') === REFERENCE_FONT.sha256;
}
async function readFont(path: string): Promise<Buffer | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw failure('INTEGRITY', 'reference font must be a regular file');
  if (info.size !== REFERENCE_FONT.bytes) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size !== REFERENCE_FONT.bytes) return null;
    const buffer = Buffer.alloc(REFERENCE_FONT.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    return verified(bytes) ? bytes : null;
  } finally { await file.close(); }
}

/** Only the pinned public reference is downloaded; platform cookies never enter this request. */
export async function loadReferenceFont(options: { directory: string; path?: string; signal?: AbortSignal; deadlineAtMs?: number }): Promise<Uint8Array> {
  if (options.signal?.aborted) throw failure('CANCELED', 'font preparation canceled');
  const remaining = (options.deadlineAtMs ?? Date.now() + 60_000) - Date.now();
  if (remaining <= 0) throw failure('BUDGET', 'font preparation deadline passed');
  if (options.path !== undefined) {
    const bytes = await readFont(options.path);
    if (bytes === null) throw failure('INTEGRITY', 'provided reference font does not match the pinned Noto font');
    return bytes;
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const info = await lstat(options.directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('INTEGRITY', 'reference font cache must be a real directory');
  const destination = resolve(options.directory, REFERENCE_FONT.filename);
  const cached = await readFont(destination);
  if (cached !== null) return cached;
  const timeout = AbortSignal.timeout(Math.min(60_000, remaining));
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let bytes: Buffer;
  try {
    const response = await fetch(REFERENCE_FONT.url, { signal, credentials: 'omit', redirect: 'error' });
    if (response.status !== 200 || response.body === null) throw failure('MISSING_RUNTIME', `reference font download returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > REFERENCE_FONT.bytes) throw failure('INTEGRITY', 'reference font exceeds its pinned size');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    bytes = Buffer.concat(chunks, length);
    if (!verified(bytes)) throw failure('INTEGRITY', 'reference font checksum mismatch');
  } catch (error) {
    if (options.signal?.aborted) throw failure('CANCELED', 'font preparation canceled');
    if (timeout.aborted) throw failure('BUDGET', 'reference font download timed out');
    throw error;
  }
  const temporary = resolve(options.directory, `.font-${randomUUID()}.part`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    if (signal.aborted) throw failure(options.signal?.aborted ? 'CANCELED' : 'BUDGET', 'font preparation interrupted');
    // A symlink appearing during the download is rejected rather than replaced.
    await readFont(destination);
    await rename(temporary, destination);
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  return bytes;
}
