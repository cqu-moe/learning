import { LearningError } from '../../types/errors.js';
import { sha256Hex } from '../../types/sha256.js';
import type { Assessment, Question } from '../../types/models.js';
import type { AssessmentRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { serializeExamChain } from './assessments.js';
import { fetchLeafInfo } from './resources.js';

interface ExamProblemWire {
  problem_id: number;
  Problem?: { ProblemType?: number; Body?: string; Options?: Array<{ Key?: string; Value?: string }> };
  Score?: number;
}

function kindOfWire(problemType: number | undefined): Question['kind'] {
  switch (problemType) {
    case 1: return 'single-choice';
    case 2: return 'multi-choice';
    case 6: return 'judgement';
    case 4: return 'fill-blank';
    default: return 'unknown';
  }
}

/** ykt independent exam subsystem read (P-E01): cover → gen_token → SSO login → paper/results join. */
export async function yktExamRead(http: SessionHttp, ref: AssessmentRef): Promise<Assessment> {
  if (ref.resource.native.kind !== 'ykt' || ref.resource.course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt exam read requires ykt refs', retryAfterMs: null, operationId: null });
  }
  return serializeExamChain(ref.resource.course.scope.profileId, async () => {
    const courseNative = ref.resource.course.native;
    const classroomId = courseNative.kind === 'ykt' ? courseNative.classroomId : '';
    const examId = ref.assessmentId;
    const cover = await http.request({
      kind: 'read',
      method: 'GET',
      url: `https://www.yuketang.cn/v/exam/cover?exam_id=${examId}&classroom_id=${classroomId}`,
    });
    const coverPayload = (await cover.json()) as { data?: { show_perm?: number; result?: { status?: number } } };
    const status = coverPayload.data?.result?.status;
    if (coverPayload.data?.show_perm !== 1 || status === undefined) {
      throw new LearningError({ code: 'FORBIDDEN', message: 'exam result not viewable yet (10007 semantics)', retryAfterMs: null, operationId: null });
    }
    const state = status >= 2 ? 'submitted' : status === 1 ? 'in-progress' : 'not-started';

    const tokenResponse = await http.request({
      kind: 'write',
      method: 'POST',
      url: 'https://www.yuketang.cn/v/exam/gen_token',
      body: JSON.stringify({ exam_id: examId, classroom_id: classroomId }),
      headers: { 'content-type': 'application/json' },
    });
    const tokenPayload = (await tokenResponse.json()) as { success?: boolean; msg?: string; data?: { token?: string; exam_host?: string; user_id?: number | string } };
    if (tokenPayload.success !== true || tokenPayload.data?.token === undefined || tokenPayload.data.exam_host === undefined) {
      throw new LearningError({ code: 'PROTOCOL', message: `gen_token failed: ${tokenPayload.msg ?? 'no data'}`, retryAfterMs: null, operationId: null });
    }
    const host = tokenPayload.data.exam_host.replace(/\/$/, '');
    const userId = String(tokenPayload.data.user_id ?? '');
    await http.request({
      kind: 'read',
      method: 'GET',
      url: `${host}/login?exam_id=${examId}&user_id=${userId}&crypt=${encodeURIComponent(tokenPayload.data.token)}&next=${encodeURIComponent(`${host}/result/${examId}?isFrom=2`)}&language=zh`,
    });
    const paperResponse = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${host}/exam_room/show_paper?exam_id=${examId}`,
      headers: { xtbz: 'cloud', 'x-client': 'web' },
    });
    const paperPayload = (await paperResponse.json()) as { errcode?: number; errmsg?: string; data?: { problems?: ExamProblemWire[] } };
    if (paperPayload.errcode !== 0 && paperPayload.errcode !== undefined) {
      throw new LearningError({ code: 'PROTOCOL', message: `show_paper errcode=${paperPayload.errcode} ${paperPayload.errmsg ?? ''}`.trim(), retryAfterMs: null, operationId: null });
    }
    const resultsResponse = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${host}/exam_room/problem_results?exam_id=${examId}`,
      headers: { xtbz: 'cloud', 'x-client': 'web' },
    });
    const resultsPayload = (await resultsResponse.json()) as {
      errcode?: number;
      errmsg?: string;
      data?: { results?: Array<{ problem_id: number; grade?: number; Answer?: unknown }>; correct?: Record<string, string> };
    };
    if (resultsPayload.errcode !== 0 && resultsPayload.errcode !== undefined) {
      throw new LearningError({ code: 'PROTOCOL', message: `problem_results errcode=${resultsPayload.errcode} ${resultsPayload.errmsg ?? ''}`.trim(), retryAfterMs: null, operationId: null });
    }
    const resultsById = new Map((resultsPayload.data?.results ?? []).map((r) => [String(r.problem_id), r]));
    const correctById = resultsPayload.data?.correct ?? {};
    const questions: Question[] = (paperPayload.data?.problems ?? []).map((problem) => {
      const wire = problem.Problem ?? {};
      const kind = kindOfWire(wire.ProblemType);
      const result = resultsById.get(String(problem.problem_id));
      const correctKey = correctById[String(problem.problem_id)];
      const rawBody = wire.Body ?? '';
      return {
        id: String(problem.problem_id),
        kind,
        rawType: String(wire.ProblemType ?? ''),
        body: { markdown: rawBody, plainText: rawBody, decodeState: 'not-needed', sourceHash: sha256Hex(rawBody) },
        options: (wire.Options ?? []).map((option) => ({
          key: option.Key ?? '',
          body: { markdown: option.Value ?? '', plainText: option.Value ?? '', decodeState: 'not-needed', sourceHash: sha256Hex(option.Value ?? '') },
        })),
        fingerprint: sha256Hex(JSON.stringify([problem.problem_id, wire.ProblemType ?? null, rawBody])),
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: kind === 'single-choice' && typeof result?.Answer === 'string' ? { kind: 'choice', keys: [result.Answer] } : null,
        feedback:
          typeof correctKey === 'string' && correctKey !== ''
            ? { origin: 'platform-feedback', answer: { kind: 'choice', keys: [correctKey] }, sourceId: 'exam_room/problem_results', alternatives: [] }
            : null,
      };
    });
    return {
      ref,
      title: `exam ${examId}`,
      state,
      timed: null,
      fingerprint: sha256Hex(JSON.stringify(questions.map((q) => q.fingerprint))),
      questions,
    };
  });
}

/** Exam leaf resolution: exercise id lives under leaf_type_id, same channel as homework. */
export async function yktExamResolve(http: SessionHttp, resource: AssessmentRef['resource']): Promise<AssessmentRef[]> {
  if (resource.native.kind !== 'ykt' || resource.course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt exam resolve requires ykt refs', retryAfterMs: null, operationId: null });
  }
  const info = await fetchLeafInfo(http, resource.course.native.classroomId, resource.native.leafId);
  const examId = info?.content_info?.leaf_type_id;
  if (examId === undefined || examId === null) return [];
  return [{ resource, kind: 'exam', assessmentId: String(examId) }];
}
