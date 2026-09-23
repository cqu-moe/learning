import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { sha256Hex } from '../src/types/sha256.js';
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
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/get_exercise_list/888001/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { problems: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>题</p>', Options: [{ key: 'A', value: '<p>甲</p>' }] } }] } } } },
      { request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/problem_apply/', headers: { xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': '28930736', 'content-type': 'application/json;charset=utf-8' }, body: { classroom_id: '28930736', problem_id: '11', answer: ['A'] } }, response: { status: 200, body: { success: true, data: { submitted: true } } } },
    ]);
    const rt = runtime(transport);
    await writeSession(rt.state, rt.masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: 'user', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: rt.clock.nowMs() });
    const client = createLearningClient({ scope, runtime: rt });
    const questionFingerprint = sha256Hex(JSON.stringify([11, 1, '<p>题</p>']));
    const draft = { schemaVersion: 1 as const, id: 'd1', ref, fingerprint: sha256Hex(JSON.stringify([questionFingerprint])), entries: [{ questionId: '11', fingerprint: questionFingerprint, answer: { kind: 'choice' as const, keys: ['A'] }, evidence: null }] };
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
});
