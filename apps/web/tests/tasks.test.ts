import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { SqliteStateStore, loadOrCreateMasterKey } from '@learning/sdk/node';
import { CourseSchema, ResourceSchema, JobSchema } from '@learning/sdk/public';
import { createWebServer } from '../server/app.ts';
import { ProfileSchema, TaskPreviewSchema, JobDetailSchema } from '../shared/contracts.ts';
import { FakeTransport, loadFixture } from '../../../packages/sdk/tests/helpers/replay.ts';
import { SessionCookieJar } from '../../../packages/sdk/dist/http/client.js';
import { writeSession } from '../../../packages/sdk/dist/session/store.js';
import { FakeWsTransport } from '../../../packages/sdk/tests/helpers/ws.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

async function setup(transport = new FakeTransport()) {
  const dir = mkdtempSync(join(tmpdir(), 'learning-web-tasks-'));
  const server = createWebServer({ dataDir: dir, transport });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('missing port');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => { await close(server); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(`${origin}/api${path}`, {
    method, headers: { origin, connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const profile = ProfileSchema.parse(await (await request('/profiles', { name: '任务验收', platform: 'ykt' })).json());
  const course = CourseSchema.parse({ ref: { key: 'task-course', scope: profile.scope, native: { kind: 'ykt', classroomId: '28930736' } }, title: '离线任务课程', system: null, term: null, teachers: [], locked: false });
  const resource = ResourceSchema.parse({ ref: { course: course.ref, key: 'task-video', native: { kind: 'ykt', leafId: '502', leafInfoId: null } }, title: '合成视频', kind: 'video', path: ['第一章'], order: 1, durationSeconds: 10, locked: false });
  const state = new SqliteStateStore(join(dir, 'state.db'));
  const rows = [{ key: `cli:course:${course.ref.key}`, value: course }, { key: `web:resource:${resource.ref.key}`, value: resource }];
  await state.commit({ expected: rows.map(row => ({ key: row.key, revision: null })), changes: rows });
  state.close();
  return { request, dir, server, transport, course, resource, profile, port: address.port };
}

function mediaInteractions() {
  const interactions = structuredClone(loadFixture('ykt/media').interactions);
  return [...interactions,
    { request: { method: 'GET', host: 'www.yuketang.cn', path: '/hd.m3u8' }, response: { status: 200, body: '#EXTM3U\n#EXTINF:10,\nfixture.ts\n#EXT-X-ENDLIST\n' } },
    { request: { method: 'GET', host: 'www.yuketang.cn', path: '/fixture.ts' }, response: { status: 200, headers: { 'content-type': 'video/mp2t' }, body: 'offline-media-bytes' } },
  ];
}
const scriptMedia = (transport: FakeTransport) => transport.scriptInteractions(mediaInteractions());

async function waitJob(request: Awaited<ReturnType<typeof setup>>['request'], id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const detail = JobDetailSchema.parse(await (await request(`/jobs/${id}/details`)).json());
    if (detail.job.status === status && !detail.active) return detail;
    if (['failed', 'partial', 'paused', 'uncertain'].includes(detail.job.status) && !detail.active) throw Error(JSON.stringify(detail));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(`job did not reach ${status}`);
}

it('previews a selected resource, starts one real export despite duplicate confirmation, and downloads its artifact', async () => {
  const { request, transport } = await setup();
  scriptMedia(transport);
  const response = await request('/tasks/preview', { kind: 'media', courseKey: 'task-course', resourceKeys: ['task-video'], quality: 'best', subtitles: false });
  expect(response.status).toBe(200);
  const preview = TaskPreviewSchema.parse(await response.json());
  expect(preview.items).toEqual(['合成视频']);
  expect(transport.requests).toHaveLength(0);
  const starts = await Promise.all([request(`/tasks/${preview.id}/start`, {}), request(`/tasks/${preview.id}/start`, {})]);
  expect(starts.map(result => result.status)).toEqual([200, 200]);
  const [first, second] = await Promise.all(starts.map(async result => JobSchema.parse(await result.json())));
  expect(first!.id).toBe(second!.id);
  const done = await waitJob(request, first!.id, 'succeeded');
  expect(done.job.completed).toBe(1);
  expect(done.itemTitles['task-video']).toBe('合成视频');
  const artifact = done.job.items[0]!.artifacts[0]!;
  const download = await request(`/jobs/${first!.id}/artifacts/${encodeURIComponent(artifact.id)}`);
  expect(download.status).toBe(200);
  expect(await download.text()).toBe('offline-media-bytes');
  expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
  expect((await request(`/jobs/${first!.id}/artifacts/not-in-this-job`)).status).toBe(404);
  expect((await request(`/jobs/missing-job/artifacts/${encodeURIComponent(artifact.id)}`)).status).toBe(404);
  const dashboard = await (await request('/dashboard')).json();
  expect(dashboard.jobs).toHaveLength(1);
  transport.assertNoExtraScripts();
});

it('pauses after the current slice, then resumes the saved job after server restart without repeating completed resources', async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const downloading = new Promise<void>(resolve => { entered = resolve; });
  class GatedTransport extends FakeTransport {
    private first = true;
    override async fetch(request: Request) {
      if (this.first && new URL(request.url).pathname === '/fixture.ts') { this.first = false; entered(); await gate; }
      return super.fetch(request);
    }
  }
  const transport = new GatedTransport();
  const { request, dir, server, resource, port } = await setup(transport);
  const state = new SqliteStateStore(join(dir, 'state.db'));
  const second = ResourceSchema.parse({ ...resource, ref: { ...resource.ref, key: 'second-video' } });
  await state.commit({ expected: [{ key: 'web:resource:second-video', revision: null }], changes: [{ key: 'web:resource:second-video', value: second }] });
  state.close();
  transport.scriptInteractions([...mediaInteractions(), ...mediaInteractions()]);
  try {
    const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', { kind: 'media', courseKey: 'task-course', resourceKeys: ['task-video', 'second-video'], quality: 'best', subtitles: false })).json());
    const started = JobSchema.parse(await (await request(`/tasks/${preview.id}/start`, {})).json());
    await downloading;
    expect(existsSync(join(dir, 'learning.lock'))).toBe(true);
    expect((await request('/profiles', { name: '不能抢占', platform: 'ykt' })).status).toBe(409);
    const pausing = request(`/jobs/${started.id}/control`, { action: 'pause' });
    await new Promise(resolve => setTimeout(resolve, 30));
    unblock();
    expect((await pausing).status).toBe(200);
    const paused = await waitJob(request, started.id, 'paused');
    expect(paused.job.completed).toBe(1);
    const firstArtifact = paused.job.items[0]!.artifacts[0]!;
    expect(transport.requests).toHaveLength(4);
    expect(existsSync(join(dir, 'learning.lock'))).toBe(false);
    await close(server);
    const restarted = createWebServer({ dataDir: dir, transport });
    await new Promise<void>(resolve => restarted.listen(port, '127.0.0.1', resolve));
    cleanup.push(() => close(restarted));
    expect((await request(`/jobs/${started.id}/control`, { action: 'resume' })).status).toBe(200);
    const done = await waitJob(request, started.id, 'succeeded');
    expect(done.job.completed).toBe(2);
    expect(done.job.items[0]!.artifacts[0]).toEqual(firstArtifact);
    expect((await (await request('/dashboard')).json()).jobs).toHaveLength(1);
    transport.assertNoExtraScripts();
  } finally { unblock(); }
});

it('validates selection ownership and locked resources, and discards a preview without creating a job', async () => {
  const { request, dir, resource, transport } = await setup();
  const input = { kind: 'media', courseKey: 'task-course', resourceKeys: ['task-video'], quality: 'best', subtitles: false };
  expect((await request('/tasks/preview', { ...input, resourceKeys: [] })).status).toBe(422);
  expect((await request('/tasks/preview', { ...input, resourceKeys: ['task-video', 'task-video'] })).status).toBe(422);
  expect((await request('/tasks/preview', { ...input, resourceKeys: ['missing'] })).status).toBe(409);
  const state = new SqliteStateStore(join(dir, 'state.db'));
  for (const changed of [
    { ...resource, locked: true },
    { ...resource, kind: 'exam' },
    { ...resource, ref: { ...resource.ref, course: { ...resource.ref.course, scope: { ...resource.ref.course.scope, profileId: 'foreign' } } } },
  ]) {
    const key = 'web:resource:task-video';
    const old = await state.get(key);
    await state.commit({ expected: [{ key, revision: old!.revision }], changes: [{ key, value: changed }] });
    expect((await request('/tasks/preview', input)).status).toBe('locked' in changed && changed.locked || changed.kind === 'exam' ? 422 : 403);
  }
  const key = 'web:resource:task-video';
  const old = await state.get(key);
  await state.commit({ expected: [{ key, revision: old!.revision }], changes: [{ key, value: resource }] });
  state.close();
  const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', input)).json());
  expect((await request(`/tasks/${preview.id}`, {}, 'DELETE')).status).toBe(200);
  expect((await request(`/tasks/${preview.id}/start`, {})).status).toBe(409);
  expect((await (await request('/dashboard')).json()).jobs).toHaveLength(0);
  expect(transport.requests).toHaveLength(0);
});

it('keeps uncertain writes unchanged and refuses to steal an external writer lock', async () => {
  const { request, dir, profile, transport } = await setup();
  const state = new SqliteStateStore(join(dir, 'state.db'));
  const job = JobSchema.parse({ id: 'job-uncertain', scope: profile.scope, kind: 'study', status: 'uncertain', createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: null, completed: 0, total: 1, items: [], warnings: [] });
  const rows = [{ key: `job:${job.id}`, value: job }, { key: `job-meta:${job.id}`, value: { inputDigest: 'saved', generation: 1, cursor: null, pendingOperationId: null, running: false } }];
  await state.commit({ expected: rows.map(row => ({ key: row.key, revision: null })), changes: rows });
  state.close();
  for (const action of ['pause', 'cancel', 'resume']) expect((await request(`/jobs/${job.id}/control`, { action })).status).toBe(409);
  expect((await request(`/jobs/${job.id}/reconcile`, {})).status).toBe(409);
  expect(JobDetailSchema.parse(await (await request(`/jobs/${job.id}/details`)).json()).job).toEqual(job);
  writeFileSync(join(dir, 'learning.lock'), `${process.pid}\nfixture-external-owner`, { flag: 'wx' });
  expect((await request('/tasks/preview', { kind: 'media', courseKey: 'task-course', resourceKeys: ['task-video'], quality: 'best', subtitles: false })).status).toBe(409);
  expect(transport.requests).toHaveLength(0);
});

const studyInput = { kind: 'study', courseKey: 'task-course', resourceKeys: ['task-video'], speed: 1, targetPercent: 100, maxMinutes: 30 };
const progressInteractions = () => [
  { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } },
  { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate: 1, completed: 1, video_length: 30, last_point: 30 } } } } },
];

