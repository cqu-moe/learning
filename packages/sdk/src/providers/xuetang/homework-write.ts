import { LearningError } from '../../types/errors.js';
import type { Answer } from '../../types/models.js';
import type { SessionHttp } from '../../http/client.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';

export type XtxProblemType = 'SingleChoice' | 'MultiChoice' | 'Judgement' | 'FillInBlank' | 'ShortAnswer';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Type-dependent answer/answers mapping (X09) — never force everything into arrays. */
export function encodeXtxProblemAnswer(type: XtxProblemType | string, answer: Answer): { answer: string[] | string | Record<string, unknown>; answers: Record<string, string> } {
  if (answer.kind === 'unset') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'unset answers are never submitted', retryAfterMs: null, operationId: null });
  }
  switch (type.trim().toLowerCase()) {
    case 'singlechoice':
    case 'multichoice':
    case 'multiplechoice':
      if (answer.kind !== 'choice') throw new LearningError({ code: 'INVALID_INPUT', message: `${type} requires a choice answer`, retryAfterMs: null, operationId: null });
      return { answer: [...answer.keys].sort(), answers: {} };
    case 'judgement':
      if (answer.kind !== 'judgement') throw new LearningError({ code: 'INVALID_INPUT', message: 'Judgement requires a boolean answer', retryAfterMs: null, operationId: null });
      return { answer: [String(answer.value)], answers: {} };
    case 'fillinblank':
    case 'fillblank':
      if (answer.kind !== 'fill-blank') throw new LearningError({ code: 'INVALID_INPUT', message: 'FillInBlank requires blanks', retryAfterMs: null, operationId: null });
      return { answer: '', answers: Object.fromEntries(answer.blanks.map((blank) => [blank.id, blank.text])) };
    case 'shortanswer':
    case 'essay':
      if (answer.kind !== 'short-answer') throw new LearningError({ code: 'INVALID_INPUT', message: 'ShortAnswer requires text', retryAfterMs: null, operationId: null });
      return { answer: { time: '0', content: answer.text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join(''), oSubject: { attachments: { filelist: [] } } }, answers: {} };
    default:
      throw new LearningError({ code: 'UNSUPPORTED', message: `unverified xtx problem type ${String(type)}; refusing to submit`, retryAfterMs: null, operationId: null });
  }
}

export async function submitXtxProblem(http: SessionHttp, ids: { leafId: string; classroomId: string; exerciseId: string; problemId: string; courseSign: string }, type: string, answer: Answer, csrfToken: string): Promise<void> {
  const encoded = encodeXtxProblemAnswer(type, answer);
  const integer = (raw: string): number => {
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new LearningError({ code: 'INVALID_INPUT', message: 'Xuetang homework id is invalid', retryAfterMs: null, operationId: null });
    return value;
  };
  if (csrfToken === '') throw new LearningError({ code: 'AUTH_REQUIRED', message: 'Xuetang CSRF cookie is missing', retryAfterMs: null, operationId: null });
  const response = await http.request({
    kind: 'write',
    method: 'POST',
    url: `${XTX_BASE}/api/v1/lms/exercise/problem_apply/`,
    body: JSON.stringify({ leaf_id: integer(ids.leafId), classroom_id: integer(ids.classroomId), exercise_id: integer(ids.exerciseId), problem_id: integer(ids.problemId), sign: ids.courseSign, answers: encoded.answers, answer: encoded.answer }),
    headers: { ...XTX_BASE_HEADERS, 'x-csrftoken': csrfToken, 'content-type': 'application/json;charset=utf-8' },
  });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `problem_apply returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = (await response.json()) as { success?: boolean; msg?: string };
  if (payload.success !== true) {
    throw new LearningError({ code: 'PROTOCOL', message: `problem_apply failed: ${payload.msg ?? 'success=false'}`, retryAfterMs: null, operationId: null });
  }
}

export async function fetchUnitDiscussion(http: SessionHttp, classroomId: string, leafId: string, courseSign: string): Promise<{ topicId: string; ownerUserId: number; text: string; commented: number }> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/api/v1/lms/forum/unit/discussion/?product_sign=${courseSign}&leaf_id=${leafId}&classroom_id=${classroomId}&topic_type=0&channel=xt`,
    headers: XTX_BASE_HEADERS,
  });
  const data = (await response.json()) as { id?: number | string; user_id?: number; content?: { text?: string }; commented?: number };
  if (data.id === undefined) {
    throw new LearningError({ code: 'PROTOCOL', message: 'unit discussion returned no thread id', retryAfterMs: null, operationId: null });
  }
  return { topicId: String(data.id), ownerUserId: data.user_id ?? 0, text: (data.content?.text ?? '').trim(), commented: data.commented ?? 0 };
}

export async function fetchDiscussionComments(http: SessionHttp, input: { classroomId: string; leafId: string; topicId: string; offset: number; limit: number }): Promise<Array<{ id: string; userId: string; text: string }>> {
  const query = new URLSearchParams({ offset: String(input.offset), limit: String(input.limit), cid: input.classroomId, lid: input.leafId });
  const response = await http.request({ kind: 'read', method: 'GET', url: `${XTX_BASE}/api/v1/lms/forum/comment/list/${input.topicId}/?${query.toString()}`, headers: XTX_BASE_HEADERS });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `comment list returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = await response.json() as { success?: boolean; data?: { results?: Array<{ id?: number | string; user_id?: number | string; content?: { text?: string } }> } };
  if (payload.success === false || !Array.isArray(payload.data?.results)) throw new LearningError({ code: 'PROTOCOL', message: 'comment list has invalid envelope', retryAfterMs: null, operationId: null });
  return payload.data.results.map((row) => {
    if (row.id === undefined || typeof row.content?.text !== 'string') throw new LearningError({ code: 'PROTOCOL', message: 'comment row is missing id or text', retryAfterMs: null, operationId: null });
    return { id: String(row.id), userId: String(row.user_id ?? ''), text: row.content.text };
  });
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
