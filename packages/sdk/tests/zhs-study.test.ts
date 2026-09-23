import { describe, expect, it } from 'vitest';
import { advanceHikeStudy, advanceShareStudy, buildShareSaveEv, hikeStallDecision, reconcileShareSave, serverCompletedForTarget, zhsSharePopupPoints, zhsSharePrelearningNote, zhsShareSave } from '../src/providers/zhs/study.js';
import { WatchPoint, getEv, hikeSign, VIDEO_KEY, IV } from '../src/providers/zhs/crypto.js';
import { createCipheriv } from 'node:crypto';
import { createSessionHttp, SessionCookieJar } from '../src/http/client.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { FixtureInteraction } from './helpers/replay.js';
import { MemoryStateStore } from './helpers/memory.js';
import { JobRunner } from '../src/services/jobs.js';
import { createLearningClient } from '../src/index.js';
import { writeSession } from '../src/session/store.js';
import type { Runtime } from '../src/runtime/types.js';
import type { Json } from '../src/public.js';

describe('zhs study (T21, A211/A212)', () => {
  it('pauses a multi-resource share job at an unanswered popup instead of advancing the next video', async () => {
    const scope = { userId: 'local', profileId: 'p-multi', platform: 'zhs' as const };
    const first = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'first', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    const second = { ...first, key: 'second', native: { ...first.native, videoId: 'V2' } };
    const action = { kind: 'study' as const, resources: [first, second], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const clock = new FakeClock();
    const runner = new JobRunner(new MemoryStateStore(), clock);
    const job = await runner.create(scope, 'study', { total: 2, payload: action });
    let writes = 0;
    const stopped = await advanceShareStudy({ job, action, runner, clock, uuid: 'u1',
      readState: async () => ({ progress: { resource: first, serverCompleted: false, serverFraction: 0, serverSeconds: 0, durationSeconds: 10, observedAtMs: clock.nowMs() }, identity: { recruitId: '9', courseId: '44', ccCourseId: '55', videoSec: 10 } }),
      popupPoints: async () => [{ timeSec: 1 }], prelearningNote: async () => { writes += 1; return '77'; }, save: async () => { writes += 1; } });
    expect(stopped.status).toBe('needs-input');
    expect(stopped.items).toMatchObject([{ key: 'first', state: 'needs-input' }]);
    expect(writes).toBe(0);
  });

  it('keeps a share save pending when ACK succeeds but authoritative readback fails', async () => {
    const scope = { userId: 'local', profileId: 'p-pending', platform: 'zhs' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'video', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const clock = new FakeClock();
    const runner = new JobRunner(new MemoryStateStore(), clock);
    const job = await runner.create(scope, 'study', { total: 1, payload: action });
    await runner.setCursor(job.id, JSON.stringify({ resourceKey: 'video', noteId: '77', startedAtMs: clock.nowMs() - 5000, baseline: 0, awaiting: false, stalls: 0 }));
    let reads = 0;
    let saves = 0;
    const state = (seconds: number) => ({ progress: { resource, serverCompleted: false, serverFraction: seconds / 10, serverSeconds: seconds, durationSeconds: 10, observedAtMs: clock.nowMs() }, identity: { recruitId: '9', courseId: '44', ccCourseId: '55', videoSec: 10 } });
    await expect(advanceShareStudy({ job, action, runner, clock, uuid: 'u1', readState: async () => { reads += 1; if (reads > 1) throw Error('lost readback'); return state(0); }, popupPoints: async () => [], prelearningNote: async () => '77', save: async () => { saves += 1; } })).rejects.toThrow(/lost readback/);
    const uncertain = await runner.get(job.id);
    const pending = (await runner.metadata(job.id)).pendingOperationId;
    expect(uncertain.status).toBe('uncertain');
    expect(pending).toMatch(/^share-save:/);
    expect((await reconcileShareSave({ job: uncertain, action, runner, operationId: pending!, readState: async () => state(5) })).state).toBe('confirmed');
    expect((await runner.get(job.id)).status).toBe('paused');
    expect(saves).toBe(1);
  });

  it('share save ev encodes the 10-field order with watchPoint retained', () => {
    const wp = new WatchPoint();
    wp.add(10);
    expect(wp.get()).toBe('0,1,2,2,3,3,3');
    const ev = buildShareSaveEv({
      recruitId: '9',
      lessonId: '10',
      smallId: '0',
      videoId: 'V1',
      chapterId: '1',
      played: 10,
      lastSubmit: 0,
      videoSec: 30,
      uuid: 'u1',
    });
    expect(ev.sdsew).toBe(getEv(['9', '10', '0', 'V1', '1', '0', 10, 10, '0:00:10', 'u1zhs']));
    expect(ev.zwsds).toBe('');
    expect(ev.courseId).toBe('55');
  });

  it('hike stops after three no-progress server reads (needs-input)', () => {
    expect(hikeStallDecision([30, 30, 30])).toBe('needs-input');
    expect(hikeStallDecision([30, 60, 90])).toBe('continue');
    expect(hikeStallDecision([30, 30])).toBe('continue');
  });

  it('target 0.91 never forces serverCompleted (A211)', () => {
    expect(serverCompletedForTarget(0.91, 0.91)).toBe(false);
    expect(serverCompletedForTarget(1, 0.91)).toBe(true);
  });

  it('saves one elapsed hike second with a fixed-order signature and trusts server rt', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'zhs' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-hike' as const, courseId: '77' } }, key: 'video', native: { kind: 'zhs-hike' as const, fileId: 'f2' } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.1, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const runner = new JobRunner(new MemoryStateStore(), clock);
    const job = await runner.create(scope, 'study', { total: 1, payload: action, generation: 1 });
    const http = createSessionHttp({ transport, clock, jar: new SessionCookieJar(), allowHosts: ['zhihuishu.com'] });
    const progress = { request: { method: 'GET', host: 'studyresources.zhihuishu.com', path: '/studyResources/stuResouce/queryResourceMenuTree', query: { courseId: '77', _: String(clock.nowMs()) } }, response: { status: 200, body: { rt: [{ id: 'f2', dataType: 3, studyTime: 0, totalTime: 10, childList: [] }] } } };
    transport.scriptInteractions([progress]);
    const waiting = await advanceHikeStudy({ job, action, runner, http, clock, uuid: 'u-fixture' });
    expect(waiting.status).toBe('waiting');
    transport.assertNoExtraScripts();
    const startDate = clock.nowMs();
    clock.setNow(startDate + 1000);
    const secondProgress = { ...progress, request: { ...progress.request, query: { courseId: '77', _: String(clock.nowMs()) } } };
    const signature = hikeSign('u-fixture', '77', 'f2', 1, startDate, clock.nowMs(), 1, 0);
    const save = { request: { method: 'GET', host: 'hike-teaching.zhihuishu.com', path: '/stuStudy/saveStuStudyRecord', query: { uuid: 'u-fixture', courseId: '77', fileId: 'f2', studyTotalTime: '1', startWatchTime: '0', endWatchTime: '1', startDate: String(startDate), endDate: String(clock.nowMs()), signature, _: String(clock.nowMs()) } }, response: { status: 200, body: { status: 200, rt: 1 } } };
    transport.scriptInteractions([secondProgress, save]);
    const done = await advanceHikeStudy({ job: waiting, action, runner, http, clock, uuid: 'u-fixture' });
    expect(done.status).toBe('succeeded');
    expect(done.items[0]).toMatchObject({ key: 'video', state: 'succeeded' });
    transport.assertNoExtraScripts();
  });

  it('sends share save with VIDEO_KEY form fields and exact ev/watchPoint data', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const scope = { userId: 'local', profileId: 'p1', platform: 'zhs' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'video', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    const ids = { recruitId: '9', courseId: '44', ccCourseId: '55', videoSec: 30 };
    const wp = new WatchPoint(); wp.add(10);
    const sdsew = buildShareSaveEv({ recruitId: ids.recruitId, lessonId: '10', smallId: '0', videoId: 'V1', chapterId: '1', played: 10, lastSubmit: 0, videoSec: 30, uuid: 'u1' }).sdsew;
    const dateFormate = Math.trunc(clock.nowMs() / 1000) * 1000;
    const raw = JSON.stringify({ ewssw: wp.get(), sdsew, zwsds: 'Nzc=', courseId: '44', dateFormate });
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(VIDEO_KEY), Buffer.from(IV));
    const secret = Buffer.concat([cipher.update(Buffer.from(raw)), cipher.final()]).toString('base64');
    transport.scriptInteractions([{ request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/learning/saveDatabaseIntervalTimeV2', headers: { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1', 'content-type': 'application/x-www-form-urlencoded' }, body: `secretStr=${encodeURIComponent(secret)}&dateFormate=${dateFormate}` }, response: { status: 200, body: { code: 0, data: {} } } }]);
    const http = createSessionHttp({ transport, clock, jar: new SessionCookieJar(), allowHosts: ['zhihuishu.com'] });
    await zhsShareSave({ http, clock, resource, ids, uuid: 'u1', noteId: '77', played: 10, lastSubmit: 0, watchPoint: wp.get() });
    transport.assertNoExtraScripts();
  });

  it('pauses for share popup questions and otherwise saves only elapsed time with read-back', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'zhs' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'video', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    const action = { kind: 'study' as const, resources: [resource], settings: { speed: 1, targetFraction: 0.1, questionMode: 'pause' as const, maxDurationSeconds: 60 } };
    const clock = new FakeClock();
    const runner = new JobRunner(new MemoryStateStore(), clock);
    const job = await runner.create(scope, 'study', { total: 1, payload: action, generation: 1 });
    const state = (seconds: number) => ({ progress: { resource, serverCompleted: false, serverFraction: seconds / 10, serverSeconds: seconds, durationSeconds: 10, observedAtMs: clock.nowMs() }, identity: { recruitId: '9', courseId: '44', ccCourseId: '55', videoSec: 10 } });
    let reads = 0;
    let saves = 0;
    const deps = { runner, clock, uuid: 'u1', readState: async () => { reads += 1; return state(reads >= 3 ? 1 : 0); },
      popupPoints: async () => [] as Array<{ timeSec: number }>, prelearningNote: async () => '77',
      save: async (input: { played: number; lastSubmit: number; watchPoint: string }) => { saves += 1; expect(input.played).toBe(1); expect(input.lastSubmit).toBe(0); expect(input.watchPoint).toContain('0,1'); } };
    const waiting = await advanceShareStudy({ ...deps, job, action });
    expect(waiting.status).toBe('waiting');
    expect(saves).toBe(0);
    clock.setNow(clock.nowMs() + 1000);
    const done = await advanceShareStudy({ ...deps, job: waiting, action });
    expect(done.status).toBe('succeeded');
    expect(saves).toBe(1);
    const blockedRunner = new JobRunner(new MemoryStateStore(), clock);
    const blockedJob = await blockedRunner.create(scope, 'study', { total: 1, payload: action, generation: 1 });
    const blocked = await advanceShareStudy({ ...deps, runner: blockedRunner, job: blockedJob, action, readState: async () => state(0), popupPoints: async () => [{ timeSec: 1 }] });
    expect(blocked.status).toBe('needs-input');
  });

  it('queries popup points then opens a prelearning note with distinct read/write effects', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const scope = { userId: 'local', profileId: 'p1', platform: 'zhs' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'video', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    const ids = { recruitId: '9', courseId: '44', ccCourseId: '55', videoSec: 30 };
    const dateFormate = Math.trunc(clock.nowMs() / 1000) * 1000;
    const sealed = (text: string) => { const cipher = createCipheriv('aes-128-cbc', Buffer.from(VIDEO_KEY), Buffer.from(IV)); return `secretStr=${encodeURIComponent(Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]).toString('base64'))}&dateFormate=${dateFormate}`; };
    const headers = { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1', 'content-type': 'application/x-www-form-urlencoded' };
    transport.scriptInteractions([
      { request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/popupAnswer/loadVideoPointerInfo', headers, body: sealed(JSON.stringify({ lessonId: '10', lessonVideoId: '0', recruitId: '9', courseId: '55', dateFormate })) }, response: { status: 200, body: { code: 0, data: { questionPoint: [] } } } },
      { request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/learning/prelearningNote', headers, body: sealed(JSON.stringify({ ccCourseId: '55', chapterId: '1', isApply: 1, lessonId: '10', lessonVideoId: '0', recruitId: '9', videoId: 'V1', dateFormate })) }, response: { status: 200, body: { code: 0, data: { studiedLessonDto: { id: 77 } } } } },
    ]);
    const http = createSessionHttp({ transport, clock, jar: new SessionCookieJar(), allowHosts: ['zhihuishu.com'] });
    expect(await zhsSharePopupPoints(http, clock, resource, ids)).toEqual([]);
    expect(await zhsSharePrelearningNote(http, clock, resource, ids)).toBe('77');
    transport.assertNoExtraScripts();
  });

  it('drives one share save through the client facade and confirms watch state', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p1', platform: 'zhs' as const };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'video', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    const masterKey = new Uint8Array(32).fill(9);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: 'u1', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, clock, state, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const form = (data: Record<string, unknown>) => {
      const dateFormate = Math.trunc(clock.nowMs() / 1000) * 1000;
      const cipher = createCipheriv('aes-128-cbc', Buffer.from(VIDEO_KEY), Buffer.from(IV));
      const plain = JSON.stringify({ ...data, dateFormate });
      const sealed = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]).toString('base64');
      return `secretStr=${encodeURIComponent(sealed)}&dateFormate=${dateFormate}`;
    };
    const headers = { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1', 'content-type': 'application/x-www-form-urlencoded' };
    const post = (path: string, data: Record<string, unknown>, body: Json): FixtureInteraction => ({ request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: `/gateway/t/v1${path}`, headers, body: form(data) }, response: { status: 200, body } });
    const readState = (seconds: number): FixtureInteraction[] => [
      { request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/login/gologin', query: { fromurl: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1' } }, response: { status: 200, body: {} } },
      post('/learning/queryCourse', { recruitAndCourseId: 'R1' }, { code: 0, data: { recruitId: 9, courseInfo: { courseId: 44 } } }),
      post('/learning/videolist', { recruitAndCourseId: 'R1' }, { code: 0, data: { courseId: 55, videoChapterDtos: [{ id: 1, name: '章', videoLessons: [{ id: 10, name: '节', videoId: 'V1', videoSec: 10 }] }] } }),
      post('/learning/queryStuyInfo', { lessonIds: [10], lessonVideoIds: [], recruitId: 9 }, { code: 0, data: { lv: {}, lesson: { '10': { watchState: 0, studyTotalTime: seconds } } } }),
    ];
    const client = createLearningClient({ scope, runtime });
    transport.scriptInteractions(readState(0));
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 0.1, questionMode: 'pause', maxDurationSeconds: 60 } });
    transport.assertNoExtraScripts();
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing share job');
    transport.scriptInteractions([...readState(0),
      post('/popupAnswer/loadVideoPointerInfo', { lessonId: '10', lessonVideoId: '0', recruitId: '9', courseId: '55' }, { code: 0, data: { questionPoint: [] } }),
      post('/learning/prelearningNote', { ccCourseId: '55', chapterId: '1', isApply: 1, lessonId: '10', lessonVideoId: '0', recruitId: '9', videoId: 'V1' }, { code: 0, data: { studiedLessonDto: { id: 77 } } }),
    ]);
    expect((await client.jobs.advance(execution.job.id)).status).toBe('waiting');
    transport.assertNoExtraScripts();
    clock.setNow(clock.nowMs() + 1000);
    const wp = new WatchPoint(); wp.add(1);
    const sdsew = buildShareSaveEv({ recruitId: '9', lessonId: '10', smallId: '0', videoId: 'V1', chapterId: '1', played: 1, lastSubmit: 0, videoSec: 10, uuid: 'u1' }).sdsew;
    transport.scriptInteractions([...readState(0),
      post('/learning/saveDatabaseIntervalTimeV2', { ewssw: wp.get(), sdsew, zwsds: 'Nzc=', courseId: '44' }, { code: 0, data: {} }),
      ...readState(1),
    ]);
    expect((await client.jobs.advance(execution.job.id)).status).toBe('succeeded');
    transport.assertNoExtraScripts();
  });
});
