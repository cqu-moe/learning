import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { z } from 'zod';
import { JobSchema, OutlineSchema, ResourceSchema } from '@learning/sdk/public';
import type { OutlineNode, Resource } from '@learning/sdk/public';
import { SqliteStateStore } from '@learning/sdk/node';
import { createWebServer } from '../server/app.ts';
import { DashboardSchema, JobDetailSchema, ProfileSchema, TaskPreviewSchema } from '../shared/contracts.ts';
import { FakeTransport, loadFixture } from '../../../packages/sdk/tests/helpers/replay.ts';
import type { Fixture } from '../../../packages/sdk/tests/helpers/replay.ts';

const entry = resolve(import.meta.dirname, '../../cli/dist/index.js');
const preload = resolve(import.meta.dirname, 'cli-fixture.mjs');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const envelope = z.object({ schemaVersion: z.literal(1), ok: z.boolean(), data: z.unknown(), error: z.object({ code: z.string() }).nullable() });

async function setup(transport = new FakeTransport()) {
  const dir = mkdtempSync(join(tmpdir(), 'learning-web-cli-'));
  const server = createWebServer({ dataDir: dir, transport });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no port');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => { await close(server); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, body?: unknown) => fetch(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  function cli(args: string[], interactions: Fixture['interactions'] = [], pausePath?: string) {
    const file = join(dir, `fixture-${crypto.randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ interactions }));
    const child = spawn(process.execPath, ['--import', preload, entry, ...args], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NODE_ENV: 'test', LEARNING_HOME: dir, LEARNING_FIXTURE_FILE: file, LEARNING_INTEROP_PAUSE_PATH: pausePath ?? '', LEARNING_TELEMETRY_TOKEN: '', POSTHOG_PROJECT_TOKEN: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    const waiting = new Promise<void>((resolve, reject) => {
      child.stderr.on('data', () => { if (stderr.includes('interop: segment waiting')) resolve(); });
      void done.then(result => { if (!result.stderr.includes('interop: segment waiting')) reject(Error(result.stderr || result.stdout)); }, reject);
    });
    void waiting.catch(() => undefined);
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await done; });
    return { child, done, waiting };
  }
  async function run(args: string[], interactions: Fixture['interactions'] = [], code = 0) {
    const result = await cli(args, interactions).done;
    expect(result.code, result.stderr || result.stdout).toBe(code);
    expect(result.stderr).not.toContain('fixture:');
    return envelope.parse(JSON.parse(result.stdout));
  }
  const created = await run(['profile', 'add', 'Agent 账号', '--platform', 'ykt']);
  const profile = ProfileSchema.parse({ ...z.object({ name: z.string(), scope: ProfileSchema.shape.scope }).parse(created.data), hasSession: false });
  return { dir, transport, server, request, run, cli, profile };
}

const flatten = (nodes: OutlineNode[]): Resource[] => nodes.flatMap(node => [...node.resources, ...flatten(node.children)]);
async function catalog(context: Awaited<ReturnType<typeof setup>>, fromCli = false) {
  const courses = await context.run(['courses'], loadFixture('ykt/courses-list').interactions);
  const items = DashboardSchema.shape.courses.parse(z.object({ items: z.unknown() }).parse(courses.data).items);
  const course = items[0]!;
  expect(DashboardSchema.parse(await (await context.request('/dashboard')).json()).courses.map(item => item.ref.key).sort()).toEqual(items.map(item => item.ref.key).sort());
  let outline;
  if (fromCli) outline = z.object({ value: OutlineSchema }).parse((await context.run(['outline', course.ref.key], loadFixture('ykt/nested-outline').interactions)).data).value;
  else {
    context.transport.scriptInteractions(loadFixture('ykt/nested-outline').interactions);
    const response = await context.request(`/courses/${course.ref.key}/outline`);
    expect(response.status).toBe(200);
    outline = OutlineSchema.parse((await response.json()).value);
  }
  return { course, resource: flatten(outline.roots).find(resource => resource.ref.native.kind === 'ykt' && resource.ref.native.leafId === '502')! };
}
const userinfo = () => structuredClone(loadFixture('ykt/qr-login').interactions.at(-1)!);
const media = (remaining = false): Fixture['interactions'] => [
  ...structuredClone(loadFixture('ykt/media').interactions),
  { request: { method: 'GET', host: 'www.yuketang.cn', path: '/hd.m3u8' }, response: { status: 200, body: '#EXTM3U\n#EXTINF:5,\nhead.ts\n#EXTINF:5,\ntail.ts\n#EXT-X-ENDLIST\n' } },
  ...remaining ? [] : [{ request: { method: 'GET', host: 'www.yuketang.cn', path: '/head.ts' }, response: { status: 200, body: 'head-' } }],
  { request: { method: 'GET', host: 'www.yuketang.cn', path: '/tail.ts' }, response: { status: 200, body: 'tail' } },
];
async function completed(context: Awaited<ReturnType<typeof setup>>, id: string) {
  for (let i = 0; i < 150; i++) {
    const detail = JobDetailSchema.parse(await (await context.request(`/jobs/${id}/details`)).json());
    if (!detail.active && detail.job.status === 'succeeded') return detail;
    if (!detail.active && ['failed', 'partial', 'uncertain'].includes(detail.job.status)) throw Error(JSON.stringify(detail));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('export did not complete');
}

it('shares Web login, CLI login, default account and logout without exposing session secrets', async () => {
  const context = await setup();
  const { request, profile, transport, run, dir } = context;
  const webProfile = ProfileSchema.parse(await (await request('/profiles', { name: 'Web 账号', platform: 'ykt' })).json());
  expect(z.object({ profiles: z.array(z.object({ name: z.string() })) }).parse((await run(['profile', 'list'])).data).profiles.map(p => p.name)).toEqual(expect.arrayContaining(['Agent 账号', 'Web 账号']));
  expect((await request(`/profiles/${profile.scope.profileId}/control`, { action: 'default' })).status).toBe(200);
  expect((await run(['config', 'show'])).data).toMatchObject({ defaultProfileId: profile.scope.profileId });
  transport.scriptInteractions(loadFixture('ykt/qr-login').interactions);
  const { id } = await (await request(`/profiles/${profile.scope.profileId}/login`, {})).json();
  await expect.poll(async () => (await (await request(`/logins/${id}`)).json()).status).toBe('authenticated');
  const check = userinfo();
  check.request.headers = { cookie: 'sessionid=sess-fixture; django_language=zh' };
  expect((await run(['whoami'], [check])).data).toMatchObject({ state: 'valid' });
  const cookieFile = join(dir, 'synthetic-cookies.json');
  writeFileSync(cookieFile, JSON.stringify([{ name: 'sessionid', value: 'from-cli', domain: 'www.yuketang.cn', path: '/' }]));
  await run(['login', '--import', cookieFile]);
  const probe = userinfo(); probe.request.headers = { cookie: 'sessionid=from-cli' };
  transport.scriptInteractions([probe]);
  expect((await request(`/profiles/${profile.scope.profileId}/control`, { action: 'probe' })).status).toBe(200);
  const response = await request('/dashboard'); const serialized = await response.text();
  expect(serialized).not.toMatch(/from-cli|sess-fixture|cookieJar|masterKey/);
  expect((await request(`/profiles/${profile.scope.profileId}/control`, { action: 'disconnect' })).status).toBe(200);
  expect(DashboardSchema.parse(await (await request('/dashboard')).json()).profiles.find(p => p.name === profile.name)?.hasSession).toBe(false);
  expect((await run(['whoami'])).data).toMatchObject({ state: 'expired' });
  await run(['config', 'set', 'default-profile', webProfile.name]);
  expect((await (await request('/dashboard')).json()).defaultProfileId).toBe(webProfile.scope.profileId);
  expect((await request(`/profiles/${webProfile.scope.profileId}/control`, { action: 'remove' })).status).toBe(200);
  expect((await run(['config', 'show'])).data).toMatchObject({ defaultProfileId: null });
  expect(z.object({ profiles: z.array(z.object({ name: z.string() })) }).parse((await run(['profile', 'list'])).data).profiles.map(p => p.name)).toEqual([profile.name]);
  transport.assertNoExtraScripts();
}, 30_000);

it.each(['cli-to-web', 'web-to-cli'] as const)('resumes the original HLS checkpoint %s and enforces the same writer lock', async direction => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  class GatedTransport extends FakeTransport {
    block = direction === 'web-to-cli';
    override async fetch(request: Request) {
      const response = await super.fetch(request);
      if (!this.block || new URL(request.url).pathname !== '/tail.ts') return response;
      this.block = false; entered();
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  const context = await setup(new GatedTransport());
  const { request, transport, run, cli, dir } = context;
  const { course, resource } = await catalog(context, direction === 'cli-to-web');
  let id: string;
  if (direction === 'cli-to-web') {
    const task = cli(['download', resource.ref.key, '--types', 'video', '--output-format', 'jsonl'], media(), '/tail.ts');
    await task.waiting;
    const jobs = DashboardSchema.parse(await (await request('/dashboard')).json()).jobs;
    id = jobs[0]!.id;
    expect((await request(`/jobs/${id}/control`, { action: 'resume' })).status).toBe(409);
    task.child.kill('SIGTERM');
    const result = await task.done;
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).not.toContain('fixture:');
    transport.scriptInteractions(media(true));
  } else {
    transport.scriptInteractions(media());
    const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', { kind: 'media', courseKey: course.ref.key, resourceKeys: [resource.ref.key], quality: 'best', subtitles: false })).json());
    id = JobSchema.parse(await (await request(`/tasks/${preview.id}/start`, {})).json()).id;
    await waiting;
    expect((await run(['jobs', 'resume', id], [], 3)).error).toMatchObject({ code: 'CONFLICT' });
    expect((await request(`/jobs/${id}/control`, { action: 'pause' })).status).toBe(200);
  }
  const paused = JobDetailSchema.parse(await (await request(`/jobs/${id}/details`)).json());
  expect(paused.job.status).toBe('paused');
  expect(existsSync(join(dir, 'learning.lock'))).toBe(false);
  if (direction === 'cli-to-web') expect((await request(`/jobs/${id}/control`, { action: 'resume' })).status).toBe(200);
  else {
    const resumed = await run(['jobs', 'resume', id], media(true));
    const result = z.object({ job: JobSchema, files: z.array(z.string()) }).parse(resumed.data);
    expect(result.job).toMatchObject({ id, status: 'succeeded' });
    expect(readFileSync(result.files[0]!, 'utf8')).toBe('head-tail');
  }
  const done = await completed(context, id);
  expect(JobSchema.parse((await run(['jobs', 'show', id])).data).id).toBe(id);
  expect(done.itemTitles[resource.ref.key]).toBe(resource.title);
  expect(done.job.items).toHaveLength(1);
  const artifact = done.job.items[0]!.artifacts[0]!;
  expect(await (await request(`/jobs/${id}/artifacts/${encodeURIComponent(artifact.id)}`)).text()).toBe('head-tail');
  expect(DashboardSchema.parse(await (await request('/dashboard')).json()).jobs).toHaveLength(1);
  transport.assertNoExtraScripts();
}, 30_000);

it('clears only a confirmed dead writer from Web and preserves live or malformed locks', async () => {
  const { request, dir } = await setup();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  const path = join(dir, 'learning.lock');
  writeFileSync(path, `${deadPid}\nold-process`, { flag: 'wx' });
  expect((await (await request('/dashboard')).json()).writer).toEqual({ state: 'stale', pid: deadPid });
  expect((await request('/system/unlock', { pid: deadPid + 1 })).status).toBe(409);
  expect((await request('/system/unlock', { pid: deadPid })).status).toBe(200);
  expect(existsSync(path)).toBe(false);
  for (const token of [`${process.pid}\nactive`, 'invalid']) {
    writeFileSync(path, token);
    expect((await request('/system/unlock', { pid: process.pid })).status).toBe(409);
    expect(readFileSync(path, 'utf8')).toBe(token);
  }
});

it('CLI account removal clears Web caches and invalidates an unstarted Web preview', async () => {
  const context = await setup();
  const { request, run, dir, profile, transport } = context;
  const { course, resource } = await catalog(context);
  const other = ProfileSchema.parse(await (await request('/profiles', { name: '保留账号', platform: 'ykt' })).json());
  const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', { kind: 'media', courseKey: course.ref.key, resourceKeys: [resource.ref.key], quality: 'best', subtitles: false })).json());
  await run(['profile', 'remove', profile.name, '--yes']);
  const db = new SqliteStateStore(join(dir, 'state.db'));
  try {
    expect(await db.get(`web:resource:${resource.ref.key}`)).toBeNull();
    expect(await db.get(`cli:resource-path:${resource.ref.key}`)).toBeNull();
  } finally { db.close(); }
  expect((await request(`/tasks/${preview.id}/start`, {})).status).toBe(404);
  const dashboard = DashboardSchema.parse(await (await request('/dashboard')).json());
  expect(dashboard.profiles.map(p => p.scope.profileId)).toEqual([other.scope.profileId]);
  expect(dashboard.jobs).toHaveLength(0);
  expect(dashboard.courses).toHaveLength(0);
  transport.assertNoExtraScripts();
}, 30_000);

it.each(['web-disconnect', 'cli-relogin'] as const)('invalidates a hydrated assessment preview after %s', async change => {
  const context = await setup();
  const { request, run, dir, profile, transport } = context;
  const { course } = await catalog(context);
  const cookieFile = join(dir, 'preview-cookies.json');
  writeFileSync(cookieFile, JSON.stringify([{ name: 'sessionid', value: 'preview-session', domain: 'www.yuketang.cn', path: '/' }]));
  await run(['login', '--import', cookieFile]);
  const db = new SqliteStateStore(join(dir, 'state.db'));
  const resource = ResourceSchema.parse({ ref: { key: 'preview-homework', course: course.ref, native: { kind: 'ykt', leafId: '505', leafInfoId: null } }, title: '合成普通作业', kind: 'homework', path: [], order: 1, durationSeconds: null, locked: false });
  try {
    const key = `web:resource:${resource.ref.key}`;
    expect(await db.commit({ expected: [{ key, revision: null }], changes: [{ key, value: resource }] })).toBe(true);
  } finally { db.close(); }
  const resolveHomework = structuredClone(loadFixture('ykt/exercise-read').interactions[0]!);
  resolveHomework.request.headers = { ...resolveHomework.request.headers, cookie: 'sessionid=preview-session' };
  transport.scriptInteractions([resolveHomework]);
  const previewResponse = await request('/tasks/preview', { kind: 'assessments', courseKey: course.ref.key, resourceKeys: [resource.ref.key], format: 'json' });
  expect(previewResponse.status).toBe(200);
  const preview = TaskPreviewSchema.parse(await previewResponse.json());
  if (change === 'web-disconnect') expect((await request(`/profiles/${profile.scope.profileId}/control`, { action: 'disconnect' })).status).toBe(200);
  else await run(['login', '--import', cookieFile]);
  const requestsBefore = transport.requests.length;
  const started = await request(`/tasks/${preview.id}/start`, {});
  expect(started.status).toBe(409);
  expect(await started.json()).toMatchObject({ error: { code: 'PRECONDITION_CHANGED' } });
  expect(DashboardSchema.parse(await (await request('/dashboard')).json()).jobs).toHaveLength(0);
  expect(transport.requests).toHaveLength(requestsBefore);
  transport.assertNoExtraScripts();
}, 30_000);
