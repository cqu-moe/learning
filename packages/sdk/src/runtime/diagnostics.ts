import { LearningError } from '../types/errors.js';

export type DiagnosticLog = (event: {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  error?: unknown;
  fields: Record<string, string | number | boolean | null>;
}) => void;

export function reportError(
  log: DiagnosticLog | undefined,
  stage: string,
  error: unknown,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  try {
    log?.({ level: 'error', message: 'Learning SDK operation failed', error, fields: { stage, ...fields } });
  } catch {
    // Diagnostics must never change business behavior.
  }
}

export function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-endpoint';
  }
}

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof LearningError && error.data.code === 'CANCELED') return true;
  if (signal?.aborted !== true) return false;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
