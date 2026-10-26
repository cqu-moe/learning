import { LearningError } from '../types/errors.js';
import type { ErrorData } from '../types/errors.js';

export function httpError(data: Omit<ErrorData, 'retryAfterMs'> & { retryAfterMs?: number | null }, options?: ErrorOptions): LearningError {
  return new LearningError({
    retryAfterMs: null,
    ...data,
  }, options);
}

export function canceledError(): LearningError {
  return httpError({ code: 'CANCELED', message: 'request canceled', operationId: null });
}

export function timeoutError(): LearningError {
  return httpError({ code: 'TIMEOUT', message: 'request deadline exceeded', operationId: null });
}

export function networkError(options?: ErrorOptions): LearningError {
  return httpError({ code: 'NETWORK', message: 'network failure', operationId: null }, options);
}

export function uncertainError(options?: ErrorOptions): LearningError {
  return httpError({ code: 'UNCERTAIN', message: 'request may have been sent; outcome unknown', operationId: null }, options);
}

export function rateLimitedError(retryAfterMs: number | null, options?: ErrorOptions): LearningError {
  return httpError({ code: 'RATE_LIMITED', message: 'rate limited', operationId: null, retryAfterMs }, options);
}

export function forbiddenHostError(host: string): LearningError {
  return httpError({ code: 'FORBIDDEN', message: `host not allowed: ${host}`, operationId: null });
}

export function protocolError(message: string, options?: ErrorOptions): LearningError {
  return httpError({ code: 'PROTOCOL', message, operationId: null }, options);
}
