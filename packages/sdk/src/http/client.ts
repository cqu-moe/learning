import { LearningError } from '../types/errors.js';
import type { Clock, Transport } from '../runtime/types.js';
import type { SessionCookieJar } from './cookies.js';
import {
  canceledError,
  forbiddenHostError,
  networkError,
  protocolError,
  rateLimitedError,
  timeoutError,
  uncertainError,
} from './errors.js';
import { computeBackoffMs, parseRetryAfterMs } from './retry.js';

export { SessionCookieJar } from './cookies.js';

const TOTAL_READ_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECT_HOPS = 10;
const STRIP_ON_CROSS_ORIGIN = new Set(['authorization', 'x-csrf-token', 'x-client-st', 'x-access-token']);

export function hostAllowed(host: string, allowHosts: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowHosts.some(
    (allowed) => normalized === allowed.toLowerCase() || normalized.endsWith(`.${allowed.toLowerCase()}`),
  );
}

export function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1' || bare === '0.0.0.0') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe80:/.test(bare)) return true;
  const ipv4 =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}

function stripIdentityHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!STRIP_ON_CROSS_ORIGIN.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

export interface HttpInput {
  kind: 'read' | 'write';
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  url: string;
  headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface SessionHttpOptions {
  transport: Transport;
  clock: Clock;
  jar: SessionCookieJar;
  allowHosts: string[];
}

/** Cookie-managing, allowlisted, manual-redirect HTTP client (SDK S03). */
export class SessionHttp {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly jar: SessionCookieJar;
  private readonly allowHosts: string[];

  constructor(options: SessionHttpOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.jar = options.jar;
    this.allowHosts = options.allowHosts;
  }

  async request(input: HttpInput): Promise<HttpResult> {
    let url = new URL(input.url);
    if (!hostAllowed(url.hostname, this.allowHosts)) {
      throw forbiddenHostError(url.hostname);
    }
    let headers = { ...input.headers };
    const deadline = this.clock.nowMs() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let attempts = 0;
    let hops = 0;

    for (;;) {
      if (input.signal?.aborted) throw canceledError();
      if (this.clock.nowMs() > deadline) throw timeoutError();
      attempts += 1;
      const requestHeaders = new Headers(headers);
      const cookieHeader = await this.jar.cookiesFor(url);
      if (cookieHeader !== '') requestHeaders.set('cookie', cookieHeader);
      const init: RequestInit = {
        method: input.method,
        headers: requestHeaders,
      };
      if (input.body !== undefined) init.body = input.body;
      if (input.signal !== undefined) init.signal = input.signal;
      const request = new Request(url, {
        ...init,
        redirect: 'manual',
      });

      let response: Response;
      try {
        response = await this.transport.fetch(request);
      } catch (error) {
        if (input.signal?.aborted) throw canceledError();
        if (error instanceof LearningError) throw error;
        if (input.kind === 'write') throw uncertainError();
        if (attempts >= TOTAL_READ_ATTEMPTS) throw networkError();
        await this.wait(computeBackoffMs(attempts, null), input.signal);
        continue;
      }

      const setCookies =
        (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      if (setCookies.length > 0) await this.jar.absorb(url, setCookies);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) return this.result(response, url);
        const next = new URL(location, url);
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          throw protocolError(`too many redirects (>${MAX_REDIRECT_HOPS})`);
        }
        if (!hostAllowed(next.hostname, this.allowHosts) || isPrivateHost(next.hostname)) {
          throw forbiddenHostError(next.hostname);
        }
        if (!sameOrigin(url, next)) headers = stripIdentityHeaders(headers);
        url = next;
        continue;
      }

      const retryHeader = response.headers.get('retry-after');
      const retryAfterMs = parseRetryAfterMs(retryHeader, this.clock.nowMs());
      const retriable = input.kind === 'read' && attempts < TOTAL_READ_ATTEMPTS;
      if (retriable && (response.status === 429 || response.status >= 500)) {
        await this.wait(computeBackoffMs(attempts, retryAfterMs), input.signal);
        continue;
      }
      if (response.status === 429) throw rateLimitedError(retryAfterMs);
      return this.result(response, url);
    }
  }

  private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.clock.sleep(ms, signal ?? new AbortController().signal);
    } catch (error) {
      if (signal?.aborted) throw canceledError();
      throw error;
    }
  }

  private result(response: Response, url: URL): HttpResult {
    return {
      status: response.status,
      url: url.toString(),
      headers: response.headers,
      json: () => response.json(),
      text: () => response.text(),
    };
  }
}

export function createSessionHttp(options: SessionHttpOptions): SessionHttp {
  return new SessionHttp(options);
}
