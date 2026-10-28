import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { AnswerDraft, AssessmentRef, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'p1', platform: 'ykt' };
const ref: AssessmentRef = {
  resource: {
    course: { scope, key: 'course', native: { kind: 'ykt', classroomId: '28930736' } },
    key: 'resource',
    native: { kind: 'ykt', leafId: '505', leafInfoId: null },
  },
  kind: 'homework',
  assessmentId: '888001',
};

function runtime(transport: FakeTransport): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    clock: new FakeClock(),
    masterKey: new Uint8Array(32).fill(5),
    artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

async function makeClient(transport: FakeTransport, generation = 1) {
  const rt = runtime(transport);
  await writeSession(rt.state, rt.masterKey, {
    schemaVersion: 1,
    scope,
    generation,
    platformUserId: '424242',
    identityVerified: true,
    cookieJar: await new SessionCookieJar().serialize(),
    displayName: null,
    checkedAtMs: rt.clock.nowMs(),
  });
  return { client: createLearningClient({ scope, runtime: rt }), rt };
}

function rawProblem(input: { id: number; type: number; body: string; options?: Array<[string, string]>; myCount?: number }) {
  return {
    problem_id: input.id,
    content: {
      ProblemType: input.type,
      Body: input.body,
      Options: input.options?.map(([key, value]) => ({ key, value })) ?? [],
    },
    user: { my_count: input.myCount ?? 0 },
  };
}

function readInteraction(problems: ReturnType<typeof rawProblem>[]) {
  return {
    request: {
      method: 'GET',
      host: 'www.yuketang.cn',
      path: '/mooc-api/v1/lms/exercise/get_exercise_list/888001/',
      query: { classroom_id: '28930736' },
      headers: { xtbz: 'ykt' },
    },
    response: { status: 200, body: { success: true, data: { name: '作业', problems } } },
  };
}

