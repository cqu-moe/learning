/** Read retry math (S03): 3 total attempts, 500ms start, 10s cap, Retry-After honored. */
export function computeBackoffMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(retryAfterMs, 10_000);
  const exponential = 500 * 2 ** (attempt - 1);
  return Math.min(exponential, 10_000);
}

/** Parses Retry-After as delay-seconds or HTTP-date relative to nowMs; null when unusable. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const delta = parsed - nowMs;
  return delta > 0 ? delta : null;
}
