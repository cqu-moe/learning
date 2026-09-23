import { describe, expect, it } from 'vitest';
import { encodeExamAnswer, examActionIndependent, xtxFinalizeExam } from '../src/providers/xuetang/exam-write.js';
import { createSessionHttp, SessionCookieJar } from '../src/http/client.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';

describe('xtx exam write (T17, A171/A172)', () => {
  it('keeps final submit a separate one-shot request after current-state preflight', async () => {
    const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
    const ref = { resource: { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } }, kind: 'exam' as const, assessmentId: '777001' };
    const transport = new FakeTransport();
    const cover = (status: number) => ({ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/cover', query: { exam_id: '777001' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { data: { result: { status }, user: { user_id: 77 } } } } } });
    const http = createSessionHttp({ transport, clock: new FakeClock(), jar: new SessionCookieJar(), allowHosts: ['xuetangx.com'] });
    transport.scriptInteractions([cover(2)]);
    await expect(xtxFinalizeExam(http, ref, '77', [{ problem_id: 11, result: ['A'], time: 1000 }])).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    transport.assertNoExtraScripts();
    const token = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/gen_token', headers: { xtbz: 'xt', 'content-type': 'application/json;charset=utf-8' }, body: { exam_id: '777001', classroom_id: '100', is_teacher: 0 } }, response: { status: 200, body: { success: true, data: { errcode: 0, data: { crypt: 'fixture-crypt', exam_host: 'https://examination.xuetangx.com' } } } } };
    const login = { request: { method: 'GET', host: 'examination.xuetangx.com', path: '/login', query: { exam_id: '777001', user_id: '77', crypt: 'fixture-crypt', next: 'https://examination.xuetangx.com/result/777001?isFrom=0', language: 'zh' } }, response: { status: 200, body: {} } };
    const submit = { request: { method: 'POST', host: 'examination.xuetangx.com', path: '/exam_room/submit_paper', headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' }, body: { results: [{ problem_id: 11, result: ['A'], time: 1000 }], exam_id: 777001 } }, response: { status: 200, body: { errcode: 0, data: { submitted: true } } } };
    transport.scriptInteractions([cover(1), token, login, submit]);
    await xtxFinalizeExam(http, ref, '77', [{ problem_id: 11, result: ['A'], time: 1000 }]);
    expect(transport.calls.filter((call) => call.url.includes('/exam_room/submit_paper'))).toHaveLength(1);
    transport.assertNoExtraScripts();
    transport.scriptInteractions([cover(1), token, login, { ...submit, response: { status: 503, body: { errcode: 0 } } }]);
    await expect(xtxFinalizeExam(http, ref, '77', [{ problem_id: 11, result: ['A'], time: 1000 }])).rejects.toThrow();
    expect(transport.calls.filter((call) => call.url.includes('/exam_room/submit_paper'))).toHaveLength(2);
    transport.assertNoExtraScripts();
  });

  it('rejects unverified fill-blank/short-answer encodings without any upstream write', () => {
    expect(() => encodeExamAnswer({ kind: 'short-answer', text: 'x' })).toThrow(expect.objectContaining({ data: expect.objectContaining({ code: 'UNSUPPORTED' }) }));
    expect(() => encodeExamAnswer({ kind: 'fill-blank', blanks: [{ id: '1', text: 'x' }] })).toThrow(expect.objectContaining({ data: expect.objectContaining({ code: 'UNSUPPORTED' }) }));
    expect(encodeExamAnswer({ kind: 'choice', keys: ['A'] })).toEqual(['A']);
    expect(encodeExamAnswer({ kind: 'judgement', value: false })).toEqual(['false']);
    expect(() => encodeExamAnswer({ kind: 'unset' })).toThrow(/unset/);
  });

  it('save and finalize are independent operations; save cannot implicitly start (A171/A172)', async () => {
    const calls: string[] = [];
    const result = await examActionIndependent({
      readState: async () => 'not-started',
      perform: async (action) => {
        calls.push(action);
        return { ok: true };
      },
      action: 'save',
    });
    expect(result.rejected).toBe(true);
    expect(calls).toHaveLength(0);

    const started = await examActionIndependent({
      readState: async () => 'in-progress',
      perform: async (action) => {
        calls.push(action);
        return { ok: true };
      },
      action: 'save',
    });
    expect(started.rejected).toBe(false);
    const finalized = await examActionIndependent({
      readState: async () => 'in-progress',
      perform: async (action) => {
        calls.push(action);
        return { ok: true };
      },
      action: 'finalize',
    });
    expect(finalized.rejected).toBe(false);
    expect(calls).toEqual(['save', 'finalize']);
  });

  it('already-final exams refuse further operations (A171)', async () => {
    const result = await examActionIndependent({
      readState: async () => 'submitted',
      perform: async () => ({ ok: true }),
      action: 'save',
    });
    expect(result.rejected).toBe(true);
  });
});
