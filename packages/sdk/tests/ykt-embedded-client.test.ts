import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';

const scope = { userId: 'local', profileId: 'y-embed', platform: 'ykt' as const };
const resource = { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: null } };
const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 0, sku_id: 901, content_info: { media: { ccid: 'CC1', exercise_id: 888 } } } } } };
const list = (isRight: boolean) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/901/502/888/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>题</p>', Options: [{ key: 'A', value: '<p>甲</p>' }] }, user: { is_right: isRight } }] } } });

describe('Yuketang embedded exercise facade', () => {
  it('creates a draft and sends one explicit answer through the dedicated reply endpoint', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(5);
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.yuketang.cn/'), ['csrftoken=fixture; Path=/']);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const client = createLearningClient({ scope, runtime });
    transport.scriptInteractions([leaf, leaf, list(false)]);
    const refs = await client.assessments.resolve(resource);
    expect(refs).toMatchObject([{ kind: 'embedded', assessmentId: '888' }]);
    const draft = await client.assessments.draft(refs[0]!);
    draft.entries[0]!.answer = { kind: 'choice', keys: ['A'] };
    transport.assertNoExtraScripts();
    transport.scriptInteractions([leaf, list(false)]);
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['11'] });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.scriptInteractions([leaf, list(false), leaf, { request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/reply/11/', headers: { xtbz: 'ykt', 'x-csrftoken': 'fixture', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { exercise_id: 888, sku_id: 901, leaf_id: 502, answer: ['A'] } }, response: { status: 200, body: { success: true, data: { is_right: false, my_answer: ['A'] } } } }]);
    const receipt = await client.actions.execute(preview.id);
    expect(receipt).toMatchObject({ type: 'receipt', receipt: { state: 'confirmed', result: { isRight: false, correctAnswer: null } } });
    expect((await client.actions.execute(preview.id))).toEqual(receipt);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });
});
