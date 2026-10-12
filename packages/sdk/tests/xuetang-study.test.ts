import { describe, expect, it } from 'vitest';
import { advanceXtxStudy, buildXtxHeartBatch, buildXtxStudyRow, reconcileXtxHeartbeat, schedulePollStates, xtxReadStudyIdentity } from '../src/providers/xuetang/study.js';
import { createSessionHttp, SessionCookieJar } from '../src/http/client.js';
import { JobRunner } from '../src/services/jobs.js';
import { createLearningClient } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';

describe('xtx study heartbeats (T20, A201/A202)', () => {
  it('builds a heart_data batch: ratechange first, lob=xt everywhere, sq/pg correct', () => {
    const batch = buildXtxHeartBatch({
      classroomId: '100',
      courseId: '5',
      leafId: '7',
      videoId: 'CCX1',
      userId: '77',
      speed: 2,
      duration: 30,
      cpStart: 0,
      sqStart: 0,
      tsStartMs: 1_000_000,
    });
    expect(batch.heart_data.length).toBe(2);
    expect(batch.heart_data[0]).toMatchObject({ et: 'ratechange', sp: 2, lob: 'xt' });
    expect(batch.heart_data.slice(1).every((row) => row.et === 'heartbeat')).toBe(true);
    expect(batch.heart_data.every((row) => row.lob === 'xt')).toBe(true);
    expect(batch.heart_data.map((row) => row.sq)).toEqual([1, 2]);
    const heartbeatRows = batch.heart_data.filter((row) => row.et === 'heartbeat');
    expect(heartbeatRows.every((row) => row.cp <= 30)).toBe(true);
    expect(heartbeatRows.every((row) => typeof row.ts === 'string')).toBe(true);
  });

  it('schedule read-back: pending is not complete; confirmed within 180s budget (A202)', () => {
    const states = schedulePollStates({ intervalMs: 6000, budgetMs: 180_000, confirmAtAttempt: 15 });
    expect(states.slice(0, 14).every((state) => state === 'waiting')).toBe(true);
    expect(states[14]).toBe('confirmed');
    const timeout = schedulePollStates({ intervalMs: 6000, budgetMs: 180_000, confirmAtAttempt: null });
    expect(timeout[timeout.length - 1]).toBe('timeout');
  });
});

describe('xtx schedule read-back', () => {
  it('uses cid and sign to report only the authoritative leaf schedule', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions([{ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule', query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { leaf_schedules: { '7': 0.4, '8': 1 } } } } }]);
    const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
    const runtime: Runtime = { transport, state: new MemoryStateStore(), clock: new FakeClock(), masterKey: new Uint8Array(32),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    expect((await createLearningClient({ scope, runtime }).catalog.progress(resource)).value).toMatchObject({ serverFraction: 0.4, serverCompleted: false, durationSeconds: null });
    transport.assertNoExtraScripts();
  });
});

describe('xtx study identity and wire rows', () => {
  it('reads duration and native ids, then builds the full lob=xt event row', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions([{ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { id: 7, course_id: 5, user_id: 77, sku_id: 9, content_info: { media: { ccid: 'CCX1', duration: 10 } } } } } }]);
    const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '9' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const http = createSessionHttp({ transport, clock: new FakeClock(), jar: new SessionCookieJar(), allowHosts: ['xuetangx.com'] });
    const identity = await xtxReadStudyIdentity(http, resource);
    expect(identity).toMatchObject({ courseId: '5', userId: '77', skuId: '9', videoId: '7', ccid: 'CCX1', duration: 10 });
    const row = buildXtxStudyRow(identity, { event: 'heartbeat', cp: 5, speed: 2, sq: 4, tsMs: 1_000_000, classroomId: '100', pg: '7_fixture' });
    expect(row).toMatchObject({ et: 'heartbeat', lob: 'xt', cp: 5, sp: 2, ts: '1000000', sq: 4, d: 10, classroomid: '100', cc: 'CCX1' });
    expect(Object.keys(row).sort()).toEqual(['i', 'et', 'p', 'n', 'lob', 'cp', 'fp', 'tp', 'sp', 'ts', 'u', 'c', 'v', 'cc', 'd', 'pg', 'sq', 't', 'uip', 'skuid', 'classroomid', 'cards_id', 'slide', 'v_url'].sort());
    transport.assertNoExtraScripts();
  });
});

