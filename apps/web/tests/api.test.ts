import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { SqliteStateStore } from '@learning/sdk/node';
import { JobSchema } from '@learning/sdk/public';
import { createWebServer } from '../server/app.js';
import {
  ApiErrorSchema,
  CoursePageSchema,
  DashboardSchema,
  LoginStateSchema,
  OutlineResultSchema,
  ProfileSchema,
  type LoginState,
} from '../shared/contracts.js';
import { FakeTransport, loadFixture } from '../../../packages/sdk/tests/helpers/replay.ts';
import type { Runtime } from '@learning/sdk/node';

const tempDirs: string[] = [];
type TestServer = { server: Server; port: number };
const servers: TestServer[] = [];
type Transport = Runtime['transport'];

class OfflineLoginTransport implements Transport {
  readonly requests: Request[] = [];

  constructor(private readonly mode: 'hang' | 'fail' | 'bad-qr' | 'unknown-qr', private readonly fake = new FakeTransport()) {
    if (mode !== 'fail') {
      const interaction = structuredClone(loadFixture('ykt/qr-login').interactions[0]!);
      if ((mode === 'bad-qr' || mode === 'unknown-qr') && interaction.response.body !== undefined) {
        const body = interaction.response.body as { data: { qrContent: string } } | null;
        if (body === null) throw new Error('fixture QR body is missing');
        body.data.qrContent = mode === 'bad-qr' ? 'https://example.com/invalid-qr' : 'not a url';
        interaction.response.body = body;
      }
      this.fake.scriptInteractions([interaction]);
    } else this.fake.failNext(new Error('offline login failure'));
  }

  async fetch(input: Request): Promise<Response> {
    this.requests.push(input);
    if (this.mode === 'fail') return this.fake.fetch(input);
    if (this.mode !== 'hang' || this.requests.length === 1) return this.fake.fetch(input);
    return new Promise<Response>(() => {});
  }

  async connect(): Promise<never> {
    throw new Error('OfflineLoginTransport does not connect');
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'learning-web-'));
  tempDirs.push(dir);
  return dir;
}

async function start(options: { dataDir: string; transport?: Transport; staticDir?: string }): Promise<TestServer> {
  const server = createWebServer(options);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  servers.push({ server, port: address.port });
  return { server, port: address.port };
}

afterAll(async () => {
  await Promise.all(servers.map(async ({ server }) => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    }));
  }));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function call(port: number, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
  const headers = { ...init.headers };
  let body = '';
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    headers['content-length'] = Buffer.byteLength(body).toString();
  }
  return new Promise((resolveCall, rejectCall) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolveCall({
        status: response.statusCode ?? 0,
        body: text === '' ? null : String(response.headers['content-type'] ?? '').includes('application/json') ? JSON.parse(text) : text,
      }));
    });
    req.on('error', rejectCall);
    if (body !== '') req.write(body);
    req.end();
  });
}