async function verifiedSession(context: Awaited<ReturnType<typeof setup>>, generation = 1) {
  const state = new SqliteStateStore(join(context.dir, 'state.db'));
  try {
    await writeSession(state, loadOrCreateMasterKey(context.dir), { schemaVersion: 1, scope: context.profile.scope, generation, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: Date.now() });
  } finally { state.close(); }
}

it('keeps the study preview executor alive until confirmation and observes authoritative completion', async () => {
  const context = await setup();
  const { request, transport } = context;
  expect((await request('/tasks/preview', studyInput)).status).toBe(401);
  await verifiedSession(context);
  transport.scriptInteractions([...progressInteractions(), ...progressInteractions()]);
  const response = await request('/tasks/preview', studyInput);
  expect(response.status).toBe(200);
  const preview = TaskPreviewSchema.parse(await response.json());
  expect((await (await request('/dashboard')).json()).jobs).toHaveLength(0);
  expect(transport.requests).toHaveLength(2);
  const startedResponse = await request(`/tasks/${preview.id}/start`, {});
  expect(startedResponse.status).toBe(200);
  const started = JobSchema.parse(await startedResponse.json());
  const done = await waitJob(request, started.id, 'succeeded');
  expect(done.job.kind).toBe('study');
  expect(done.job.items[0]).toMatchObject({ key: 'task-video', state: 'succeeded', message: 'server completed' });
  expect(transport.calls.every(call => call.method === 'GET')).toBe(true);
  transport.assertNoExtraScripts();
});

