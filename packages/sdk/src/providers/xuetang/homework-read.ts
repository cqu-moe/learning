import { LearningError } from '../../types/errors.js';
import { sha256Hex } from '../../types/sha256.js';
import type { Assessment, Question } from '../../types/models.js';
import type { AssessmentRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';

function kindOf(raw: string): Question['kind'] {
  switch (raw.trim().toLowerCase()) {
    case 'singlechoice': return 'single-choice';
    case 'multichoice':
    case 'multiplechoice': return 'multi-choice';
    case 'judgement': return 'judgement';
    case 'fillinblank':
    case 'fillblank': return 'fill-blank';
    case 'shortanswer':
    case 'essay': return 'short-answer';
    default: return 'unknown';
  }
}

export async function xtxHomeworkRead(http: SessionHttp, ref: AssessmentRef): Promise<Assessment> {
  if (ref.kind !== 'homework' || ref.resource.course.native.kind !== 'xuetang') throw new LearningError({ code: 'INVALID_INPUT', message: 'Xuetang homework ref required', retryAfterMs: null, operationId: null });
  const skuId = ref.resource.course.native.skuId;
  const response = await http.request({ kind: 'read', method: 'GET', url: `${XTX_BASE}/api/v1/lms/exercise/get_exercise_list/${ref.assessmentId}/${skuId}/`, headers: XTX_BASE_HEADERS });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `exercise read returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = await response.json() as { success?: boolean; data?: { exercise_id?: number; name?: string; problems?: Array<{ problem_id?: number; content?: { Type?: string; Body?: string; Options?: Array<{ key?: string; value?: string }> }; user?: { my_count?: number } }> } };
  if (payload.success !== true || payload.data?.exercise_id !== Number(ref.assessmentId) || !Array.isArray(payload.data.problems)) throw new LearningError({ code: 'PROTOCOL', message: 'exercise read returned an invalid envelope', retryAfterMs: null, operationId: null });
  const questions: Question[] = payload.data.problems.map((problem) => {
    if (!Number.isSafeInteger(problem.problem_id) || problem.problem_id === undefined || problem.problem_id <= 0) throw new LearningError({ code: 'PROTOCOL', message: 'exercise problem id is invalid', retryAfterMs: null, operationId: null });
    const rawType = problem.content?.Type ?? '';
    const raw = problem.content?.Body ?? '';
    const rich = (text: string) => ({ markdown: text, plainText: text, decodeState: 'not-needed' as const, sourceHash: sha256Hex(text) });
    return { id: String(problem.problem_id), kind: kindOf(rawType), rawType, body: rich(raw),
      options: (problem.content?.Options ?? []).map((option) => ({ key: option.key ?? '', body: rich(option.value ?? '') })),
      fingerprint: sha256Hex(JSON.stringify([problem.problem_id, rawType, raw])), attemptsUsed: problem.user?.my_count ?? null,
      maxAttempts: null, myAnswer: null, feedback: null };
  });
  return { ref, title: payload.data.name ?? `homework ${ref.assessmentId}`, state: 'unknown', timed: null,
    fingerprint: sha256Hex(JSON.stringify(questions.map((question) => question.fingerprint))), questions };
}
