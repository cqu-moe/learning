import { describe, expect, it } from 'vitest';
import { encodeHomeworkAnswer, submitHomeworkProblem, submitEmbeddedAnswer, parseEmbeddedList } from '../src/providers/ykt/homework-write.js';
import { SessionCookieJar, createSessionHttp } from '../src/http/client.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';

function httpFor(transport: FakeTransport) {
  return createSessionHttp({ transport, clock: new FakeClock(), jar: new SessionCookieJar(), allowHosts: ['yuketang.cn', 'xuetangx.com'] });
}

describe('ykt homework write (T15, A151/A152)', () => {
  it('encodes answers strictly: unset/unknown/invalid choices are rejected before any request', () => {
    expect(encodeHomeworkAnswer({ kind: 'choice', keys: ['A'] })).toEqual(['A']);
    expect(encodeHomeworkAnswer({ kind: 'choice', keys: ['B', 'A'] })).toEqual(['A', 'B']);
    expect(encodeHomeworkAnswer({ kind: 'judgement', value: true })).toEqual(['true']);
    expect(() => encodeHomeworkAnswer({ kind: 'unset' })).toThrow(/unset/);
    expect(() => encodeHomeworkAnswer({ kind: 'unknown' as never })).toThrow();
    expect(() => encodeHomeworkAnswer({ kind: 'choice', keys: [] })).toThrow(/choice/);
  });

  it('submits with the exact body and full header set; wrong-platform objects fail the schema', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: { success: true, data: { submitted: true } } }]);
    const result = await submitHomeworkProblem(httpFor(transport), '28930736', '11', { kind: 'choice', keys: ['A'] });
    expect(result).toMatchObject({ submitted: true });
    const call = transport.calls[0]!;
    expect(call.url).toContain('/mooc-api/v1/lms/exercise/problem_apply/');
    expect(call.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(JSON.parse(call.bodyText ?? '{}')).toEqual({ classroom_id: '28930736', problem_id: '11', answer: ['A'] });
  });

  it('submit failure surfaces as error, not as a fake success', async () => {
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: { success: false, msg: 'locked' } }]);
    await expect(submitHomeworkProblem(httpFor(transport), '28930736', '11', { kind: 'choice', keys: ['A'] })).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
  });

  it('embedded list and dedicated reply use the video protocol without fabricating wrong-answer feedback (A152)', async () => {
    const embedded = parseEmbeddedList({ success: true, data: [
      { problem_id: 11, content: { ProblemType: 1, Body: '<p>题</p>', Options: [{ key: 'A', value: '<p>a</p>' }] }, user: { is_right: false } },
    ] });
    expect(embededLength(embedded)).toBe(1);
    const transport = new FakeTransport();
    transport.scriptInteractions([{ request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/reply/11/', headers: { xtbz: 'ykt', 'classroom-id': '28930736', 'x-csrftoken': 'fixture', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { exercise_id: 888, sku_id: 901, leaf_id: 502, answer: ['A'] } }, response: { status: 200, body: { success: true, data: { is_right: false, my_answer: ['A'] } } } }]);
    const result = await submitEmbeddedAnswer(httpFor(transport), { classroomId: '28930736', leafId: '502', skuId: '901', exerciseId: '888', problemId: '11' }, { kind: 'choice', keys: ['A'] }, 'fixture');
    expect(result.submitted).toBe(true);
    expect(result.correctAnswer).toBeNull();
    expect(result.isRight).toBe(false);
    transport.assertNoExtraScripts();
    expect(() => parseEmbeddedList({ success: true, data: { problems: [] } })).toThrow(/list/);
    const dropped = new FakeTransport();
    dropped.failNext(new Error('connection reset after send'));
    await expect(submitEmbeddedAnswer(httpFor(dropped), { classroomId: '28930736', leafId: '502', skuId: '901', exerciseId: '888', problemId: '11' }, { kind: 'choice', keys: ['A'] }, 'fixture')).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(dropped.calls).toHaveLength(1);
  });
});

function embededLength(list: unknown[]): number {
  return list.length;
}
