import { LearningError } from '../../types/errors.js';
import { sha256Hex } from '../../types/sha256.js';
import type { Assessment, Question, RichText } from '../../types/models.js';
import type { AssessmentRef, ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { fetchLeafInfo } from './resources.js';
import { moocEnvelopeChecked, YKT_BASE } from './schemas.js';

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