describe('xtx study lifecycle', () => {
  it('keeps the pending heartbeat when acknowledgement succeeds but schedule readback fails', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p-lost-read', platform: 'xuetang' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '9' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 3600 } };
    const runner = new JobRunner(state, clock);
    const job = await runner.create(scope, 'study', { total: 1, generation: 1, payload: action });
    await runner.setCursor(job.id, JSON.stringify({ resourceKey: 'video', phase: 'heart', cp: 0, sq: 3, baseline: 0, awaiting: false, stalls: 0 }));
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.xuetangx.com/'), ['csrftoken=fixture; Path=/']);
    const http = createSessionHttp({ transport, clock, jar, allowHosts: ['xuetangx.com'] });
    const schedule = (rate: number, status = 200) => ({ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule', query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status, body: { data: { leaf_schedules: { '7': rate } } } } });
    const leaf = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { id: 7, name: '1.1 学堂视频', course_id: 5, user_id: 77, sku_id: 9, content_info: { media: { ccid: 'CCX1', duration: 10 } } } } } };
    const row = buildXtxStudyRow({ courseId: '5', userId: '77', skuId: '9', videoId: '7', ccid: 'CCX1', duration: 10, exerciseId: null }, { event: 'heartbeat', cp: 5, speed: 1, sq: 4, tsMs: clock.nowMs(), classroomId: '100', pg: `${job.id}_7` });
    const write = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/video-log/heartbeat/', headers: { xtbz: 'xt', 'x-csrftoken': 'fixture', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: [row] } }, response: { status: 200, body: {} } };
    transport.scriptInteractions([schedule(0), leaf, write, schedule(0, 403)]);
    await expect(advanceXtxStudy({ job, action, runner, http, jar, clock })).rejects.toThrow(/schedule returned HTTP 403/);
    const uncertain = await runner.get(job.id);
    expect(uncertain.status).toBe('uncertain');
    const operationId = `xtx-heartbeat:${job.id}:video:4`;
    expect((await runner.metadata(job.id)).pendingOperationId).toBe(operationId);
    expect((await runner.events(job.id, 0)).some((event) => event.type === 'progress' && event.title === '1.1 学堂视频' && event.durationSeconds === 10 && event.serverFraction === 0 && event.serverSeconds === null)).toBe(true);
    transport.scriptInteractions([schedule(0.5)]);
    expect((await reconcileXtxHeartbeat({ job: uncertain, action, runner, http, clock, operationId })).state).toBe('confirmed');
    expect((await runner.get(job.id)).status).toBe('paused');
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('waits for delayed schedule accounting up to 180 seconds without sending a second heartbeat', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p-delay', platform: 'xuetang' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '9' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 3600 } };
    const runner = new JobRunner(state, clock);
    let job = await runner.create(scope, 'study', { total: 1, generation: 1, payload: action });
    await runner.setCursor(job.id, JSON.stringify({ resourceKey: 'video', phase: 'heart', cp: 5, sq: 5, baseline: 0, awaiting: true, stalls: 0, awaitingSinceMs: clock.nowMs() }));
    const jar = new SessionCookieJar();
    const http = createSessionHttp({ transport, clock, jar, allowHosts: ['xuetangx.com'] });
    const schedule = (rate: number) => ({ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule', query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { leaf_schedules: { '7': rate } } } } });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      transport.scriptInteractions([schedule(0)]);
      job = await advanceXtxStudy({ job, action, runner, http, jar, clock });
      expect(job.status).toBe('waiting');
      clock.setNow(clock.nowMs() + 5000);
    }
    transport.scriptInteractions([schedule(0.5)]);
    job = await advanceXtxStudy({ job, action, runner, http, jar, clock });
    expect(job.status).toBe('succeeded');
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
    const stale = await runner.create(scope, 'study', { total: 1, generation: 1, payload: action });
    await runner.setCursor(stale.id, JSON.stringify({ resourceKey: 'video', phase: 'heart', cp: 5, sq: 5, baseline: 0, awaiting: true, stalls: 0, awaitingSinceMs: clock.nowMs() - 180_001 }));
    transport.scriptInteractions([schedule(0)]);
    expect((await advanceXtxStudy({ job: stale, action, runner, http, jar, clock })).status).toBe('needs-input');
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
  });

  it('emits start, ratechange, then heartbeat only after each wall-clock interval', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '9' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 2, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const runner = new JobRunner(state, clock);
    const job = await runner.create(scope, 'study', { total: 1, generation: 1, payload: action });
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.xuetangx.com/'), ['csrftoken=fixture; Path=/']);
    const http = createSessionHttp({ transport, clock, jar, allowHosts: ['xuetangx.com'] });
    const schedule = (rate: number) => ({ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule', query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { leaf_schedules: { '7': rate } } } } });
    const leaf = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { id: 7, course_id: 5, user_id: 77, sku_id: 9, content_info: { media: { ccid: 'CCX1', duration: 10 } } } } } };
    const identity = { courseId: '5', userId: '77', skuId: '9', videoId: '7', ccid: 'CCX1', duration: 10, exerciseId: null };
    let current = job;
    for (const [stage, now, event, cp, sq] of [
      ['start', clock.nowMs(), 'loadstart', 0, 1],
      ['rate', clock.nowMs() + 5000, 'ratechange', 0, 4],
      ['heart', clock.nowMs() + 10000, 'heartbeat', 5, 5],
    ] as const) {
      clock.setNow(now);
      const rows = stage === 'start' ? ['loadstart', 'loadeddata', 'play'].map((type, index) => buildXtxStudyRow(identity, { event: type as 'loadstart' | 'loadeddata' | 'play', cp, speed: 2, sq: index + 1, tsMs: now, classroomId: '100', pg: `${job.id}_7` }))
        : [buildXtxStudyRow(identity, { event, cp, speed: 2, sq, tsMs: now, classroomId: '100', pg: `${job.id}_7` })];
      const write = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/video-log/heartbeat/', headers: { xtbz: 'xt', 'x-csrftoken': 'fixture', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: rows } }, response: { status: 200, body: {} } };
      transport.scriptInteractions(stage === 'heart' ? [schedule(0), leaf, write, schedule(0.5)] : [schedule(0), leaf, write]);
      current = await advanceXtxStudy({ job: current, action, runner, http, jar, clock });
      transport.assertNoExtraScripts();
      expect(current.status).toBe(stage === 'heart' ? 'succeeded' : 'waiting');
    }
  });

  it('emits nullable server progress without synthesizing a schedule fraction', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p-unknown-schedule', platform: 'xuetang' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '9' } }, key: 'video', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const runner = new JobRunner(state, clock);
    const job = await runner.create(scope, 'study', { total: 1, generation: 1, payload: action });
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.xuetangx.com/'), ['csrftoken=fixture; Path=/']);
    const http = createSessionHttp({ transport, clock, jar, allowHosts: ['xuetangx.com'] });
    const identity = { courseId: '5', userId: '77', skuId: '9', videoId: '7', ccid: 'CCX1', duration: 10, exerciseId: null };
    const rows = (['loadstart', 'loadeddata', 'play'] as const).map((event, index) => buildXtxStudyRow(identity, { event, cp: 0, speed: 1, sq: index + 1, tsMs: clock.nowMs(), classroomId: '100', pg: `${job.id}_7` }));
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule', query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { leaf_schedules: {} } } } },
      { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { id: 7, name: '1.1 学堂视频', course_id: 5, user_id: 77, sku_id: 9, content_info: { media: { ccid: 'CCX1', duration: 10 } } } } } },
      { request: { method: 'POST', host: 'www.xuetangx.com', path: '/video-log/heartbeat/', headers: { xtbz: 'xt', 'x-csrftoken': 'fixture', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: rows } }, response: { status: 200, body: {} } },
    ]);
    const waiting = await advanceXtxStudy({ job, action, runner, http, jar, clock });
    expect(waiting.status).toBe('waiting');
    expect((await runner.events(job.id, 0)).some((event) => event.type === 'progress' && event.title === '1.1 学堂视频' && event.durationSeconds === 10 && event.serverFraction === null && event.serverSeconds === null)).toBe(true);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });
});
