import { LearningError } from '../types/errors.js';
import type { Clock, Transport } from '../runtime/types.js';
import { reportError, safeEndpoint } from '../runtime/diagnostics.js';
import type { DiagnosticLog } from '../runtime/diagnostics.js';
import type { SessionCookieJar } from './cookies.js';
import {
  canceledError,
  forbiddenHostError,
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

function responseBytesOf(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
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
  bytes(maxBytes: number): Promise<Uint8Array>;
  stream(maxBytes: number): ReadableStream<Uint8Array>;
}

export interface SessionHttpOptions {
  transport: Transport;
  clock: Clock;
  jar: SessionCookieJar;
  allowHosts: string[];
  log?: DiagnosticLog;
}

/** Cookie-managing, allowlisted, manual-redirect HTTP client (SDK S03). */
export class SessionHttp {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly jar: SessionCookieJar;
  private readonly allowHosts: string[];
  private readonly log: DiagnosticLog | undefined;

  constructor(options: SessionHttpOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.jar = options.jar;
    this.allowHosts = options.allowHosts;
    this.log = options.log;
  }

  private report(
    stage: string,
    error: unknown,
    input: HttpInput,
    url: URL,
    attempt: number,
    fields: Record<string, string | number | boolean | null> = {},
  ): void {
    reportError(this.log, stage, error, {
      method: input.method,
      endpoint: safeEndpoint(url.toString()),
      attempt_id: attempt,
      ...fields,
    });
  }

  async request(input: HttpInput): Promise<HttpResult> {
    let url = new URL(input.url);
    if (!hostAllowed(url.hostname, this.allowHosts)) {
      const error = forbiddenHostError(url.hostname);
      this.report('http.request', error, input, url, 0, { code: error.data.code });
      throw error;
    }
    let headers = { ...input.headers };
    const deadline = this.clock.nowMs() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let attempts = 0;
    let hops = 0;

    for (;;) {
      if (input.signal?.aborted) throw canceledError();
      if (this.clock.nowMs() > deadline) {
        const error = timeoutError();
        this.report('http.deadline', error, input, url, attempts, { code: error.data.code });
        throw error;
      }
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
        if (error instanceof LearningError) {
          this.report(`http.transport.${input.kind}`, error, input, url, attempts, { code: error.data.code, recovered: false });
          throw error;
        }
        const willRetry = input.kind === 'read' && attempts < TOTAL_READ_ATTEMPTS;
        const failure = input.kind === 'write'
          ? uncertainError({ cause: error })
          : new LearningError({
              code: 'NETWORK',
              message: `network failure on attempt ${attempts}`,
              retryAfterMs: null,
              operationId: null,
            }, { cause: error });
        this.report(`http.transport.${input.kind}`, failure, input, url, attempts, {
          code: failure.data.code,
          recovered: willRetry,
        });
        if (!willRetry) throw failure;
        await this.wait(computeBackoffMs(attempts, null), input.signal);
        continue;
      }

      const setCookies =
        (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      if (setCookies.length > 0) await this.jar.absorb(url, setCookies);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) return this.result(response, url, input);
        const next = new URL(location, url);
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          const error = protocolError(`too many redirects (>${MAX_REDIRECT_HOPS})`);
          this.report('http.redirect', error, input, next, attempts, { code: error.data.code });
          throw error;
        }
        if (!hostAllowed(next.hostname, this.allowHosts) || isPrivateHost(next.hostname)) {
          const error = forbiddenHostError(next.hostname);
          this.report('http.redirect', error, input, next, attempts, { code: error.data.code });
          throw error;
        }
        if (!sameOrigin(url, next)) headers = stripIdentityHeaders(headers);
        url = next;
        continue;
      }

      const retryHeader = response.headers.get('retry-after');
      const retryAfterMs = parseRetryAfterMs(retryHeader, this.clock.nowMs());
      const retriable = input.kind === 'read' && attempts < TOTAL_READ_ATTEMPTS;
      if (retriable && (response.status === 429 || response.status >= 500)) {
        const failure = response.status === 429
          ? rateLimitedError(retryAfterMs)
          : new LearningError({ code: 'PROTOCOL', message: `server error ${response.status} on attempt ${attempts}`, retryAfterMs: null, operationId: null });
        this.report('http.response', failure, input, url, attempts, { status: response.status, code: failure.data.code, recovered: true });
        await this.wait(computeBackoffMs(attempts, retryAfterMs), input.signal);
        continue;
      }
      if (response.status === 429) {
        const failure = rateLimitedError(retryAfterMs);
        this.report('http.response', failure, input, url, attempts, { status: response.status, code: failure.data.code, recovered: false });
        throw failure;
      }
      if (response.status >= 500) {
        const failure = new LearningError({
          code: 'PROTOCOL',
          message: `server error ${response.status} on attempt ${attempts}`,
          retryAfterMs: null,
          operationId: null,
        });
        this.report('http.response', failure, input, url, attempts, { status: response.status, code: failure.data.code, recovered: false });
        throw failure;
      }
      const expectedStatusProbe =
        input.headers?.range !== undefined && response.status === 416 ||
        response.status === 404 && url.pathname === '/api/v3/user/login/app-web-login' ||
        (response.status === 401 || response.status === 403) && url.pathname === '/api/v1/lms/user/user-courses/';
      if ((response.status < 200 || response.status >= 300) && !expectedStatusProbe) {
        const failure = protocolError(`endpoint returned HTTP ${response.status}`);
        this.report('http.response.status', failure, input, url, attempts, {
          status: response.status,
          code: failure.data.code,
          recovered: false,
        });
      }
      return this.result(response, url, input);
    }
  }

  private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.clock.sleep(ms, signal ?? new AbortController().signal);
    } catch (error) {
      if (signal?.aborted) throw canceledError();
      reportError(this.log, 'http.backoff', error, { code: error instanceof LearningError ? error.data.code : null });
      throw error;
    }
  }

  private result(response: Response, url: URL, input: HttpInput): HttpResult {
    const reportBody = (stage: string, error: unknown, fields: Record<string, string | number | boolean | null> = {}): void => {
      reportError(this.log, stage, error, {
        method: input.method,
        endpoint: safeEndpoint(url.toString()),
        status: response.status,
        content_type: response.headers.get('content-type'),
        response_bytes: responseBytesOf(response),
        ...fields,
      });
    };
    return {
      status: response.status,
      url: url.toString(),
      headers: response.headers,
      json: async () => {
        try { return await response.json(); }
        catch (error) { reportBody('http.body.json', error); throw error; }
      },
      text: async () => {
        try { return await response.text(); }
        catch (error) { reportBody('http.body.text', error); throw error; }
      },
      bytes: async (maxBytes) => {
        const declared = Number(response.headers.get('content-length'));
        const invalidLimit = new LearningError({ code: 'INVALID_INPUT', message: 'invalid binary size limit', retryAfterMs: null, operationId: null });
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) { reportBody('http.body.bytes', invalidLimit, { code: invalidLimit.data.code }); throw invalidLimit; }
        if (Number.isFinite(declared) && declared > maxBytes) {
          const overBudget = new LearningError({ code: 'BUDGET', message: 'binary response exceeds size limit', retryAfterMs: null, operationId: null });
          reportBody('http.body.bytes', overBudget, { code: overBudget.data.code });
          throw overBudget;
        }
        if (response.body === null) return new Uint8Array();
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              const overBudget = new LearningError({ code: 'BUDGET', message: 'binary response exceeds size limit', retryAfterMs: null, operationId: null });
              reportBody('http.body.bytes', overBudget, { code: overBudget.data.code, response_bytes: total });
              throw overBudget;
            }
            chunks.push(value);
          }
        } catch (error) {
          if (!(error instanceof LearningError && error.data.code === 'BUDGET')) reportBody('http.body.bytes', error, { response_bytes: total });
          throw error;
        } finally { await reader.cancel().catch(() => {}); }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
        return out;
      },
      stream: (maxBytes) => {
        const invalidLimit = new LearningError({ code: 'INVALID_INPUT', message: 'invalid binary size limit', retryAfterMs: null, operationId: null });
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) { reportBody('http.body.stream', invalidLimit, { code: invalidLimit.data.code }); throw invalidLimit; }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          const overBudget = new LearningError({ code: 'BUDGET', message: 'binary response exceeds size limit', retryAfterMs: null, operationId: null });
          reportBody('http.body.stream', overBudget, { code: overBudget.data.code });
          throw overBudget;
        }
        let total = 0;
        const source = response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
        return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            total += chunk.byteLength;
            if (total > maxBytes) {
              const overBudget = new LearningError({ code: 'BUDGET', message: 'binary response exceeds size limit', retryAfterMs: null, operationId: null });
              reportBody('http.body.stream', overBudget, { code: overBudget.data.code, response_bytes: total });
              throw overBudget;
            }
            controller.enqueue(chunk);
          },
        }));
      },
    };
  }
}

export function createSessionHttp(options: SessionHttpOptions): SessionHttp {
  return new SessionHttp(options);
}
