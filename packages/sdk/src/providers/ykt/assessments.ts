import { LearningError } from '../../types/errors.js';
import { sha256Hex } from '../../types/sha256.js';
import type { Assessment, Question, RichText } from '../../types/models.js';
import type { AssessmentRef, ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { fetchLeafInfo } from './resources.js';
import { moocEnvelopeChecked, YKT_BASE } from './schemas.js';
import { fetchEmbeddedList } from './homework-write.js';

function richTextFromRaw(html: string | null | undefined, fontLocked: boolean): RichText {
  const raw = html ?? '';
  return {
    markdown: raw,
    plainText: raw,
    decodeState: raw === '' ? 'not-needed' : fontLocked ? 'partial' : 'not-needed',
    sourceHash: sha256Hex(raw),
  };
}

function questionKindOf(problemType: number | undefined): Question['kind'] {
  switch (problemType) {
    case 1: return 'single-choice';
    case 2: return 'multi-choice';
    case 6: return 'judgement';
    case 4: return 'fill-blank';
    default: return 'unknown';
  }
}

/** Exam chains are serialized per profile: one paper open at a time (P-E01). */
const examChains = new Map<string, Promise<unknown>>();
export function serializeExamChain<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  const previous = examChains.get(profileId) ?? Promise.resolve();
  const next = previous.then(run, run);
  examChains.set(profileId, next.catch(() => {}));
  return next;
}

export async function yktAssessmentsResolve(http: SessionHttp, resource: ResourceRef): Promise<AssessmentRef[]> {
  if (resource.native.kind !== 'ykt' || resource.course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt assessments require ykt refs', retryAfterMs: null, operationId: null });
  }
  const info = await fetchLeafInfo(http, resource.course.native.classroomId, resource.native.leafId);
  if (info?.leaf_type === 0 && info.content_info?.media?.exercise_id) {
    return [{ resource, kind: 'embedded', assessmentId: String(info.content_info.media.exercise_id) }];
  }
  if (info?.leaf_type === 5) {
    const examId = info?.content_info?.leaf_type_id;
    if (examId !== undefined && examId !== null) {
      return [{ resource, kind: 'exam', assessmentId: String(examId) }];
    }
  }
  const exerciseId = info?.content_info?.leaf_type_id;
  if (exerciseId === undefined || exerciseId === null) return [];
  return [
    {
      resource,
      kind: 'homework',
      assessmentId: String(exerciseId),
    },
  ];
}

export async function yktEmbeddedRead(http: SessionHttp, ref: AssessmentRef): Promise<Assessment> {
  if (ref.kind !== 'embedded' || ref.resource.native.kind !== 'ykt' || ref.resource.course.native.kind !== 'ykt') throw new LearningError({ code: 'INVALID_INPUT', message: 'Yuketang embedded assessment ref required', retryAfterMs: null, operationId: null });
  const classroomId = ref.resource.course.native.classroomId;
  const leafId = ref.resource.native.leafId;
  const info = await fetchLeafInfo(http, classroomId, leafId);
  const skuId = String(info?.sku_id ?? '');
  if (info?.leaf_type !== 0 || String(info.content_info?.media?.exercise_id ?? '') !== ref.assessmentId || !/^[1-9]\d*$/.test(skuId)) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'embedded exercise identity changed', retryAfterMs: null, operationId: null });
  const problems = await fetchEmbeddedList(http, { classroomId, leafId, skuId, exerciseId: ref.assessmentId });
  const questions: Question[] = problems.map((problem) => ({
    id: problem.problemId, kind: questionKindOf(problem.problemType), rawType: String(problem.problemType),
    body: richTextFromRaw(problem.body, false), options: problem.options.map((option) => ({ key: option.key, body: richTextFromRaw(option.body, false) })),
    fingerprint: sha256Hex(JSON.stringify([Number(problem.problemId), problem.problemType, problem.body])),
    attemptsUsed: problem.isRight ? 1 : null, maxAttempts: null, myAnswer: null, feedback: null,
  }));
  return { ref, title: `embedded ${leafId}`, state: 'unknown', timed: null,
    fingerprint: sha256Hex(JSON.stringify(questions.map((question) => question.fingerprint))), questions };
}

export async function yktAssessmentGet(http: SessionHttp, ref: AssessmentRef): Promise<Assessment> {
  if (ref.resource.native.kind !== 'ykt' || ref.resource.course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt assessment requires ykt refs', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/mooc-api/v1/lms/exercise/get_exercise_list/${ref.assessmentId}/?classroom_id=${ref.resource.course.native.classroomId}`,
    headers: { xtbz: 'ykt' },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  moocEnvelopeChecked(payload, `get_exercise_list/${ref.assessmentId}`);
  const data = (payload.data ?? {}) as {
    font?: string;
    name?: string;
    problems?: Array<{ problem_id: number; content?: { ProblemType?: number; Body?: string; Options?: Array<{ key?: string; value?: string }> } }>;
  };
  const fontLocked = typeof data.font === 'string' && data.font !== '';
  const questions: Question[] = (data.problems ?? []).map((problem) => {
    const content = problem.content ?? {};
    const kind = questionKindOf(content.ProblemType);
    return {
      id: String(problem.problem_id),
      kind,
      rawType: String(content.ProblemType ?? ''),
      body: richTextFromRaw(content.Body, fontLocked),
      options: (content.Options ?? []).map((option) => ({
        key: option.key ?? '',
        body: richTextFromRaw(option.value, fontLocked),
      })),
      fingerprint: sha256Hex(JSON.stringify([problem.problem_id, content.ProblemType ?? null, content.Body ?? ''])),
      attemptsUsed: null,
      maxAttempts: null,
      myAnswer: null,
      feedback: null,
    };
  });
  return {
    ref,
    title: data.name ?? ref.assessmentId,
    state: 'unknown',
    timed: null,
    fingerprint: sha256Hex(JSON.stringify(questions.map((q) => q.fingerprint))),
    questions,
  };
}
