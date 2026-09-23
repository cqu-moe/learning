import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';

const scope = { userId: 'local', profileId: 'xhome', platform: 'xuetang' as const };
const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '900' } }, key: 'homework', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
const leaf = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 6, content_info: { leaf_type_id: 888 } } } } };
const exercise = (myCount = 0) => ({ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/exercise/get_exercise_list/888/900/', headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { exercise_id: 888, name: '作业', problems: [{ problem_id: 11, content: { Type: 'FillBlank', Body: '<p>填空</p>', Blanks: [{ Num: 1 }] }, user: { my_count: myCount } }] } } } });

async function setup() {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const state = new MemoryStateStore();
  const masterKey = new Uint8Array(32).fill(7);
  const jar = new SessionCookieJar();
  await jar.absorb(new URL('https://www.xuetangx.com/'), ['csrftoken=fixture-csrf; Path=/']);
  await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: clock.nowMs() });
  const runtime: Runtime = { transport, state, clock, masterKey,
    artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
    heavy: null, model: null, log: () => {}, wake: async () => {} };
  return { client: createLearningClient({ scope, runtime }), transport };
}

describe('Xuetang homework facade', () => {
  it('resolves, drafts and submits one verified fill blank answer only once', async () => {
    const { client, transport } = await setup();
    transport.scriptInteractions([leaf, exercise()]);
    const refs = await client.assessments.resolve(resource);
    expect(refs).toMatchObject([{ kind: 'homework', assessmentId: '888' }]);
    const draft = await client.assessments.draft(refs[0]!);
    expect(draft.entries).toHaveLength(1);
    draft.entries[0]!.answer = { kind: 'fill-blank', blanks: [{ id: '1', text: 'fixture answer' }] };
    transport.assertNoExtraScripts();
    transport.scriptInteractions([exercise(), { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/exercise/problem_apply/', headers: { xtbz: 'xt', 'x-csrftoken': 'fixture-csrf', 'content-type': 'application/json;charset=utf-8' }, body: { leaf_id: 7, classroom_id: 100, exercise_id: 888, problem_id: 11, sign: 'SIGN-A', answers: { '1': 'fixture answer' }, answer: '' } }, response: { status: 200, body: { success: true, data: { saved: true } } } }]);
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['11'] });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const first = await client.actions.execute(preview.id);
    expect(first).toMatchObject({ type: 'receipt', receipt: { state: 'confirmed' } });
    expect(await client.actions.execute(preview.id)).toEqual(first);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('refuses already submitted problems before any write', async () => {
    const { client, transport } = await setup();
    transport.scriptInteractions([leaf, exercise()]);
    const draft = await client.assessments.draft((await client.assessments.resolve(resource))[0]!);
    draft.entries[0]!.answer = { kind: 'fill-blank', blanks: [{ id: '1', text: 'fixture answer' }] };
    transport.scriptInteractions([exercise(1)]);
    await expect(client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['11'] })).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
  });
});
