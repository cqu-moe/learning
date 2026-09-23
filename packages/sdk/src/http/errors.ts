import { LearningError } from '../types/errors.js';
import type { ErrorData } from '../types/errors.js';

export function httpError(data: Omit<ErrorData, 'retryAfterMs'> & { retryAfterMs?: number | null }): LearningError {
  return new LearningError({
    retryAfterMs: null,
    ...data,
  });
}

export function canceledError(): LearningError {
  return httpError({ code: 'CANCELED', message: 'request canceled', operationId: null });
}

export function timeoutError(): LearningError {
  return httpError({ code: 'TIMEOUT', message: 'request deadline exceeded', operationId: null });
}

export function networkError(): LearningError {
  return httpError({ code: 'NETWORK', message: 'network failure', operationId: null });
}

export function uncertainError(): LearningError {
  return httpError({ code: 'UNCERTAIN', message: 'request may have been sent; outcome unknown', operationId: null });
}

export function rateLimitedError(retryAfterMs: number | null): LearningError {
  return httpError({ code: 'RATE_LIMITED', message: 'rate limited', operationId: null, retryAfterMs });
}

export function forbiddenHostError(host: string): LearningError {
  return httpError({ code: 'FORBIDDEN', message: `host not allowed: ${host}`, operationId: null });
}

export function protocolError(message: string): LearningError {
  return httpError({ code: 'PROTOCOL', message, operationId: null });
}
