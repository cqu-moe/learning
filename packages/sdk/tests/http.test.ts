import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSessionHttp, SessionCookieJar, hostAllowed, isPrivateHost } from '../src/http/client.js';
import { computeBackoffMs, parseRetryAfterMs } from '../src/http/retry.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Fixture } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';

const testsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const allowHosts = ['yuketang.cn', 'xuetangx.com'];

function makeHttp(transport: FakeTransport, jar = new SessionCookieJar()) {
  return createSessionHttp({
    transport,
    clock: new FakeClock(),
    jar,
    allowHosts,
  });
}

describe('retry policy (S03)', () => {
  it('caps at 10s, starts at 500ms', () => {
    expect(computeBackoffMs(1, null)).toBe(500);
    expect(computeBackoffMs(2, null)).toBe(1000);
    expect(computeBackoffMs(10, null)).toBe(10_000);
  });

  it('parses Retry-After seconds and HTTP-date (A042 base)', () => {
    expect(parseRetryAfterMs('2', 1000)).toBe(2000);
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBeNull(); // date in past → no wait
    expect(parseRetryAfterMs('not-a-date', 0)).toBeNull();
    const future = new Date(Date.UTC(2030, 0, 1)).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBeGreaterThan(0);
  });
});

describe('host checks', () => {
  it('allowlist uses dot boundaries, blocking lookalike suffixes (A041)', () => {
    expect(hostAllowed('changjie.yuketang.cn', allowHosts)).toBe(true);
    expect(hostAllowed('yuketang.cn', allowHosts)).toBe(true);
    expect(hostAllowed('evilyuketang.cn', allowHosts)).toBe(false);
    expect(hostAllowed('yuketang.cn.evil.com', allowHosts)).toBe(false);
  });

  it('blocks private network redirect targets (A041)', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.2', '172.16.0.9', '169.254.1.1', 'localhost', '[::1]', '::1']) {
      expect(isPrivateHost(host)).toBe(true);
    }
    expect(isPrivateHost('yuketang.cn')).toBe(false);
  });
});

describe('cookie jar semantics (A041)', () => {
  it('keeps same-name cookies of different domains and paths', async () => {
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.yuketang.cn/a'), [
      'sessionid=domain-scope; Domain=yuketang.cn; Path=/',
    ]);
    await jar.absorb(new URL('https://changjie.yuketang.cn/b'), [
      'sessionid=host-only; Path=/b',
    ]);
    expect(await jar.cookiesFor(new URL('https://www.yuketang.cn/a'))).toContain('domain-scope');
    expect(await jar.cookiesFor(new URL('https://changjie.yuketang.cn/b'))).toContain('host-only');
    expect(await jar.cookiesFor(new URL('https://changjie.yuketang.cn/b'))).toContain('domain-scope');
    expect(await jar.cookiesFor(new URL('https://www.yuketang.cn/b'))).not.toContain('host-only');
  });

  it('parses Expires containing commas and multiple Set-Cookie headers', async () => {
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.xuetangx.com/'), [
      'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/',
      'b=2; Path=/',
    ]);
    const header = await jar.cookiesFor(new URL('https://www.xuetangx.com/'));
    expect(header).toContain('a=1');
    expect(header).toContain('b=2');
  });
});

