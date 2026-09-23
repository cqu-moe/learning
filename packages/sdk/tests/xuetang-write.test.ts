import { describe, expect, it } from 'vitest';
import { encodeXtxProblemAnswer, submitXtxProblem, fetchUnitDiscussion, postComment } from '../src/providers/xuetang/homework-write.js';
import { SessionCookieJar, createSessionHttp } from '../src/http/client.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';

function httpFor(transport: FakeTransport) {
  return createSessionHttp({ transport, clock: new FakeClock(), jar: new SessionCookieJar(), allowHosts: ['xuetangx.com'] });
}

describe('xtx homework/discussion write (T16, A161/A162)', () => {
  it('maps answer fields per type: choice/judgement list, fill-blank map, subjective object', () => {
    expect(encodeXtxProblemAnswer('SingleChoice', { kind: 'choice', keys: ['A'] })).toEqual({ answer: ['A'], answers: {} });
    expect(encodeXtxProblemAnswer('MultiChoice', { kind: 'choice', keys: ['B', 'A'] })).toEqual({ answer: ['A', 'B'], answers: {} });
    expect(encodeXtxProblemAnswer('Judgement', { kind: 'judgement', value: true })).toEqual({ answer: ['true'], answers: {} });
    expect(encodeXtxProblemAnswer('FillInBlank', { kind: 'fill-blank', blanks: [{ id: '1', text: 'fixture answer' }] })).toEqual({ answer: '', answers: { '1': 'fixture answer' } });
    expect(encodeXtxProblemAnswer('ShortAnswer', { kind: 'short-answer', text: '主观内容' })).toEqual({
      answer: { time: '0', content: '<p>主观内容</p>', oSubject: { attachments: { filelist: [] } } },
      answers: {},
    });
    expect(encodeXtxProblemAnswer('Essay', { kind: 'short-answer', text: 'A < B & C\n下一行' }).answer).toEqual({ time: '0', content: '<p>A &lt; B &amp; C</p><p>下一行</p>', oSubject: { attachments: { filelist: [] } } });
    expect(() => encodeXtxProblemAnswer('SingleChoice', { kind: 'unset' })).toThrow(/unset/);
  });

  it('submits with the exact seven-field body (A161)', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: { success: true, data: { saved: true } } }]);
    await submitXtxProblem(httpFor(transport), { leafId: '7', classroomId: '100', exerciseId: '888', problemId: '11', courseSign: 'SIGN-A' }, 'FillInBlank', { kind: 'fill-blank', blanks: [{ id: '1', text: 'fixture answer' }] }, 'fixture-csrf');
    const body = JSON.parse(transport.calls[0]?.bodyText ?? '{}');
    expect(body).toEqual({ leaf_id: 7, classroom_id: 100, exercise_id: 888, problem_id: 11, sign: 'SIGN-A', answers: { '1': 'fixture answer' }, answer: '' });
    expect(transport.calls[0]?.headers['x-csrftoken']).toBe('fixture-csrf');
  });

  it('HTTP 200 success=false is a failure; unknown schemas cannot become an empty thread (A162)', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: { success: false, msg: 'not allowed' } }]);
    await expect(submitXtxProblem(httpFor(transport), { leafId: '7', classroomId: '100', exerciseId: '888', problemId: '11', courseSign: 'S' }, 'SingleChoice', { kind: 'choice', keys: ['A'] }, 'fixture-csrf')).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
    const forbidden = new FakeTransport();
    forbidden.script([{ status: 403, body: { success: true } }]);
    await expect(submitXtxProblem(httpFor(forbidden), { leafId: '7', classroomId: '100', exerciseId: '888', problemId: '11', courseSign: 'S' }, 'SingleChoice', { kind: 'choice', keys: ['A'] }, 'fixture-csrf')).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
    const empty = new FakeTransport();
    empty.script([{ status: 200, headers: {}, body: {} }]);
    await expect(fetchUnitDiscussion(httpFor(empty), '100', '7', 'SIGN-A')).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
  });

  it('posts a comment with query+body split and does not resend on failure', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: { success: true } }]);
    await postComment(httpFor(transport), { classroomId: '100', leafId: '7', topicId: '55', toUser: 0, text: '讨论内容' });
    const call = transport.calls[0]!;
    expect(call.url).toContain('/api/v1/lms/forum/comment/?classroom_id=100&leaf_id=7');
    expect(JSON.parse(call.bodyText ?? '{}')).toEqual({ topic_id: '55', to_user: 0, content: { text: '讨论内容', upload_images: [] } });
    const failing = new FakeTransport();
    failing.failNext(new Error('reset'));
    await expect(postComment(httpFor(failing), { classroomId: '100', leafId: '7', topicId: '55', toUser: 0, text: 'x' })).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(failing.calls).toHaveLength(1);
  });
});