function localHeaders(port: number): Record<string, string> {
  return { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
}

async function waitFor<T>(probe: () => T | Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await probe();
    if (check(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  const value = await probe();
  throw new Error(`condition was not met: ${JSON.stringify(value)}`);
}

async function addProfile(port: number, name: string, platform: 'ykt' | 'xuetang' | 'zhs' = 'ykt') {
  const response = await call(port, '/api/profiles', { method: 'POST', body: { name, platform }, headers: localHeaders(port) });
  expect(response.status).toBe(200);
  return ProfileSchema.parse(response.body);
}

describe('local web API', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = tempDir();
  });

  it('creates and rejects duplicate profiles through real HTTP and SQLite', async () => {
    const { port } = await start({ dataDir });
    const profile = await addProfile(port, 'main', 'ykt');
    expect(profile.scope.platform).toBe('ykt');
    expect(profile.hasSession).toBe(false);
    const duplicate = await call(port, '/api/profiles', { method: 'POST', body: { name: 'main', platform: 'ykt' }, headers: localHeaders(port) });
    expect(duplicate.status).toBe(409);
    ApiErrorSchema.parse(duplicate.body);
  });

  it('uses a strict SDK transport fixture and keeps course cache profile-scoped', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions(loadFixture('ykt/courses-list').interactions);
    const { port, server } = await start({ dataDir, transport });
    const first = await addProfile(port, 'first', 'ykt');
    const second = await addProfile(port, 'second', 'ykt');
    const page = await call(port, `/api/profiles/${first.scope.profileId}/courses`, { headers: localHeaders(port) });
    expect(page.status).toBe(200);
    CoursePageSchema.parse(page.body);
    expect(transport.requests).toHaveLength(1);
    transport.assertNoExtraScripts();

    const dashboard = DashboardSchema.parse((await call(port, '/api/dashboard', { headers: localHeaders(port) })).body);
    expect(dashboard.profiles).toHaveLength(2);
    expect(dashboard.courses.map(course => course.ref.scope.profileId)).toEqual([first.scope.profileId, first.scope.profileId]);
    expect(second.scope.profileId).not.toBe(first.scope.profileId);
    expect(server.listening).toBe(true);
  });

  it('loads an outline from the course cache with a strict fixture', async () => {
    const transport = new FakeTransport();
    const courses = loadFixture('ykt/courses-list');
    const outline = loadFixture('ykt/nested-outline');
    transport.scriptInteractions([...courses.interactions, ...outline.interactions]);
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'outline', 'ykt');
    const page = CoursePageSchema.parse((await call(port, `/api/profiles/${profile.scope.profileId}/courses`, { headers: localHeaders(port) })).body);
    transport.scriptInteractions(outline.interactions);
    const response = await call(port, `/api/courses/${page.items[0]!.ref.key}/outline`, { headers: localHeaders(port) });
    expect(response.status).toBe(200);
    OutlineResultSchema.parse(response.body);
    transport.assertNoExtraScripts();
  });

  it('finishes an in-flight course request before repeated server shutdown closes SQLite', async () => {
    const fake = new FakeTransport();
    fake.scriptInteractions(loadFixture('ykt/courses-list').interactions);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolveGate => { enter = resolveGate; });
    const released = new Promise<void>(resolveGate => { release = resolveGate; });
    const transport: Transport = {
      fetch: async input => { enter(); await released; return fake.fetch(input); },
      connect: () => { throw new Error('unexpected socket'); },
    };
    const { port, server } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'shutdown', 'ykt');
    const pending = call(port, `/api/profiles/${profile.scope.profileId}/courses`, { headers: localHeaders(port) });
    await entered;
    const close = () => new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
    const first = close();
    const second = close();
    release();
    const response = await pending;
    await Promise.all([first, second]);
    expect(response.status).toBe(200);
    CoursePageSchema.parse(response.body);
    expect(existsSync(join(dataDir, 'learning.lock'))).toBe(false);
    fake.assertNoExtraScripts();
  });

  it('cancels a queued login before it starts any platform authentication request', async () => {
    const fake = new FakeTransport();
    fake.scriptInteractions(loadFixture('ykt/courses-list').interactions);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolveGate => { enter = resolveGate; });
    const released = new Promise<void>(resolveGate => { release = resolveGate; });
    const transport: Transport = {
      fetch: async input => { enter(); await released; return fake.fetch(input); },
      connect: () => { throw new Error('unexpected socket'); },
    };
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'queued-login', 'ykt');
    const pending = call(port, `/api/profiles/${profile.scope.profileId}/courses`, { headers: localHeaders(port) });
    await entered;
    const created = await call(port, `/api/profiles/${profile.scope.profileId}/login`, { method: 'POST', body: {}, headers: localHeaders(port) });
    const id = (created.body as { id: string }).id;
    const canceled = await call(port, `/api/logins/${id}`, { method: 'DELETE', body: {}, headers: localHeaders(port) });
    release();
    expect(canceled.status).toBe(200);
    expect((await pending).status).toBe(200);
    const final = await waitFor(() => call(port, `/api/logins/${id}`, { headers: localHeaders(port) }), response => LoginStateSchema.parse(response.body).status !== 'waiting');
    expect(LoginStateSchema.parse(final.body).status).toBe('canceled');
    expect(fake.requests).toHaveLength(1);
    expect(existsSync(join(dataDir, 'learning.lock'))).toBe(false);
  });

  it('returns SDK-validated jobs and rejects malformed cache instead of hiding it as empty', async () => {
    const { port } = await start({ dataDir });
    const profile = await addProfile(port, 'a-jobs', 'ykt');
    const second = await addProfile(port, 'b-jobs', 'ykt');
    const state = new SqliteStateStore(resolve(dataDir, 'state.db'));
    const job = {
      id: 'job-test', scope: profile.scope, kind: 'export', status: 'queued',
      createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: 1, completed: 0, total: 1, items: [], warnings: [],
    };
    expect(await state.commit({ expected: [{ key: 'job:job-test', revision: null }], changes: [{ key: 'job:job-test', value: job }] })).toBe(true);
    expect(await state.commit({
      expected: [{ key: 'job:job-second', revision: null }],
      changes: [{ key: 'job:job-second', value: { ...job, id: 'job-second', scope: second.scope, status: 'uncertain' } }],
    })).toBe(true);
    state.close();
    const dashboard = DashboardSchema.parse((await call(port, '/api/dashboard', { headers: localHeaders(port) })).body);
    expect(dashboard.jobs).toHaveLength(2);
    expect(JobSchema.parse((await call(port, '/api/jobs/job-second', { headers: localHeaders(port) })).body).id).toBe('job-second');
    const uncertain = await call(port, '/api/jobs/job-second/control', { method: 'POST', body: { action: 'cancel' }, headers: localHeaders(port) });
    expect(uncertain.status).toBe(409);
    ApiErrorSchema.parse(uncertain.body);
    expect(JobSchema.parse(dashboard.jobs[0]).id).toBe('job-test');

    const state2 = new SqliteStateStore(resolve(dataDir, 'state.db'));
    const stored = await state2.get('job:job-test');
    await state2.commit({ expected: [{ key: 'job:job-test', revision: stored!.revision }], changes: [{ key: 'job:job-test', value: { ...job, status: 'not-a-job-status' } }] });
    state2.close();
    const failed = await call(port, '/api/dashboard', { headers: localHeaders(port) });
    expect(failed.status).toBe(500);
    ApiErrorSchema.parse(failed.body);
  });

  it('rejects bad Host, cross-origin requests, unknown fields, and unknown routes', async () => {
    const { port } = await start({ dataDir });
    await addProfile(port, 'security');
    const host = await call(port, '/api/dashboard', { headers: { host: 'evil.test' } });
    expect(host.status).toBe(403);
    const origin = await call(port, '/api/dashboard', { headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.test' } });
    expect(origin.status).toBe(403);
    const crossSite = await call(port, '/api/dashboard', { headers: { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    const field = await call(port, '/api/profiles', { method: 'POST', body: { name: 'x', platform: 'ykt', extra: 1 }, headers: localHeaders(port) });
    expect(field.status).toBe(422);
    const route = await call(port, '/api/not-here', { headers: localHeaders(port) });
    expect(route.status).toBe(404);
    ApiErrorSchema.parse(route.body);
  });

  it('accepts only loopback explicitly configured origins', () => {
    expect(() => createWebServer({ dataDir, allowedOrigins: ['https://evil.test'] })).toThrow(/回环/);
  });

  it('refuses to recreate a missing master key beside an old database', async () => {
    const initialized = tempDir();
    const server = createWebServer({ dataDir: initialized });
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    }));
    unlinkSync(join(initialized, 'master.key'));
    expect(() => createWebServer({ dataDir: initialized })).toThrow(/密钥/);
  });

  it('honors an active CLI-compatible writer lock', async () => {
    const { port } = await start({ dataDir });
    const profile = await addProfile(port, 'locked-job', 'ykt');
    const state = new SqliteStateStore(resolve(dataDir, 'state.db'));
    const job = {
      id: 'locked-job', scope: profile.scope, kind: 'export', status: 'queued',
      createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: 1, completed: 0, total: 1, items: [], warnings: [],
    };
    expect(await state.commit({ expected: [{ key: 'job:locked-job', revision: null }], changes: [{ key: 'job:locked-job', value: job }] })).toBe(true);
    state.close();
    const lockPath = join(dataDir, 'learning.lock');
    writeFileSync(lockPath, `${process.pid}\nweb-test-lock`, { mode: 0o600 });
    try {
      const blocked = await call(port, '/api/profiles', { method: 'POST', body: { name: 'blocked', platform: 'ykt' }, headers: localHeaders(port) });
      expect(blocked.status).toBe(409);
      ApiErrorSchema.parse(blocked.body);
      const control = await call(port, '/api/jobs/locked-job/control', { method: 'POST', body: { action: 'cancel' }, headers: localHeaders(port) });
      expect(control.status).toBe(409);
      expect(String((control.body as { error?: { message?: string } }).error?.message)).toContain('另一个写入进程');
    } finally {
      unlinkSync(lockPath);
    }
  });

  it('starts logins only for existing profiles without creating a lock', async () => {
    const { port } = await start({ dataDir });
    const response = await call(port, '/api/profiles/missing/login', { method: 'POST', body: {}, headers: localHeaders(port) });
    expect(response.status).toBe(404);
    ApiErrorSchema.parse(response.body);
    expect(existsSync(join(dataDir, 'learning.lock'))).toBe(false);
  });

  it('cancels an offline login and releases the writer lock', async () => {
    const transport = new OfflineLoginTransport('hang');
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'cancel-login', 'ykt');
    const created = await call(port, `/api/profiles/${profile.scope.profileId}/login`, { method: 'POST', body: {}, headers: localHeaders(port) });
    expect(created.status).toBe(200);
    const id = (created.body as { id: string }).id;
    const before = await waitFor(
      () => call(port, `/api/logins/${id}`, { headers: localHeaders(port) }),
      result => LoginStateSchema.parse(result.body).qr !== null,
    );
    expect(LoginStateSchema.parse(before.body).status).toBe('waiting');
    expect(existsSync(join(dataDir, 'learning.lock'))).toBe(true);
    const canceled = await call(port, `/api/logins/${id}`, { method: 'DELETE', body: {}, headers: localHeaders(port) });
    expect(canceled.status).toBe(200);
    const after = LoginStateSchema.parse((await call(port, `/api/logins/${id}`, { headers: localHeaders(port) })).body);
    expect(after.status).toBe('canceled');
    expect(after.qr).toBeNull();
    await waitFor(() => existsSync(join(dataDir, 'learning.lock')), value => !value);
  });

  it('marks failed offline logins terminal and releases the lock', async () => {
    const transport = new OfflineLoginTransport('fail');
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'failed-login', 'ykt');
    const created = await call(port, `/api/profiles/${profile.scope.profileId}/login`, { method: 'POST', body: {}, headers: localHeaders(port) });
    const id = (created.body as { id: string }).id;
    const state = await waitFor(
      () => call(port, `/api/logins/${id}`, { headers: localHeaders(port) }),
      result => LoginStateSchema.parse(result.body).status === 'failed',
    );
    expect(LoginStateSchema.parse(state.body).message).toBe('暂时无法连接平台。');
    await waitFor(() => existsSync(join(dataDir, 'learning.lock')), value => !value);
  });

  it('rejects an untrusted QR source and releases the lock', async () => {
    const transport = new OfflineLoginTransport('bad-qr');
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'bad-qr', 'ykt');
    const created = await call(port, `/api/profiles/${profile.scope.profileId}/login`, { method: 'POST', body: {}, headers: localHeaders(port) });
    const id = (created.body as { id: string }).id;
    const state = await waitFor(
      () => call(port, `/api/logins/${id}`, { headers: localHeaders(port) }),
      result => LoginStateSchema.parse(result.body).status === 'failed',
    );
    const parsed = LoginStateSchema.parse(state.body);
    expect(parsed.message).toContain('不受信任');
    expect(parsed.qr).toBeNull();
    await waitFor(() => existsSync(join(dataDir, 'learning.lock')), value => !value);
  });

  it('keeps an expired QR timestamp for the UI and can cancel offline', async () => {
    const transport = new OfflineLoginTransport('hang');
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'expired-qr', 'ykt');
    const originalNow = Date.now;
    let created: { status: number; body: unknown };
    let parsed: LoginState | undefined;
    Date.now = () => 1;
    try {
      created = await call(port, `/api/profiles/${profile.scope.profileId}/login`, { method: 'POST', body: {}, headers: localHeaders(port) });
      expect(created.status).toBe(200);
      const id = (created.body as { id: string }).id;
      const state = await waitFor(
        () => call(port, `/api/logins/${id}`, { headers: localHeaders(port) }),
        result => LoginStateSchema.parse(result.body).qr !== null,
      );
      parsed = LoginStateSchema.parse(state.body);
    } finally {
      Date.now = originalNow;
    }
    expect(parsed?.qr?.expiresAtMs).toBeLessThan(Date.now());
    expect(parsed?.qr?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(parsed?.qr?.url).toBeNull();
    const canceled = await call(port, `/api/logins/${(created.body as { id: string }).id}`, { method: 'DELETE', body: {}, headers: localHeaders(port) });
    expect(canceled.status).toBe(200);
    await waitFor(() => existsSync(join(dataDir, 'learning.lock')), value => !value);
  });

  it('marks unknown QR text terminal and releases the lock', async () => {
    const transport = new OfflineLoginTransport('unknown-qr');
    const { port } = await start({ dataDir, transport });
    const profile = await addProfile(port, 'unknown-qr', 'ykt');
    const created = await call(port, `/api/profiles/${profile.scope.profileId}/login`, { method: 'POST', body: {}, headers: localHeaders(port) });
    const id = (created.body as { id: string }).id;
    const state = await waitFor(
      () => call(port, `/api/logins/${id}`, { headers: localHeaders(port) }),
      result => LoginStateSchema.parse(result.body).status === 'failed',
    );
    const parsed = LoginStateSchema.parse(state.body);
    expect(parsed.message).toBe('登录二维码链接无效。');
    expect(parsed.qr).toBeNull();
    await waitFor(() => existsSync(join(dataDir, 'learning.lock')), value => !value);
  });

  it('serves only files below the configured static root', async () => {
    const staticDir = tempDir();
    mkdirSync(join(staticDir, 'assets'));
    const outside = tempDir();
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>ok</title>');
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("ok")');
    writeFileSync(join(outside, 'escape.js'), 'secret');
    symlinkSync(join(outside, 'escape.js'), join(staticDir, 'assets', 'link.js'));
    const secretPath = resolve(staticDir, '..', 'web-secret.txt');
    writeFileSync(secretPath, 'secret');
    const { port } = await start({ dataDir, staticDir });
    const asset = await new Promise<{ status: number; body: string }>((resolveAsset, rejectAsset) => {
      const req = request({ host: '127.0.0.1', port, path: '/assets/app.js', headers: { host: `127.0.0.1:${port}` } }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolveAsset({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', rejectAsset);
      req.end();
    });
    expect(asset.status).toBe(200);
    expect(asset.body).toContain('ok');
    const traversal = await call(port, '/%2e%2e/web-secret.txt', { headers: { host: `127.0.0.1:${port}` } });
    expect(traversal.status).toBe(404);
    expect(String(traversal.body)).not.toContain('secret');
    const linked = await call(port, '/assets/link.js', { headers: { host: `127.0.0.1:${port}` } });
    expect(linked.status).toBe(404);
    expect(String(linked.body)).not.toContain('secret');
    unlinkSync(secretPath);
  });
});