function postInteraction(answer: string[], problemId = '12') {
  return {
    request: {
      method: 'POST',
      host: 'www.yuketang.cn',
      path: '/mooc-api/v1/lms/exercise/problem_apply/',
      headers: { xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': '28930736', 'content-type': 'application/json;charset=utf-8' },
      body: { classroom_id: '28930736', problem_id: problemId, answer },
    },
    response: { status: 200, body: { success: true, data: { submitted: true } } },
  };
}

function answerDraft(draft: AnswerDraft, questionId: string, answer: AnswerDraft['entries'][number]['answer']): AnswerDraft {
  const entry = draft.entries.find((item) => item.questionId === questionId);
  if (entry === undefined) throw Error(`homework fixture has no question ${questionId}`);
  return {
    ...draft,
    entries: draft.entries.map((item) => item.questionId === questionId ? { ...item, answer } : item),
  };
}

describe('Yuketang regular homework apply safety', () => {
  it('prepares an unchanged complete question when another question changed', async () => {
    const transport = new FakeTransport();
    const oldRead = readInteraction([
      rawProblem({ id: 11, type: 99, body: '<p>old unrelated question</p>' }),
      rawProblem({ id: 12, type: 1, body: '<p>selected question</p>', options: [['A', '甲'], ['B', '乙']] }),
    ]);
    const currentRead = readInteraction([
      rawProblem({ id: 11, type: 99, body: '<p>changed unrelated question</p>' }),
      rawProblem({ id: 12, type: 1, body: '<p>selected question</p>', options: [['A', '甲'], ['B', '乙']] }),
    ]);
    transport.scriptInteractions([oldRead, currentRead, currentRead, postInteraction(['B'])]);
    const { client } = await makeClient(transport);

    const draft = answerDraft(await client.assessments.draft(ref), '12', { kind: 'choice', keys: ['B'] });
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['12'] });
    const receipt = await client.actions.execute(preview.id);

    expect(receipt).toMatchObject({ type: 'receipt', receipt: { state: 'confirmed' } });
    expect(transport.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    transport.assertNoExtraScripts();
  });

  it('runs a fresh read before execution and rejects a changed selected question', async () => {
    const transport = new FakeTransport();
    const initialRead = readInteraction([rawProblem({ id: 12, type: 1, body: '<p>initial question</p>', options: [['A', '甲']] })]);
    const changedRead = readInteraction([rawProblem({ id: 12, type: 1, body: '<p>changed question</p>', options: [['A', '甲']] })]);
    transport.scriptInteractions([initialRead, initialRead, changedRead]);
    const { client } = await makeClient(transport);
    const draft = answerDraft(await client.assessments.draft(ref), '12', { kind: 'choice', keys: ['A'] });
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['12'] });

    await expect(client.actions.execute(preview.id)).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
  });

  it('rejects on the fresh read when my_count shows the problem was already submitted', async () => {
    const read = (myCount: number) => readInteraction([rawProblem({ id: 12, type: 1, body: '<p>question</p>', options: [['A', '甲']], myCount })]);
    const transport = new FakeTransport();
    transport.scriptInteractions([read(0), read(0), read(1)]);
    const { client } = await makeClient(transport);
    const draft = answerDraft(await client.assessments.draft(ref), '12', { kind: 'choice', keys: ['A'] });
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['12'] });

    await expect(client.actions.execute(preview.id)).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED', message: expect.stringContaining('already submitted') } });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
  });

  it('validates choice keys, single-choice cardinality, and non-empty fill blanks', async () => {
    const cases = [
      { type: 1, body: '<p>single</p>', options: [['A', '甲'], ['B', '乙']], answer: { kind: 'choice' as const, keys: ['A', 'B'] } },
      { type: 2, body: '<p>multi</p>', options: [['A', '甲'], ['C', '丙']], answer: { kind: 'choice' as const, keys: ['B'] } },
      { type: 4, body: '<p>blank</p>', options: [] as Array<[string, string]>, answer: { kind: 'fill-blank' as const, blanks: [{ id: '1', text: ' ' }] } },
    ];
    for (const item of cases) {
      const transport = new FakeTransport();
      const read = readInteraction([rawProblem({ id: 12, type: item.type, body: item.body, options: item.options.map((option) => option as [string, string]) })]);
      transport.scriptInteractions([read, read]);
      const { client } = await makeClient(transport);
      const draft = answerDraft(await client.assessments.draft(ref), '12', item.answer);

      await expect(client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['12'] })).rejects.toMatchObject({ data: { code: 'INVALID_INPUT' } });
      expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      transport.assertNoExtraScripts();
    }
  });

  it('keeps a lost apply response uncertain without replaying it', async () => {
    const transport = new FakeTransport();
    const read = readInteraction([rawProblem({ id: 12, type: 1, body: '<p>question</p>', options: [['A', '甲']] })]);
    transport.scriptInteractions([read, read, read]);
    const { client } = await makeClient(transport);
    const draft = answerDraft(await client.assessments.draft(ref), '12', { kind: 'choice', keys: ['A'] });
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['12'] });
    transport.failNext(new Error('connection reset after problem_apply'));

    await expect(client.actions.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    await expect(client.actions.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('keeps preview bound to the current session generation', async () => {
    const transport = new FakeTransport();
    const read = readInteraction([rawProblem({ id: 12, type: 1, body: '<p>question</p>', options: [['A', '甲']] })]);
    transport.scriptInteractions([read, read]);
    const { client, rt } = await makeClient(transport);
    const draft = answerDraft(await client.assessments.draft(ref), '12', { kind: 'choice', keys: ['A'] });
    const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: ['12'] });
    await writeSession(rt.state, rt.masterKey, {
      schemaVersion: 1,
      scope,
      generation: 2,
      platformUserId: '424242',
      identityVerified: true,
      cookieJar: await new SessionCookieJar().serialize(),
      displayName: null,
      checkedAtMs: rt.clock.nowMs(),
    });

    await expect(client.actions.execute(preview.id)).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    expect(transport.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    transport.assertNoExtraScripts();
  });
});
