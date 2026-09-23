import { LearningError } from '../../types/errors.js';
import type { Answer } from '../../types/models.js';
import type { AssessmentRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';
import { validateExamHost } from './exam-read.js';

export async function xtxReadStartCover(http: SessionHttp, ref: AssessmentRef): Promise<{ status: number; userId: string }> {
  if (ref.resource.course.native.kind !== 'xuetang' || ref.kind !== 'exam') throw new LearningError({ code: 'INVALID_INPUT', message: 'Xuetang exam start requires an exam ref', retryAfterMs: null, operationId: null });
  const response = await http.request({ kind: 'read', method: 'GET', url: `${XTX_BASE}/api/v1/lms/exam/cover?exam_id=${encodeURIComponent(ref.assessmentId)}`, headers: XTX_BASE_HEADERS });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `exam cover returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const outer = await response.json() as { data?: { data?: { result?: { status?: number }; user?: { user_id?: number | string } } } };
  const status = outer.data?.data?.result?.status;
  const userId = String(outer.data?.data?.user?.user_id ?? '');
  if (status === undefined || !Number.isSafeInteger(status) || userId === '') throw new LearningError({ code: 'PROTOCOL', message: 'exam cover lacks state or user id', retryAfterMs: null, operationId: null });
  return { status, userId };
}

export async function xtxEstablishExamSession(http: SessionHttp, ref: AssessmentRef, userId: string): Promise<string> {
  if (ref.resource.course.native.kind !== 'xuetang') throw new LearningError({ code: 'INVALID_INPUT', message: 'Xuetang exam ref is invalid', retryAfterMs: null, operationId: null });
  const token = await http.request({ kind: 'write', method: 'POST', url: `${XTX_BASE}/api/v1/lms/exam/gen_token`,
    headers: { ...XTX_BASE_HEADERS, 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ exam_id: ref.assessmentId, classroom_id: ref.resource.course.native.classroomId, is_teacher: 0 }) });
  const outer = await token.json() as { success?: boolean; data?: { errcode?: number; data?: { crypt?: string; token?: string; exam_host?: string } } };
  if (outer.success === false || (outer.data?.errcode !== undefined && outer.data.errcode !== 0)) throw new LearningError({ code: 'PROTOCOL', message: 'exam token request was rejected', retryAfterMs: null, operationId: null });
  const crypt = outer.data?.data?.crypt ?? outer.data?.data?.token;
  if (!crypt) throw new LearningError({ code: 'PROTOCOL', message: 'exam token is missing', retryAfterMs: null, operationId: null });
  const host = validateExamHost(outer.data?.data?.exam_host ?? 'https://examination.xuetangx.com');
  const query = new URLSearchParams({ exam_id: ref.assessmentId, user_id: userId, crypt, next: `${host}/result/${ref.assessmentId}?isFrom=0`, language: 'zh' });
  await http.request({ kind: 'read', method: 'GET', url: `${host}/login?${query.toString()}` });
  return host;
}

export async function xtxStartExam(http: SessionHttp, ref: AssessmentRef, userId: string): Promise<void> {
  const examId = Number(ref.assessmentId);
  if (!Number.isSafeInteger(examId) || examId <= 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam id is not a safe integer', retryAfterMs: null, operationId: null });
  const host = await xtxEstablishExamSession(http, ref, userId);
  const result = await http.request({ kind: 'write', method: 'POST', url: `${host}/exam_room/start_paper`,
    headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' }, body: JSON.stringify({ exam_id: examId }) });
  const payload = await result.json() as { errcode?: number; errmsg?: string };
  if (payload.errcode !== 0) throw new LearningError({ code: 'PROTOCOL', message: `start_paper errcode=${String(payload.errcode ?? 'missing')}`, retryAfterMs: null, operationId: null });
}

export async function xtxSaveExam(http: SessionHttp, ref: AssessmentRef, userId: string, results: Array<{ problem_id: number; result: string[]; time: number }>): Promise<void> {
  const examId = Number(ref.assessmentId);
  if (!Number.isSafeInteger(examId) || examId <= 0 || results.length === 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam save needs a safe id and at least one answer', retryAfterMs: null, operationId: null });
  const host = await xtxEstablishExamSession(http, ref, userId);
  const response = await http.request({ kind: 'write', method: 'POST', url: `${host}/exam_room/answer_problem`,
    headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ results, exam_id: examId, record: [] }) });
  const payload = await response.json() as { errcode?: number };
  if (payload.errcode !== 0) throw new LearningError({ code: 'PROTOCOL', message: `answer_problem errcode=${String(payload.errcode ?? 'missing')}`, retryAfterMs: null, operationId: null });
}

/** E05: only choice/judgement encodings are evidenced; others refuse before any write. */
export function encodeExamAnswer(answer: Answer): string[] {
  switch (answer.kind) {
    case 'choice':
      if (answer.keys.length === 0) {
        throw new LearningError({ code: 'INVALID_INPUT', message: 'choice answer needs keys', retryAfterMs: null, operationId: null });
      }
      return [...answer.keys].sort();
    case 'judgement':
      return [String(answer.value)];
    case 'fill-blank':
    case 'short-answer':
      throw new LearningError({ code: 'UNSUPPORTED', message: 'exam write shape for this type is not verified yet (E05)', retryAfterMs: null, operationId: null });
    case 'unset':
      throw new LearningError({ code: 'INVALID_INPUT', message: 'unset answers are never submitted', retryAfterMs: null, operationId: null });
  }
}

export type ExamAction = 'start' | 'save' | 'finalize';

/** start/save/finalize are three independent actions with distinct semantics (X07). */
export async function examActionIndependent(deps: {
  readState(): Promise<'not-started' | 'in-progress' | 'submitted'>;
  perform(action: ExamAction): Promise<{ ok: boolean }>;
  action: ExamAction;
}): Promise<{ rejected: boolean; reason?: string }> {
  const state = await deps.readState();
  if (deps.action === 'save' && state === 'not-started') {
    return { rejected: true, reason: 'save cannot implicitly start an exam' };
  }
  if (state === 'submitted') {
    return { rejected: true, reason: 'exam already finalized' };
  }
  if (deps.action === 'start' && state !== 'not-started') {
    return { rejected: true, reason: 'exam already started' };
  }
  await deps.perform(deps.action);
  return { rejected: false };
}