it('refuses an old study confirmation after the account session generation changes', async () => {
  const context = await setup();
  const { request, transport } = context;
  await verifiedSession(context);
  transport.scriptInteractions(progressInteractions());
  const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', studyInput)).json());
  await verifiedSession(context, 2);
  expect((await request(`/tasks/${preview.id}/start`, {})).status).toBe(409);
  expect((await request(`/tasks/${preview.id}/start`, {})).status).toBe(409);
  expect((await (await request('/dashboard')).json()).jobs).toHaveLength(0);
  transport.assertNoExtraScripts();
});

it('loads owned lessons before a slide preview and rejects arbitrary lesson IDs', async () => {
  const { request, transport } = await setup();
  const input = { kind: 'slides', courseKey: 'task-course', lessonIds: ['9000'], format: 'pdf' };
  expect((await request('/tasks/preview', input)).status).toBe(409);
  transport.scriptInteractions(loadFixture('ykt/history-slides').interactions.slice(0, 1));
  const response = await request('/courses/task-course/lessons');
  expect(response.status).toBe(200);
  const lessons = await response.json();
  expect(lessons.items).toHaveLength(2);
  const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', input)).json());
  expect(preview.items).toEqual(['第一课']);
  expect((await request('/tasks/preview', { ...input, lessonIds: ['other-course-lesson'] })).status).toBe(409);
  transport.assertNoExtraScripts();
});

