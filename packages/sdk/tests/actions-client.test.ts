import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { sha256Hex } from '../src/types/sha256.js';
import { hikeSign } from '../src/providers/zhs/crypto.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { ActionInput, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'p1', platform: 'ykt' };
const ref = { resource: { course: { scope, key: 'k', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'r', native: { kind: 'ykt' as const, leafId: '505', leafInfoId: null } }, kind: 'homework' as const, assessmentId: '888001' };

function runtime(transport: FakeTransport): Runtime {
  return { transport, state: new MemoryStateStore(), clock: new FakeClock(), masterKey: new Uint8Array(32).fill(5),
    artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
    heavy: null, model: null, log: () => {}, wake: async () => {} };
}

describe('client action facade', () => {
  it('previews one verified homework answer and sends exactly once', async () => {
    const transport = new FakeTransport();
    const read = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/get_exercise_list/888001/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { problems: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>题</p>', Options: [{ key: 'A', value: '<p>甲</p>' }] } }] } } } };
    transport.scriptInteractions([
      read,
      read,
      read,
      { request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/problem_apply/', headers: { xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': '28930736', 'content-type': 'application/json;charset=utf-8' }, body: { classroom_id: '28930736', problem_id: '11', answer: ['A'] } }, response: { status: 200, body: { success: true, data: { submitted: true } } } },
    ]);
    const rt = runtime(transport);
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: 'user', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: rt.clock.nowMs() });
    const client = createLearningClient({ scope, runtime: rt });
    const seeded = await client.assessments.draft(ref);
    const entry = seeded.entries.find((item) => item.questionId === '11');
    if (entry === undefined) throw Error('homework fixture has no question 11');
    const draft = { ...seeded, id: 'd1', entries: [{ ...entry, answer: { kind: 'choice' as const, keys: ['A'] } }] };
    const action: ActionInput = { kind: 'homework.apply', draft, questionIds: ['11'] };
    const preview = await client.actions.prepare(action);
    expect(preview.kind).toBe('homework.apply');
    const first = await client.actions.execute(preview.id);
    const second = await client.actions.execute(preview.id);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ type: 'receipt', receipt: { state: 'confirmed' } });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('previews one Xuetang discussion post and submits it exactly once', async () => {
    const xtxScope = { userId: 'local', profileId: 'p2', platform: 'xuetang' as const };
    const resource = { course: { scope: xtxScope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'resource', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const transport = new FakeTransport();
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/unit/discussion/', query: { product_sign: 'SIGN-A', leaf_id: '7', classroom_id: '100', topic_type: '0', channel: 'xt' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { id: 55, user_id: 77, content: { text: '主题' }, commented: 0 } } },
      { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/comment/', query: { classroom_id: '100', leaf_id: '7' }, headers: { xtbz: 'xt', 'content-type': 'application/json;charset=utf-8' }, body: { topic_id: '55', to_user: 77, content: { text: '我的回复', upload_images: [] } } }, response: { status: 200, body: { success: true, data: { id: 9 } } } },
    ]);
    const rt = runtime(transport);
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope: xtxScope, generation: 1, platformUserId: '88', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: rt.clock.nowMs() });
    const client = createLearningClient({ scope: xtxScope, runtime: rt });
    const draft = { id: 'discussion-55', ref: { resource, topicId: '55' }, text: '我的回复', sourceHash: sha256Hex('主题'), origin: 'user' as const };
    const preview = await client.actions.prepare({ kind: 'discussion.post', draft });
    expect(preview.kind).toBe('discussion.post');
    expect((await client.actions.execute(preview.id)).type).toBe('receipt');
    expect((await client.actions.execute(preview.id)).type).toBe('receipt');
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('keeps Xuetang exam start separate from save and sends start only after preview', async () => {
    const xtxScope = { userId: 'local', profileId: 'p3', platform: 'xuetang' as const };
    const resource = { course: { scope: xtxScope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam-resource', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
    const ref = { resource, kind: 'exam' as const, assessmentId: '777001' };
    const transport = new FakeTransport();
    const cover = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/cover', query: { exam_id: '777001' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { data: { show_perm: 1, result: { status: 0 }, user: { user_id: 88 } } } } } };
    transport.scriptInteractions([
      cover, cover,
      { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/gen_token', headers: { xtbz: 'xt', 'content-type': 'application/json;charset=utf-8' }, body: { exam_id: '777001', classroom_id: '100', is_teacher: 0 } }, response: { status: 200, body: { success: true, data: { errcode: 0, data: { crypt: 'fixture-crypt', exam_host: 'https://examination.xuetangx.com' } } } } },
      { request: { method: 'GET', host: 'examination.xuetangx.com', path: '/login', query: { exam_id: '777001', user_id: '88', crypt: 'fixture-crypt', next: 'https://examination.xuetangx.com/result/777001?isFrom=0', language: 'zh' } }, response: { status: 200, body: {} } },
      { request: { method: 'POST', host: 'examination.xuetangx.com', path: '/exam_room/start_paper', headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' }, body: { exam_id: 777001 } }, response: { status: 200, body: { errcode: 0, data: { started: true } } } },
    ]);
    const rt = runtime(transport);
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope: xtxScope, generation: 1, platformUserId: '88', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: rt.clock.nowMs() });
    const client = createLearningClient({ scope: xtxScope, runtime: rt });
    const preview = await client.actions.prepare({ kind: 'exam.start', ref });
    expect(preview.startsTimer).toBe(true);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect((await client.actions.execute(preview.id)).type).toBe('receipt');
    expect(transport.calls.filter((call) => call.url.includes('/exam_room/start_paper'))).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('saves only verified choice answers to an in-progress Xuetang exam', async () => {
    const xtxScope = { userId: 'local', profileId: 'p4', platform: 'xuetang' as const };
    const resource = { course: { scope: xtxScope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam-resource', native: { kind: 'xuetang' as const, leafId: '30', leafInfoId: null } };
    const ref = { resource, kind: 'exam' as const, assessmentId: '3908258' };
    const q1 = sha256Hex(JSON.stringify([1, 'SingleChoice', '<p>选对的</p>']));
    const q9 = sha256Hex(JSON.stringify([9, 'WeirdNewType', '<p>?</p>']));
    const draft = { schemaVersion: 1 as const, id: 'draft-3908258', ref, fingerprint: sha256Hex(JSON.stringify([q1, q9])), entries: [
      { questionId: '1', fingerprint: q1, answer: { kind: 'choice' as const, keys: ['A'] }, evidence: null },
      { questionId: '9', fingerprint: q9, answer: { kind: 'unset' as const }, evidence: null },
    ] };
    const transport = new FakeTransport();
    const cover = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/cover', query: { exam_id: '3908258' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { data: { show_perm: 1, result: { status: 1 }, user: { user_id: 77 } } } } } };
    const token = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/gen_token', headers: { xtbz: 'xt', 'content-type': 'application/json;charset=utf-8' }, body: { exam_id: '3908258', classroom_id: '100', is_teacher: 0 } }, response: { status: 200, body: { success: true, data: { errcode: 0, data: { crypt: 'fixture-crypt', exam_host: 'https://examination.xuetangx.com' } } } } };
    const login = { request: { method: 'GET', host: 'examination.xuetangx.com', path: '/login', query: { exam_id: '3908258', user_id: '77', crypt: 'fixture-crypt', next: 'https://examination.xuetangx.com/result/3908258?isFrom=0', language: 'zh' } }, response: { status: 200, body: {} } };
    const paper = { request: { method: 'GET', host: 'examination.xuetangx.com', path: '/exam_room/show_paper', query: { exam_id: '3908258' }, headers: { xtbz: 'cloud', 'x-client': 'web' } }, response: { status: 200, body: { errcode: 0, data: { problems: [
      { problem_id: 1, Problem: { ProblemType: 'SingleChoice', Body: '<p>选对的</p>', Options: [{ Key: 'A', Value: '<p>甲</p>' }] } },
      { problem_id: 9, Problem: { ProblemType: 'WeirdNewType', Body: '<p>?</p>', Options: [] } },
    ] } } } };
    const results = { request: { method: 'GET', host: 'examination.xuetangx.com', path: '/exam_room/problem_results', query: { exam_id: '3908258' }, headers: { xtbz: 'cloud', 'x-client': 'web' } }, response: { status: 200, body: { errcode: 0, data: { results: [] } } } };
    const rt = runtime(transport);
    transport.scriptInteractions([cover, token, login, paper, results, cover, token, login,
      { request: { method: 'POST', host: 'examination.xuetangx.com', path: '/exam_room/answer_problem', headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' }, body: { results: [{ problem_id: 1, result: ['A'], time: rt.clock.nowMs() }], exam_id: 3908258, record: [] } }, response: { status: 200, body: { errcode: 0, data: { saved: true } } } },
    ]);
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope: xtxScope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: rt.clock.nowMs() });
    const client = createLearningClient({ scope: xtxScope, runtime: rt });
    const preview = await client.actions.prepare({ kind: 'exam.save', draft });
    expect(preview.finalSubmission).toBe(false);
    expect(transport.calls.filter((call) => call.url.includes('/exam_room/answer_problem'))).toHaveLength(0);
    expect((await client.actions.execute(preview.id)).type).toBe('receipt');
    expect(transport.calls.filter((call) => call.url.includes('/exam_room/answer_problem'))).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('keeps final submission blocked until independent E05 verification exists', async () => {
    const xtxScope = { userId: 'local', profileId: 'p5', platform: 'xuetang' as const };
    const transport = new FakeTransport();
    const rt = runtime(transport);
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope: xtxScope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: rt.clock.nowMs() });
    const resource = { course: { scope: xtxScope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam-resource', native: { kind: 'xuetang' as const, leafId: '30', leafInfoId: null } };
    const draft = { schemaVersion: 1 as const, id: 'draft-1', ref: { resource, kind: 'exam' as const, assessmentId: '3908258' }, fingerprint: 'fingerprint', entries: [] };
    const client = createLearningClient({ scope: xtxScope, runtime: rt });
    const preview = await client.actions.prepare({ kind: 'exam.finalize', draft });
    expect(preview.finalSubmission).toBe(true);
    expect(preview.blockers.join(' ')).toContain('E05');
    await expect(client.actions.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNSUPPORTED' } });
    expect(transport.calls).toHaveLength(0);
  });

  it('creates and advances a verified ZHS hike job through the client facade', async () => {
    const zhsScope = { userId: 'local', profileId: 'p6', platform: 'zhs' as const };
    const resource = { course: { scope: zhsScope, key: 'course', native: { kind: 'zhs-hike' as const, courseId: '77' } }, key: 'video', native: { kind: 'zhs-hike' as const, fileId: 'f2' } };
    const transport = new FakeTransport();
    const rt = runtime(transport);
    const clock = rt.clock as FakeClock;
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope: zhsScope, generation: 1, platformUserId: 'u-fixture', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const progress = () => ({ request: { method: 'GET', host: 'studyresources.zhihuishu.com', path: '/studyResources/stuResouce/queryResourceMenuTree', query: { courseId: '77', _: String(clock.nowMs()) } }, response: { status: 200, body: { rt: [{ id: 'f2', dataType: 3, studyTime: 0, totalTime: 10, childList: [] }] } } });
    transport.scriptInteractions([progress()]);
    const client = createLearningClient({ scope: zhsScope, runtime: rt });
    const preview = await client.actions.prepare({ kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 0.1, questionMode: 'pause', maxDurationSeconds: 60 } });
    const execution = await client.actions.execute(preview.id);
    expect(execution.type).toBe('job');
    if (execution.type !== 'job') throw Error('missing job');
    transport.assertNoExtraScripts();
    transport.scriptInteractions([progress()]);
    const waiting = await client.jobs.advance(execution.job.id);
    expect(waiting.status).toBe('waiting');
    transport.assertNoExtraScripts();
    const startDate = clock.nowMs();
    clock.setNow(startDate + 1000);
    const signature = hikeSign('u-fixture', '77', 'f2', 1, startDate, clock.nowMs(), 1, 0);
    transport.scriptInteractions([progress(), { request: { method: 'GET', host: 'hike-teaching.zhihuishu.com', path: '/stuStudy/saveStuStudyRecord', query: { uuid: 'u-fixture', courseId: '77', fileId: 'f2', studyTotalTime: '1', startWatchTime: '0', endWatchTime: '1', startDate: String(startDate), endDate: String(clock.nowMs()), signature, _: String(clock.nowMs()) } }, response: { status: 200, body: { status: 200, rt: 1 } } }]);
    expect((await client.jobs.advance(execution.job.id)).status).toBe('succeeded');
    transport.assertNoExtraScripts();
  });
});
