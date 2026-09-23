import { LearningError } from '../../types/errors.js';
import type { Answer } from '../../types/models.js';
import type { SessionHttp } from '../../http/client.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';

export type XtxProblemType = 'SingleChoice' | 'MultiChoice' | 'Judgement' | 'FillInBlank' | 'ShortAnswer';

/** Type-dependent answer/answers mapping (X09) — never force everything into arrays. */
export function encodeXtxProblemAnswer(type: XtxProblemType | string, answer: Answer): { answer: string[] | string | Record<string, unknown>; answers: Record<string, string> } {
  if (answer.kind === 'unset') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'unset answers are never submitted', retryAfterMs: null, operationId: null });
  }
  switch (type) {
    case 'SingleChoice':
    case 'MultiChoice':
      if (answer.kind !== 'choice') throw new LearningError({ code: 'INVALID_INPUT', message: `${type} requires a choice answer`, retryAfterMs: null, operationId: null });
      return { answer: [...answer.keys].sort(), answers: {} };
    case 'Judgement':
      if (answer.kind !== 'judgement') throw new LearningError({ code: 'INVALID_INPUT', message: 'Judgement requires a boolean answer', retryAfterMs: null, operationId: null });
      return { answer: [String(answer.value)], answers: {} };
    case 'FillInBlank':
      if (answer.kind !== 'fill-blank') throw new LearningError({ code: 'INVALID_INPUT', message: 'FillInBlank requires blanks', retryAfterMs: null, operationId: null });
      return { answer: '', answers: Object.fromEntries(answer.blanks.map((blank) => [blank.id, blank.text])) };
    case 'ShortAnswer':
      if (answer.kind !== 'short-answer') throw new LearningError({ code: 'INVALID_INPUT', message: 'ShortAnswer requires text', retryAfterMs: null, operationId: null });
      return { answer: { time: Math.floor(Date.now() / 1000), content: `<p>${answer.text}</p>`, oSubject: 1 }, answers: {} };
    default:
      throw new LearningError({ code: 'UNSUPPORTED', message: `unverified xtx problem type ${String(type)}; refusing to submit`, retryAfterMs: null, operationId: null });
  }
}

export async function submitXtxProblem(http: SessionHttp, ids: { leafId: string; classroomId: string; exerciseId: string; problemId: string; courseSign: string }, type: string, answer: Answer): Promise<void> {
  const encoded = encodeXtxProblemAnswer(type, answer);
  const response = await http.request({
    kind: 'write',
    method: 'POST',
    url: `${XTX_BASE}/api/v1/lms/exercise/problem_apply/`,
    body: JSON.stringify({ leaf_id: ids.leafId, classroom_id: ids.classroomId, exercise_id: ids.exerciseId, problem_id: ids.problemId, sign: ids.courseSign, answers: encoded.answers, answer: encoded.answer }),
    headers: { ...XTX_BASE_HEADERS, 'content-type': 'application/json;charset=utf-8' },
  });
  const payload = (await response.json()) as { success?: boolean; msg?: string };
  if (payload.success !== true) {
    throw new LearningError({ code: 'PROTOCOL', message: `problem_apply failed: ${payload.msg ?? 'success=false'}`, retryAfterMs: null, operationId: null });
  }
}

export async function fetchUnitDiscussion(http: SessionHttp, classroomId: string, leafId: string, courseSign: string): Promise<{ topicId: string; text: string; commented: number }> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/api/v1/lms/forum/unit/discussion/?product_sign=${courseSign}&leaf_id=${leafId}&classroom_id=${classroomId}&topic_type=0&channel=xt`,
    headers: XTX_BASE_HEADERS,
  });
  const data = (await response.json()) as { id?: number | string; content?: { text?: string }; commented?: number };
  if (data.id === undefined) {
    throw new LearningError({ code: 'PROTOCOL', message: 'unit discussion returned no thread id', retryAfterMs: null, operationId: null });
  }
  return { topicId: String(data.id), text: (data.content?.text ?? '').trim(), commented: data.commented ?? 0 };
}

export async function postComment(http: SessionHttp, input: { classroomId: string; leafId: string; topicId: string; toUser: number; text: string }): Promise<void> {
  const response = await http.request({
    kind: 'write',
    method: 'POST',
    url: `${XTX_BASE}/api/v1/lms/forum/comment/?classroom_id=${input.classroomId}&leaf_id=${input.leafId}`,
    body: JSON.stringify({ topic_id: input.topicId, to_user: input.toUser, content: { text: input.text, upload_images: [] } }),
    headers: { ...XTX_BASE_HEADERS, 'content-type': 'application/json;charset=utf-8' },
  });
  const payload = (await response.json()) as { success?: boolean; msg?: string };
  if (payload.success === false) {
    throw new LearningError({ code: 'PROTOCOL', message: `post failed: ${payload.msg ?? ''}`, retryAfterMs: null, operationId: null });
  }
}
