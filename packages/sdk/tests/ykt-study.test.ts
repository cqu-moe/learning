import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { JobRunner } from '../src/services/jobs.js';
import { buildYktHeartbeats, parseWatchProgress } from '../src/providers/ykt/study.js';
import type { Json } from '../src/types/errors.js';

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

  it('falls back to leaf_info media duration when the video was never watched', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/503/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC2', duration: 458 } } } } } },
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '503', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { message: null, code: 0, data: {} } } },
    ]);
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const clock = new FakeClock();
    const runtime: Runtime = { transport, state: new MemoryStateStore(), clock, masterKey: new Uint8Array(32),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video-unwatched', native: { kind: 'ykt' as const, leafId: '503', leafInfoId: null } };
    const client = createLearningClient({ scope, runtime });
    expect((await client.catalog.progress(resource)).value).toMatchObject({ serverCompleted: false, serverFraction: 0, serverSeconds: 0, durationSeconds: 458 });
    transport.assertNoExtraScripts();
  });
});

describe('ykt study job', () => {
  it('skips unknown-duration videos with per-resource warnings instead of blocking the plan', async () => {
    const scope = { userId: 'local', profileId: 'p-skip', platform: 'ykt' as const };
    const good = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video-good', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
    const bad = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video-bad', native: { kind: 'ykt' as const, leafId: '504', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const leaf = (leafId: string) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: `/mooc-api/v1/lms/learn/leaf_info/28930736/${leafId}/`, query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } });
    const progress = (leafId: string, body: Json) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: leafId, snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body } });
    transport.scriptInteractions([
      leaf('502'), progress('502', { data: { '502': { rate: 0, completed: 0, video_length: 30, last_point: 0 } } }),
      leaf('504'), progress('504', { message: null, code: 0, data: {} }),
    ]);
    const client = createLearningClient({ scope, runtime });
    const preview = await client.actions.prepare({ kind: 'study', resources: [good, bad], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause', maxDurationSeconds: 60 } });
    expect(preview.warnings).toEqual([{ code: 'SKIPPED_UNKNOWN_DURATION', message: 'video duration is unknown; play it once in the official web player, then retry', resourceKey: 'video-bad' }]);
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing study job');
    expect(execution.job.total).toBe(1);
    transport.assertNoExtraScripts();
  });

  it('heartbeats without any csrf cookie (platform dropped csrftoken)', async () => {
    const scope = { userId: 'local', profileId: 'p-csrf', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { name: '1.1 心理与健康', course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } };
    const progress = (rate: number, point: number) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate, completed: 0, video_length: 10, last_point: point } } } } });
    const client = createLearningClient({ scope, runtime });
    const write = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/video-log/heartbeat/', headers: { xtbz: 'ykt', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' } }, response: { status: 200, body: {} } };
    transport.scriptInteractions([leaf, progress(0, 0)]);
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause', maxDurationSeconds: 60 } });
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing study job');
    transport.scriptInteractions([leaf, progress(0, 0), write, leaf, progress(0.5, 5)]);
    const done = await client.jobs.advance(execution.job.id);
    expect(done.status).toBe('succeeded');
    expect(done.completed).toBe(1);
    const events = await client.jobs.events(execution.job.id, 0);
    expect(events.some((event) => event.type === 'progress' && event.title === '1.1 心理与健康' && event.durationSeconds === 10 && event.serverSeconds === 0)).toBe(true);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('still rejects when every requested video has unknown duration', async () => {
    const scope = { userId: 'local', profileId: 'p-allbad', platform: 'ykt' as const };
    const bad = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video-bad', native: { kind: 'ykt' as const, leafId: '504', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/504/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } },
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '504', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { message: null, code: 0, data: {} } } },
    ]);
    const client = createLearningClient({ scope, runtime });
    await expect(client.actions.prepare({ kind: 'study', resources: [bad], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause', maxDurationSeconds: 60 } })).rejects.toMatchObject({ data: { code: 'INTERACTION_REQUIRED' } });
    transport.assertNoExtraScripts();
  });

  it('pauses at unresolved embedded questions and resumes the same job only after readback', async () => {
    const scope = { userId: 'local', profileId: 'p-embedded', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 0, course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1', exercise_id: 888 } } } } } };
    const progress = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate: 1, completed: 1, video_length: 10, last_point: 10 } } } } };
    const list = (isRight: boolean) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/901/502/888/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>题</p>' }, user: { is_right: isRight } }] } } });
    const client = createLearningClient({ scope, runtime });
    transport.scriptInteractions([leaf, progress]);
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 1, questionMode: 'pause', maxDurationSeconds: 60 } });
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing study job');
    transport.scriptInteractions([leaf, progress, list(false)]);
    const stopped = await client.jobs.advance(execution.job.id);
    expect(stopped.status).toBe('needs-input');
    expect(stopped.items[0]?.state).toBe('needs-input');
    transport.assertNoExtraScripts();
    await client.jobs.resume(stopped.id);
    transport.scriptInteractions([leaf, progress, list(true)]);
    const done = await client.jobs.advance(stopped.id);
    expect(done.status).toBe('succeeded');
    expect(done.completed).toBe(1);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
  });

  it('marks an unfinished article with the exact write GET and succeeds only after leaf readback', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'article', native: { kind: 'ykt' as const, leafId: '83937494', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 3, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const leaf = (finish: boolean) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/83937494/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 3, sku_id: 901, finish } } } });
    const context = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/v2/api/web/classrooms/28930736', query: { role: '5' } }, response: { status: 200, body: { data: { course_sign: 's', free_sku_id: 901, uv_id: 42 } } } };
    const write = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/user_article_finish/83937494/', query: { cid: '28930736', sid: '901' }, headers: { xtbz: 'ykt', 'university-id': '42', 'uv-id': '42', 'classroom-id': '28930736', 'xt-agent': 'web' } }, response: { status: 200, body: { msg: '', data: {}, success: true } } };
    transport.scriptInteractions([leaf(false)]);
    const client = createLearningClient({ scope, runtime });
    expect((await client.catalog.progress(resource)).value).toMatchObject({ serverCompleted: false, serverFraction: 0, durationSeconds: null });
    transport.assertNoExtraScripts();
    transport.scriptInteractions([leaf(false)]);
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 1, questionMode: 'pause', maxDurationSeconds: 60 } });
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing article job');
    transport.scriptInteractions([leaf(false), context, write, leaf(true)]);
    const done = await client.jobs.advance(execution.job.id);
    expect(done).toMatchObject({ status: 'succeeded', completed: 1, items: [{ key: 'article', state: 'succeeded' }] });
    transport.assertNoExtraScripts();
  });

  it('does not write a completed article or an article without a valid sku', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'article', native: { kind: 'ykt' as const, leafId: '83937494', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 3, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const leaf = (finish: boolean, skuId: number) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/83937494/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 3, sku_id: skuId, finish } } } });
    const client = createLearningClient({ scope, runtime });
    transport.scriptInteractions([leaf(true, 901)]);
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 1, questionMode: 'pause', maxDurationSeconds: 60 } });
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing article job');
    transport.scriptInteractions([leaf(true, 901)]);
    expect((await client.jobs.advance(execution.job.id)).status).toBe('succeeded');
    transport.assertNoExtraScripts();
    transport.scriptInteractions([leaf(false, 0)]);
    await expect(client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 1, questionMode: 'pause', maxDurationSeconds: 60 } })).rejects.toThrow(/sku/i);
    transport.assertNoExtraScripts();
  });

  it('reconciles an uncertain article finish by leaf readback without repeating the write', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'article', native: { kind: 'ykt' as const, leafId: '83937494', leafInfoId: null } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 3, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const runner = new JobRunner(state, clock);
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 1, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const job = await runner.create(scope, 'study', { total: 1, payload: action, generation: 3 });
    const operationId = `article:${job.id}:article`;
    await expect(runner.advance(job.id, async () => {
      await runner.setPendingOperation(job.id, operationId);
      throw Error('simulated lost article response');
    })).rejects.toThrow();
    const leaf = (finish: boolean) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/83937494/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 3, sku_id: 901, finish } } } });
    const client = createLearningClient({ scope, runtime });
    transport.scriptInteractions([leaf(false)]);
    expect((await client.actions.reconcile(operationId)).state).toBe('uncertain');
    expect((await runner.metadata(job.id)).pendingOperationId).toBe(operationId);
    transport.scriptInteractions([leaf(true)]);
    expect((await client.actions.reconcile(operationId)).state).toBe('confirmed');
    expect((await runner.get(job.id)).status).toBe('paused');
    expect((await runner.metadata(job.id)).pendingOperationId).toBeNull();
    transport.assertNoExtraScripts();
  });

  it('creates a durable job and confirms one current-time heartbeat from server progress', async () => {
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
    transport.scriptInteractions([leaf, progress(0, 0), { request: { method: 'POST', host: 'www.yuketang.cn', path: '/video-log/heartbeat/', headers: { xtbz: 'ykt', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: [{ ...row, cp: 5 }] } }, response: { status: 200, body: {} } }, leaf, progress(0.5, 5)]);
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
