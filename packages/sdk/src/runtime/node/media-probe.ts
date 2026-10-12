import { execFile } from 'node:child_process';
import type { Options } from '../types.js';

const MAX_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export async function probeMediaDuration(url: string, options?: Options): Promise<number | null> {
  if (options?.signal?.aborted) throw new DOMException('Media duration probe aborted', 'AbortError');

  let input: URL;
  try {
    input = new URL(url);
  } catch {
    return null;
  }
  if (input.protocol !== 'https:' && input.protocol !== 'http:') return null;

  const remainingMs = options?.deadlineAtMs === undefined
    ? MAX_TIMEOUT_MS
    : options.deadlineAtMs - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, remainingMs));

  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-protocol_whitelist', 'http,https,tcp,tls',
      '-format_whitelist', 'mov',
      '-max_redirects', '0',
      '-show_entries', 'format=duration',
      '-of', 'json',
      url,
    ], {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      killSignal: 'SIGKILL',
      signal: options?.signal,
    }, (error, stdout) => {
      if (options?.signal?.aborted) {
        reject(new DOMException('Media duration probe aborted', 'AbortError'));
        return;
      }
      if (error) {
        resolve(null);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve(null);
        return;
      }
      const duration = parsed instanceof Object && 'format' in parsed
        ? (parsed as { format?: unknown }).format
        : null;
      const raw = duration instanceof Object && 'duration' in duration
        ? (duration as { duration?: unknown }).duration
        : null;
      if (typeof raw !== 'string') {
        resolve(null);
        return;
      }
      const seconds = Number(raw);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
  });
}
