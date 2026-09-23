import { LearningError } from '../../types/errors.js';
import type { Answer as AnswerType } from '../../types/models.js';
import type { SessionHttp } from '../../http/client.js';
import { moocEnvelopeChecked, YKT_BASE } from './schemas.js';

/** Strict answer encoding: unset/unknown/empty choices never reach the wire (A152). */
export function encodeHomeworkAnswer(answer: AnswerType): string[] {
  switch (answer.kind) {
    case 'choice':
      if (answer.keys.length === 0) {
        throw new LearningError({ code: 'INVALID_INPUT', message: 'choice answer needs at least one key', retryAfterMs: null, operationId: null });
      }
      return [...answer.keys].sort();
    case 'judgement':
      return [answer.value ? 'true' : 'false'];
    case 'fill-blank':
      return answer.blanks.map((blank) => blank.text);
    case 'short-answer':
      return [answer.text];
    case 'unset':
      throw new LearningError({ code: 'INVALID_INPUT', message: 'unset answers are never submitted', retryAfterMs: null, operationId: null });
    default:
      throw new LearningError({ code: 'UNSUPPORTED', message: 'unknown answer kind cannot be encoded', retryAfterMs: null, operationId: null });
  }
}

export async function submitHomeworkProblem(http: SessionHttp, classroomId: string, problemId: string, answer: AnswerType): Promise<{ submitted: boolean }> {
  const encoded = encodeHomeworkAnswer(answer);
  const response = await http.request({
    kind: 'write',
    method: 'POST',
    url: `${YKT_BASE}/mooc-api/v1/lms/exercise/problem_apply/`,
    body: JSON.stringify({ classroom_id: classroomId, problem_id: problemId, answer: encoded }),
    headers: { 'content-type': 'application/json;charset=utf-8', xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': classroomId },
  });
  const payload = (await response.json()) as { success?: boolean; msg?: string; data?: Record<string, unknown> };
  moocEnvelopeChecked(payload, 'problem_apply');
  return { submitted: true };
}

export interface EmbeddedProblem { problemId: string; problemType: number; body: string; options: Array<{ key: string; body: string }>; isRight: boolean }

export function parseEmbeddedList(payload: unknown): EmbeddedProblem[] {
  const body = (payload ?? {}) as { success?: boolean; msg?: string; data?: unknown };
  moocEnvelopeChecked(body, 'embedded list');
  if (body.success !== true) throw new LearningError({ code: 'PROTOCOL', message: 'embedded list lacks success acknowledgement', retryAfterMs: null, operationId: null });
  if (!Array.isArray(body.data)) throw new LearningError({ code: 'PROTOCOL', message: 'embedded list data is not a list', retryAfterMs: null, operationId: null });
  return body.data.map((raw: unknown) => {
    const problem = raw as { problem_id?: number | string; content?: { ProblemType?: number; Body?: string; Options?: Array<{ key?: string; value?: string }> }; user?: { is_right?: boolean } };
    const problemId = String(problem.problem_id ?? '');
    if (!/^[1-9]\d*$/.test(problemId) || !Number.isSafeInteger(Number(problemId))) throw new LearningError({ code: 'PROTOCOL', message: 'embedded problem has no valid id', retryAfterMs: null, operationId: null });
    return { problemId, problemType: problem.content?.ProblemType ?? -1, body: problem.content?.Body ?? '',
      options: (problem.content?.Options ?? []).map((option) => ({ key: option.key ?? '', body: option.value ?? '' })),
      isRight: problem.user?.is_right === true };
  });
}

export async function fetchEmbeddedList(http: SessionHttp, input: { classroomId: string; leafId: string; skuId: string; exerciseId: string }): Promise<EmbeddedProblem[]> {
  const response = await http.request({ kind: 'read', method: 'GET', url: `${YKT_BASE}/mooc-api/v1/lms/exercise/leaf_video/problem/${input.skuId}/${input.leafId}/${input.exerciseId}/?classroom_id=${input.classroomId}`, headers: { xtbz: 'ykt' } });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `embedded list returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  return parseEmbeddedList(await response.json());
}

export async function submitEmbeddedAnswer(http: SessionHttp, ids: { classroomId: string; leafId: string; skuId: string; exerciseId: string; problemId: string }, answer: AnswerType, csrfToken: string): Promise<{ submitted: boolean; isRight: boolean; correctAnswer: string[] | null }> {
  const encoded = encodeHomeworkAnswer(answer);
  const integer = (raw: string): number => {
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new LearningError({ code: 'INVALID_INPUT', message: 'embedded id is invalid', retryAfterMs: null, operationId: null });
    return value;
  };
  if (csrfToken === '') throw new LearningError({ code: 'AUTH_REQUIRED', message: 'Yuketang CSRF cookie is missing', retryAfterMs: null, operationId: null });
  const response = await http.request({
    kind: 'write',
    method: 'POST',
    url: `${YKT_BASE}/mooc-api/v1/lms/exercise/leaf_video/problem/reply/${ids.problemId}/`,
    body: JSON.stringify({ exercise_id: integer(ids.exerciseId), sku_id: integer(ids.skuId), leaf_id: integer(ids.leafId), answer: encoded }),
    headers: { 'content-type': 'application/json;charset=utf-8', xtbz: 'ykt', 'classroom-id': ids.classroomId, 'x-csrftoken': csrfToken, 'x-requested-with': 'XMLHttpRequest' },
  });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `embedded reply returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = (await response.json()) as { success?: boolean; msg?: string; data?: { is_right?: boolean; answer?: string[] } };
  moocEnvelopeChecked(payload, 'embedded answer');
  if (payload.success !== true) throw new LearningError({ code: 'PROTOCOL', message: 'embedded reply lacks success acknowledgement', retryAfterMs: null, operationId: null });
  if (typeof payload.data?.is_right !== 'boolean') throw new LearningError({ code: 'PROTOCOL', message: 'embedded reply lacks is_right', retryAfterMs: null, operationId: null });
  return { submitted: true, isRight: payload.data.is_right, correctAnswer: payload.data.is_right && Array.isArray(payload.data.answer) ? payload.data.answer : null };
}
