import { LearningError } from '../../types/errors.js';
import type { CourseRef } from '../../types/refs.js';
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

export interface EmbeddedProblem { problemId: string; body: string; options: Array<{ key: string; body: string }> }

export function parseEmbeddedList(payload: unknown): EmbeddedProblem[] {
  const body = (payload ?? {}) as { success?: boolean; msg?: string; data?: { problems?: Array<{ problemId?: string; question?: { body?: string; options?: Array<{ key?: string; body?: string }> } }> } };
  moocEnvelopeChecked(body, 'embedded list');
  return (body.data?.problems ?? []).map((problem) => ({
    problemId: problem.problemId ?? '',
    body: problem.question?.body ?? '',
    options: (problem.question?.options ?? []).map((option) => ({ key: option.key ?? '', body: option.body ?? '' })),
  }));
}

export async function submitEmbeddedAnswer(http: SessionHttp, course: CourseRef, problemId: string, answer: AnswerType): Promise<{ submitted: boolean; correctAnswer: string[] | null }> {
  if (course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'embedded answers require ykt refs', retryAfterMs: null, operationId: null });
  }
  const encoded = encodeHomeworkAnswer(answer);
  const response = await http.request({
    kind: 'write',
    method: 'POST',
    url: `${YKT_BASE}/mooc-api/v1/lms/exercise/problem_apply/`,
    body: JSON.stringify({ classroom_id: course.native.classroomId, problem_id: problemId, answer: encoded }),
    headers: { 'content-type': 'application/json;charset=utf-8', xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': course.native.classroomId },
  });
  const payload = (await response.json()) as { success?: boolean; msg?: string; data?: { correct?: string[] } };
  moocEnvelopeChecked(payload, 'embedded answer');
  // success=true does NOT mean correct; correctAnswer comes only from explicit feedback fields.
  return { submitted: true, correctAnswer: null };
}
