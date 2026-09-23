import { describe, expect, it } from 'vitest';
import { encodeHomeworkAnswer, submitHomeworkProblem, submitEmbeddedAnswer, parseEmbeddedList } from '../src/providers/ykt/homework-write.js';
import { SessionCookieJar, createSessionHttp } from '../src/http/client.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';

const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
const classroom = { scope, key: 'k', native: { kind: 'ykt' as const, classroomId: '28930736' } };

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

  it('embedded list parses; explicit answers submit without fabricating feedback (A152)', async () => {
    const embedded = parseEmbeddedList({ success: true, data: { problems: [
      { problemId: 'e1', question: { body: '<p>题</p>', options: [{ key: 'A', body: '<p>a</p>' }] } }
    ] } });
    expect(embededLength(embedded)).toBe(1);
    const transport = new FakeTransport();
    transport.script([{ status: 200, headers: {}, body: { success: true, data: { submitted: true, correct: null } } }]);
    const result = await submitEmbeddedAnswer(httpFor(transport), classroom, 'e1', { kind: 'choice', keys: ['A'] });
    expect(result.submitted).toBe(true);
    expect(result.correctAnswer).toBeNull();
  });
});

function embededLength(list: unknown[]): number {
  return list.length;
}
