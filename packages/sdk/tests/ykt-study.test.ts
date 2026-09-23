import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { JobRunner } from '../src/services/jobs.js';
import { buildYktHeartbeats, parseWatchProgress } from '../src/providers/ykt/study.js';

describe('ykt study heartbeats (T19, A191/A192)', () => {
  it('builds valid beats: no future ts, cp clamped to duration, sq from 1', () => {
    const clockNow = 1_728_000_000_000;
    const rows = buildYktHeartbeats({
      cpStart: 0,
      duration: 30,
      speed: 2,
      userId: '424242',
      courseId: '5184094',
      videoId: '701',
      skuId: '901',
      classroomId: '28927419',
      ccid: 'CC1',
      pg: '701_pg',
      tsStartMs: clockNow,
    });
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.et === 'heartbeat')).toBe(true);
    expect(rows.every((row) => Number(row.ts) <= clockNow + (rows.length - 1) * 5000)).toBe(true);
    expect(rows.map((row) => row.cp)).toEqual([10, 20, 30]);
    expect(rows.map((row) => row.sq)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.lob === 'ykt' && row.sp === 2 && row.tp === 30)).toBe(true);
  });

  it('guards bad inputs: speed<1, duration<=0 rejected; already-complete yields no beats', () => {
    expect(() => buildYktHeartbeats({ cpStart: 0, duration: 30, speed: 0, userId: 'u', courseId: 'c', videoId: 'v', skuId: 's', classroomId: 'cl', ccid: 'cc', pg: 'p', tsStartMs: 0 })).toThrow(/speed/);
    expect(() => buildYktHeartbeats({ cpStart: 0, duration: 0, speed: 1, userId: 'u', courseId: 'c', videoId: 'v', skuId: 's', classroomId: 'cl', ccid: 'cc', pg: 'p', tsStartMs: 0 })).toThrow(/duration/);
    expect(buildYktHeartbeats({ cpStart: 30, duration: 30, speed: 1, userId: 'u', courseId: 'c', videoId: 'v', skuId: 's', classroomId: 'cl', ccid: 'cc', pg: 'p', tsStartMs: 0 })).toEqual([]);
  });

  it('parses authoritative watch progress with defaults for never-watched videos', () => {
    const progress = parseWatchProgress({ data: { 701: { rate: 2, completed: 0, video_length: 30, last_point: 12 } } }, '701');
    expect(progress).toEqual({ rate: 2, completed: false, videoLength: 30, lastPoint: 12 });
    expect(parseWatchProgress({}, '999')).toEqual({ rate: 0, completed: false, videoLength: 0, lastPoint: 0 });
  });
});

describe('ykt authoritative progress', () => {
  it('reads the leaf identity and watch state with the exact request envelope', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } },
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate: 0.4, completed: 0, video_length: 30, last_point: 12 } } } } },
    ]);
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const clock = new FakeClock();
    const runtime: Runtime = { transport, state: new MemoryStateStore(), clock, masterKey: new Uint8Array(32),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
    const client = createLearningClient({ scope, runtime });
    expect((await client.catalog.progress(resource)).value).toMatchObject({ resource, serverCompleted: false, serverFraction: 0.4, serverSeconds: 12, durationSeconds: 30 });
    transport.assertNoExtraScripts();
  });
});

describe('ykt study job', () => {
  it('creates a durable job and confirms one current-time heartbeat from server progress', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.yuketang.cn/'), ['csrftoken=fixture-csrf; Path=/']);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 3, platformUserId: '424242', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } };
    const progress = (rate: number, point: number) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate, completed: rate === 1 ? 1 : 0, video_length: 10, last_point: point } } } } });
    transport.scriptInteractions([leaf, progress(0, 0)]);
    const client = createLearningClient({ scope, runtime });
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause', maxDurationSeconds: 60 } });
    transport.assertNoExtraScripts();
    const execution = await client.actions.execute(preview.id);
    expect(execution.type).toBe('job');
    if (execution.type !== 'job') throw Error('missing study job');
    const job = execution.job;
    const row = buildYktHeartbeats({ cpStart: 0, duration: 10, speed: 1, userId: '424242', courseId: '5184094', videoId: '502', skuId: '901', classroomId: '28930736', ccid: 'CC1', pg: `${job.id}_502`, tsStartMs: clock.nowMs() })[0]!;
    transport.scriptInteractions([leaf, progress(0, 0), { request: { method: 'POST', host: 'www.yuketang.cn', path: '/video-log/heartbeat/', headers: { xtbz: 'ykt', 'classroom-id': '28930736', 'x-csrftoken': 'fixture-csrf', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: [{ ...row, cp: 5 }] } }, response: { status: 200, body: {} } }, leaf, progress(0.5, 5)]);
    const done = await client.jobs.advance(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.items[0]).toMatchObject({ key: 'video', state: 'succeeded' });
    expect((await client.jobs.advance(job.id)).status).toBe('succeeded');
    transport.assertNoExtraScripts();
  });

  it('reconciles a lost heartbeat by read-back without resending it', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 3, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const runner = new JobRunner(state, clock);
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const job = await runner.create(scope, 'study', { total: 1, payload: action, generation: 3 });
    const operationId = `heartbeat:${job.id}:video:1`;
    await expect(runner.advance(job.id, async () => {
      await runner.setCursor(job.id, JSON.stringify({ resourceKey: 'video', cp: 5, sq: 1, baseline: 0, awaiting: true, stalls: 0 }));
      await runner.setPendingOperation(job.id, operationId);
      throw Error('simulated lost response');
    })).rejects.toThrow();
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } },
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate: 0.5, completed: 0, video_length: 10, last_point: 5 } } } } },
    ]);
    const client = createLearningClient({ scope, runtime });
    expect((await client.actions.reconcile(operationId)).state).toBe('confirmed');
    expect((await runner.get(job.id)).status).toBe('paused');
    expect((await runner.metadata(job.id)).pendingOperationId).toBeNull();
    transport.assertNoExtraScripts();
  });
});