describe('session http client', () => {
  it('sends each hop with redirect: manual and absorbs cookies (S03)', async () => {
    const transport = new FakeTransport();
    transport.script([
      { status: 302, headers: { location: 'https://www.yuketang.cn/next', 'set-cookie': ['hop=1; Path=/'] } },
      { status: 200, headers: {}, body: '{"ok":true}' },
    ]);
    const http = makeHttp(transport);
    const result = await http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/start' });
    expect(result.status).toBe(200);
    expect(transport.requests).toHaveLength(2);
    for (const request of transport.requests) {
      expect(request.redirect).toBe('manual');
    }
    expect(transport.requests[1]?.headers.get('cookie')).toContain('hop=1');
  });

  it('strips Authorization and CSRF headers on cross-origin redirects', async () => {
    const transport = new FakeTransport();
    transport.script([
      { status: 302, headers: { location: 'https://mooc.yuketang.cn/cross' } },
      { status: 200, headers: {}, body: '{}' },
    ]);
    const http = makeHttp(transport);
    await http.request({
      kind: 'read',
      method: 'GET',
      url: 'https://www.yuketang.cn/start',
      headers: { authorization: 'Bearer x', 'x-csrf-token': 't', 'xtbz': 'ykt' },
    });
    const second = transport.requests[1];
    expect(second?.headers.get('authorization')).toBeNull();
    expect(second?.headers.get('x-csrf-token')).toBeNull();
    expect(second?.headers.get('xtbz')).toBe('ykt');
  });

  it('rejects redirects to non-allowlisted or private hosts', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 302, headers: { location: 'https://evilyuketang.cn/steal' } }]);
    const http = makeHttp(transport);
    await expect(
      http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/start' }),
    ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });

    const transport2 = new FakeTransport();
    transport2.script([{ status: 302, headers: { location: 'http://127.0.0.1/metadata' } }]);
    const http2 = makeHttp(transport2);
    await expect(
      http2.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/start' }),
    ).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  });

  it('retries reads up to 3 total attempts honoring backoff', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport();
    transport.script([
      { status: 500, headers: {} },
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 200, headers: {}, body: '{"page":1}' },
    ]);
    const http = createSessionHttp({ transport, clock, jar: new SessionCookieJar(), allowHosts });
    const result = await http.request({ kind: 'read', method: 'GET', url: 'https://www.xuetangx.com/courses' });
    expect(result.status).toBe(200);
    expect(transport.requests).toHaveLength(3);
    expect(clock.waits).toEqual([500, 1000]);
  });

  it('write loss requests exactly once and reports UNCERTAIN (A042)', async () => {
    const transport = new FakeTransport();
    transport.failNext(new Error('connection reset'));
    const http = makeHttp(transport);
    await expect(
      http.request({ kind: 'write', method: 'POST', url: 'https://www.yuketang.cn/api/save', body: '{"a":1}' }),
    ).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('reports each transport failure before retry-safe conversion without URL secrets', async () => {
    const transport = new FakeTransport();
    const cause = new Error('connection reset');
    transport.failNext(cause);
    const events: Array<Parameters<Runtime['log']>[0]> = [];
    const http = createSessionHttp({
      transport,
      clock: new FakeClock(),
      jar: new SessionCookieJar(),
      allowHosts,
      log: event => events.push(event),
    });

    const error = await http.request({
      kind: 'write',
      method: 'POST',
      url: 'https://www.yuketang.cn/api/save?ticket=SECRET',
      body: '{"answer":"SECRET"}',
    }).catch((caught: unknown) => caught as Error);

    expect(error).toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect((error as Error).cause).toBe(cause);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      message: 'Learning SDK operation failed',
      error,
      fields: {
        stage: 'http.transport.write',
        method: 'POST',
        endpoint: 'https://www.yuketang.cn/api/save',
        attempt_id: 1,
        code: 'UNCERTAIN',
        recovered: false,
      },
    });
    expect((events[0]?.error as Error).cause).toBe(cause);
    expect(JSON.stringify(events[0]?.fields)).not.toContain('SECRET');
  });

  it('treats caller cancellation as a normal branch, not a diagnostics error', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new FakeTransport();
    const events: Array<Parameters<Runtime['log']>[0]> = [];
    const http = createSessionHttp({
      transport,
      clock: new FakeClock(),
      jar: new SessionCookieJar(),
      allowHosts,
      log: event => events.push(event),
    });

    await expect(http.request({
      kind: 'read',
      method: 'GET',
      url: 'https://www.yuketang.cn/api/read',
      signal: controller.signal,
    })).rejects.toMatchObject({ data: { code: 'CANCELED' } });
    expect(transport.requests).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('read abort terminates immediately with CANCELED (A042)', async () => {
    const controller = new AbortController();
    const transport = new FakeTransport();
    transport.script([
      { status: 500, headers: {} },
      { status: 200, headers: {}, body: '{}' },
    ]);
    const clock = new FakeClock();
    clock.onSleep(() => controller.abort());
    const http = createSessionHttp({ transport, clock, jar: new SessionCookieJar(), allowHosts });
    await expect(
      http.request({
        kind: 'read',
        method: 'GET',
        url: 'https://www.xuetangx.com/x',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ data: { code: 'CANCELED' } });
    expect(transport.requests).toHaveLength(1);
  });

  it('keeps HTTP 200 error bodies intact for provider envelope checks (A042)', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: '{"success":false,"msg":"not logged in"}' }]);
    const http = makeHttp(transport);
    const result = await http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/courses' });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ success: false, msg: 'not logged in' });
  });

  it('reads binary assets with a strict size ceiling', async () => {
    const transport = {
      fetch: async () => new Response(new Uint8Array([1, 2, 3, 4])),
      connect: async () => { throw Error('unused'); },
    };
    const http = createSessionHttp({ transport, clock: new FakeClock(), jar: new SessionCookieJar(), allowHosts });
    const body = await http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/slide.png' });
    expect(await body.bytes(4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    const oversized = await http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/slide.png' });
    await expect(oversized.bytes(3)).rejects.toMatchObject({ data: { code: 'BUDGET' } });
  });

  it('streams binary responses without buffering past the budget', async () => {
    const transport = { fetch: async () => new Response(new Uint8Array([1, 2, 3, 4])), connect: async () => { throw Error('unused'); } };
    const http = createSessionHttp({ transport, clock: new FakeClock(), jar: new SessionCookieJar(), allowHosts });
    const response = await http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/video.mp4' });
    const reader = response.stream(4).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await reader.read()).done).toBe(true);
    const oversized = await http.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/video.mp4' });
    const limited = oversized.stream(3).getReader();
    await expect(limited.read()).rejects.toMatchObject({ data: { code: 'BUDGET' } });
  });
});

describe('replay tool', () => {
  it('validates every registered request in order and fails on extras', async () => {
    const fixture: Fixture = JSON.parse(
      readFileSync(resolve(testsDir, 'fixtures/http/simple-read.json'), 'utf8'),
    );
    expect(fixture.synthetic).toBe(true);
    const transport = new FakeTransport();
    transport.script(fixture.interactions.map((x) => x.response));
    const http = makeHttp(transport);
    const body = await http.request({
      kind: 'read',
      method: fixture.interactions[0]!.request.method,
      url: `https://${fixture.interactions[0]!.request.host}${fixture.interactions[0]!.request.path}`,
    });
    expect(await body.json()).toEqual(fixture.expected);
    expect(() => transport.assertNoExtraScripts()).not.toThrow();
    const extra = new FakeTransport();
    extra.script(fixture.interactions.map((x) => x.response));
    const httpExtra = makeHttp(extra);
    await httpExtra.request({ kind: 'read', method: 'GET', url: 'https://www.yuketang.cn/unregistered' });
    expect(extra.requests).toHaveLength(1);
  });
});