it('requires confirmed live check-in and preserves an uncertain rejoin instead of retrying it', async () => {
  const transport = new FakeWsTransport();
  const context = await setup(transport);
  const { request, server, dir, port } = context;
  async function restart(current: Server) {
    await close(current);
    const next = createWebServer({ dataDir: dir, transport });
    await new Promise<void>(resolve => next.listen(port, '127.0.0.1', resolve));
    cleanup.push(() => close(next));
    return next;
  }
  await verifiedSession(context);
  transport.scriptInteractions(loadFixture('ykt/history-slides').interactions.slice(0, 1));
  expect((await request('/courses/task-course/lessons')).status).toBe(200);
  const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', { kind: 'live', courseKey: 'task-course', lessonId: '9000', maxMinutes: 30 })).json());
  expect(preview.warnings.join()).toContain('签到');
  expect(transport.calls).toHaveLength(1);
  const checkin = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' } }, response: { status: 200, body: { code: 0, data: { lessonToken: 'synthetic-lesson-token' } } } };
  transport.scriptInteractions([checkin]);
  const socket = transport.connectNext();
  const job = JobSchema.parse(await (await request(`/tasks/${preview.id}/start`, {})).json());
  for (let attempt = 0; attempt < 50 && !socket.sent.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(socket.sent).toHaveLength(1);
  const restarted = await restart(server);
  await waitJob(request, job.id, 'paused');
  expect(socket.closed).toBe(true);
  transport.scriptInteractions([{ ...checkin, response: { status: 200, body: { code: 0, data: {} } } }]);
  expect((await request(`/jobs/${job.id}/control`, { action: 'resume' })).status).toBe(409);
  const uncertain = await waitJob(request, job.id, 'uncertain');
  expect(uncertain.job.id).toBe(job.id);
  const calls = transport.calls.length;
  await restart(restarted);
  expect((await request(`/jobs/${job.id}/control`, { action: 'resume' })).status).toBe(409);
  expect((await request(`/jobs/${job.id}/control`, { action: 'cancel' })).status).toBe(409);
  const reconcile = await request(`/jobs/${job.id}/reconcile`, {});
  expect(reconcile.status).toBe(200);
  expect((await reconcile.json()).state).toBe('uncertain');
  expect(transport.calls).toHaveLength(calls);
  transport.assertNoExtraScripts();
});

it('aborts an in-flight live start before waiting for HTTP shutdown, preserving its uncertain operation', async () => {
  let entered!: () => void;
  let release!: () => void;
  let aborted = false;
  const startedSending = new Promise<void>(resolve => { entered = resolve; });
  class HangingCheckin extends FakeWsTransport {
    override async fetch(request: Request) {
      const response = await super.fetch(request);
      if (!request.url.endsWith('/api/v3/lesson/checkin')) return response;
      entered();
      return new Promise<Response>((resolve, reject) => {
        release = () => resolve(response);
        const abort = () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
  const transport = new HangingCheckin();
  const context = await setup(transport);
  const { request, server, dir } = context;
  await verifiedSession(context);
  transport.scriptInteractions([
    ...loadFixture('ykt/history-slides').interactions.slice(0, 1),
    { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', body: { source: 1, lessonId: '9000' } }, response: { status: 200, body: { code: 0, data: { lessonToken: 'synthetic-token' } } } },
  ]);
  await request('/courses/task-course/lessons');
  const preview = TaskPreviewSchema.parse(await (await request('/tasks/preview', { kind: 'live', courseKey: 'task-course', lessonId: '9000', maxMinutes: 30 })).json());
  transport.connectNext();
  const startResponse = request(`/tasks/${preview.id}/start`, {});
  await startedSending;
  const closing = close(server);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closedWithoutReleasingNetwork = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 700); })]);
    expect(closedWithoutReleasingNetwork).toBe(true);
    expect(aborted).toBe(true);
    expect((await startResponse).status).toBe(409);
    const state = new SqliteStateStore(join(dir, 'state.db'));
    const operations = await state.list('preview:', null, 100);
    expect(operations.items.some(item => JSON.stringify(item.record.value).includes('"state":"uncertain"'))).toBe(true);
    state.close();
  } finally {
    clearTimeout(timer);
    release();
    await startResponse;
    await closing;
  }
  transport.assertNoExtraScripts();
});
