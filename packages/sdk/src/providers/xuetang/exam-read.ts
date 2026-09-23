import { LearningError } from '../../types/errors.js';
import { sha256Hex } from '../../types/sha256.js';
import type { Assessment, Question } from '../../types/models.js';
import type { AssessmentRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { xtxLeafInfo } from './resources.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';

const EXAM_HOST_ALLOWLIST = ['examination.xuetangx.com'];

/** A091: validate the exam host before sending crypt anywhere. */
export function validateExamHost(host: string): string {
  const normalized = host.replace(/\/$/, '');
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:' || !EXAM_HOST_ALLOWLIST.includes(parsed.hostname)) {
    throw new LearningError({ code: 'PROTOCOL', message: `untrusted exam host: ${parsed.hostname}`, retryAfterMs: null, operationId: null });
  }
  return normalized;
}

const chains = new Map<string, Promise<unknown>>();
function serialize<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(profileId) ?? Promise.resolve();
  const next = previous.then(run, run);
  chains.set(profileId, next.catch(() => {}));
  return next;
}

function kindFromTypeString(type: string | undefined): Question['kind'] {
  switch (type) {
    case 'SingleChoice': return 'single-choice';
    case 'MultiChoice': return 'multi-choice';
    case 'Judgement': return 'judgement';
    case 'FillInBlank': return 'fill-blank';
    case 'ShortAnswer': return 'short-answer';
    default: return 'unknown';
  }
}

export async function xtxExamResolve(http: SessionHttp, resource: AssessmentRef['resource']): Promise<AssessmentRef[]> {
  const info = await xtxLeafInfo(http, resource);
  if (info.leaf_type === 6) {
    const homeworkId = info.content_info?.leaf_type_id;
    if (!Number.isSafeInteger(homeworkId) || homeworkId === undefined || homeworkId <= 0) throw new LearningError({ code: 'PROTOCOL', message: 'homework leaf lacks a valid exercise id', retryAfterMs: null, operationId: null });
    return [{ resource, kind: 'homework', assessmentId: String(homeworkId) }];
  }
  if (info.leaf_type !== 5) return [];
  const examId = info.content_info?.leaf_type_id;
  if (examId === undefined || examId === null) return [];
  return [{ resource, kind: 'exam', assessmentId: String(examId) }];
}

export async function xtxExamRead(http: SessionHttp, ref: AssessmentRef): Promise<Assessment> {
  if (ref.resource.course.native.kind !== 'xuetang') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'xtx exam requires xtx refs', retryAfterMs: null, operationId: null });
  }
  const classroomId = ref.resource.course.native.classroomId;
  return serialize(ref.resource.course.scope.profileId, async () => {
    const cover = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${XTX_BASE}/api/v1/lms/exam/cover?exam_id=${ref.assessmentId}`,
      headers: XTX_BASE_HEADERS,
    });
    const coverOuter = ((await cover.json()) as { data?: { data?: { show_perm?: number; result?: { status?: number }; user?: { user_id?: number | string } } } }).data?.data ?? {};
    if (coverOuter.show_perm !== 1 || coverOuter.result?.status === undefined) {
      throw new LearningError({ code: 'FORBIDDEN', message: 'exam result not viewable', retryAfterMs: null, operationId: null });
    }
    const state = coverOuter.result.status >= 2 ? 'submitted' : coverOuter.result.status === 1 ? 'in-progress' : 'not-started';
    const userId = String(coverOuter.user?.user_id ?? '');

    const genToken = await http.request({
      kind: 'write',
      method: 'POST',
      url: `${XTX_BASE}/api/v1/lms/exam/gen_token`,
      body: JSON.stringify({ exam_id: ref.assessmentId, classroom_id: classroomId, is_teacher: 0 }),
      headers: { ...XTX_BASE_HEADERS, 'content-type': 'application/json;charset=utf-8' },
    });
    const tokenPayload = (await genToken.json()) as { success?: boolean; msg?: string; data?: { errcode?: number; errmsg?: string; data?: { crypt?: string; token?: string; exam_host?: string } } };
    const outer = tokenPayload.data ?? {};
    if (outer.errcode !== 0 && outer.errcode !== undefined) {
      throw new LearningError({ code: 'PROTOCOL', message: `gen_token errcode=${outer.errcode}`, retryAfterMs: null, operationId: null });
    }
    if (tokenPayload.success === false) {
      throw new LearningError({ code: 'PROTOCOL', message: `gen_token failed: ${tokenPayload.msg ?? ''}`, retryAfterMs: null, operationId: null });
    }
    const inner = outer.data ?? {};
    const crypt = inner.crypt ?? inner.token;
    if (crypt === undefined || crypt === '') {
      throw new LearningError({ code: 'PROTOCOL', message: 'gen_token returned no crypt', retryAfterMs: null, operationId: null });
    }
    const host = validateExamHost(inner.exam_host ?? 'https://examination.xuetangx.com');
    await http.request({
      kind: 'read',
      method: 'GET',
      url: `${host}/login?exam_id=${ref.assessmentId}&user_id=${userId}&crypt=${encodeURIComponent(crypt)}&next=${encodeURIComponent(`${host}/result/${ref.assessmentId}?isFrom=0`)}&language=zh`,
    });
    const cloudHeaders = { 'xtbz': 'cloud', 'x-client': 'web' };
    const paper = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${host}/exam_room/show_paper?exam_id=${ref.assessmentId}`,
      headers: cloudHeaders,
    });
    const paperPayload = (await paper.json()) as { errcode?: number; errmsg?: string; data?: { problems?: Array<{ problem_id: number; Problem?: { ProblemType?: string; Body?: string; Options?: Array<{ Key?: string; Value?: string }> } }> } };
    if (paperPayload.errcode !== 0 && paperPayload.errcode !== undefined) {
      throw new LearningError({ code: 'PROTOCOL', message: `show_paper errcode=${paperPayload.errcode}`, retryAfterMs: null, operationId: null });
    }
    const results = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${host}/exam_room/problem_results?exam_id=${ref.assessmentId}`,
      headers: cloudHeaders,
    });
    const resultsPayload = (await results.json()) as { errcode?: number; data?: { results?: Array<{ problem_id: number; grade?: number; Answer?: unknown }> } };
    const byId = new Map((resultsPayload.data?.results ?? []).map((row) => [String(row.problem_id), row]));
    const questions: Question[] = (paperPayload.data?.problems ?? []).map((problem) => {
      const wire = problem.Problem ?? {};
      const kind = kindFromTypeString(wire.ProblemType);
      const mine = byId.get(String(problem.problem_id));
      const raw = wire.Body ?? '';
      return {
        id: String(problem.problem_id),
        kind,
        rawType: wire.ProblemType ?? '',
        body: { markdown: raw, plainText: raw, decodeState: 'not-needed', sourceHash: sha256Hex(raw) },
        options: (wire.Options ?? []).map((option) => ({
          key: option.Key ?? '',
          body: { markdown: option.Value ?? '', plainText: option.Value ?? '', decodeState: 'not-needed', sourceHash: sha256Hex(option.Value ?? '') },
        })),
        fingerprint: sha256Hex(JSON.stringify([problem.problem_id, wire.ProblemType ?? null, raw])),
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: kind === 'single-choice' && typeof mine?.Answer === 'string' ? { kind: 'choice', keys: [mine.Answer] } : null,
        feedback: null,
      };
    });
    return {
      ref,
      title: `exam ${ref.assessmentId}`,
      state,
      timed: null,
      fingerprint: sha256Hex(JSON.stringify(questions.map((q) => q.fingerprint))),
      questions,
    };
  });
}
