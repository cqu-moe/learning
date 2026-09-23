import YAML from 'yaml';
import { LearningError } from '../types/errors.js';
import { sha256Hex } from '../types/sha256.js';
import type { Answer, AnswerDraft, FeedbackSet, Question } from '../types/models.js';
import type { AssessmentRef, Scope } from '../types/refs.js';

export const MAX_DRAFT_BYTES = 4 * 1024 * 1024;

const TRUE_TOKENS = new Set(['正确', '对', 't', 'true']);
const FALSE_TOKENS = new Set(['错误', '错', 'f', 'false']);

function parseYamlOrJson(text: string): unknown {
  if (text.length > MAX_DRAFT_BYTES) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'draft exceeds the 4MiB limit', retryAfterMs: null, operationId: null });
  }
  if ((text.match(/\*/g) ?? []).length > 100) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'too many YAML aliases', retryAfterMs: null, operationId: null });
  }
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    return YAML.parse(text, { strict: false });
  } catch {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is neither valid JSON nor YAML', retryAfterMs: null, operationId: null });
  }
}

function legacyAnswer(raw: unknown): Answer {
  if (raw === null || raw === undefined) return { kind: 'unset' };
  if (typeof raw === 'boolean') return { kind: 'judgement', value: raw };
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase();
    if (TRUE_TOKENS.has(key)) return { kind: 'judgement', value: true };
    if (FALSE_TOKENS.has(key)) return { kind: 'judgement', value: false };
    const trimmedValue = raw.trim();
    if (trimmedValue !== '') {
      return /^[A-Za-z]$/.test(trimmedValue) ? { kind: 'choice', keys: [trimmedValue.toUpperCase()] } : { kind: 'short-answer', text: trimmedValue };
    }
  }
  if (Array.isArray(raw)) {
    const items = raw.every((item) => typeof item === 'string');
    if (items) {
      const strings = raw as string[];
      if (strings.every((item) => TRUE_TOKENS.has(item.toLowerCase()) || FALSE_TOKENS.has(item.toLowerCase()))) {
        return { kind: 'judgement', value: TRUE_TOKENS.has(strings[0]?.toLowerCase() ?? '') };
      }
      return { kind: 'choice', keys: [...new Set(strings.map((item) => item.trim().toUpperCase()))].sort() };
    }
  }
  throw new LearningError({ code: 'INVALID_INPUT', message: 'unrecognized answer value', retryAfterMs: null, operationId: null });
}

export async function importLegacyDraft(text: string, format: 'learning' | 'ykt' | 'xuetang', scope: Scope): Promise<{ value: AnswerDraft; warnings: [] }> {
  const parsed = parseYamlOrJson(text) as Record<string, unknown>;
  if (typeof parsed.classroom_id !== 'number' && typeof parsed.classroom_id !== 'string') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'legacy draft missing classroom_id', retryAfterMs: null, operationId: null });
  }
  if (parsed.exercise_id === undefined) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'legacy draft missing exercise_id', retryAfterMs: null, operationId: null });
  }
  const ref: AssessmentRef = {
    resource: {
      course: { scope, key: 'imported', native: scope.platform === 'ykt' ? { kind: 'ykt', classroomId: String(parsed.classroom_id) } : { kind: 'xuetang', classroomId: String(parsed.classroom_id), courseSign: String(parsed.course_sign ?? ''), skuId: String(parsed.sku_id ?? 0) } },
      key: 'imported',
      native: scope.platform === 'ykt' ? { kind: 'ykt', leafId: String(parsed.leaf_id ?? 0), leafInfoId: null } : { kind: 'xuetang', leafId: String(parsed.leaf_id ?? 0), leafInfoId: null },
    },
    kind: 'homework',
    assessmentId: String(parsed.exercise_id),
  };
  const answers = parsed.answers;
  if (answers === null || typeof answers !== 'object') {
    throw new LearningError({ code: 'INVALID_INPUT', message: `${format} draft has no answers map`, retryAfterMs: null, operationId: null });
  }
  const entries = Object.entries(answers as Record<string, unknown>).map(([questionId, raw]) => {
    const answer = legacyAnswer(raw);
    return {
      questionId,
      fingerprint: sha256Hex(JSON.stringify([ref.assessmentId, questionId])),
      answer,
      evidence: answer.kind === 'unset' ? null : { origin: 'user' as const, answer, sourceId: 'imported-draft', alternatives: [] },
    };
  });
  const draft: AnswerDraft = {
    schemaVersion: 1,
    id: `draft-${ref.assessmentId}`,
    ref,
    fingerprint: sha256Hex(JSON.stringify([ref.assessmentId, entries.map((entry) => entry.questionId)])),
    entries,
  };
  return { value: draft, warnings: [] };
}

export async function importFeedbackSet(text: string, ref: AssessmentRef): Promise<FeedbackSet> {
  const parsed = parseYamlOrJson(text) as { problems?: Array<{ problem_id?: number | string; content?: { ProblemType?: number; Body?: string; Options?: Array<{ key?: string; value?: string }>; Answers?: string[] } }> };
  const questions: Question[] = (parsed.problems ?? []).map((problem) => {
    const content = problem.content ?? {};
    const official = content.Answers ?? [];
    const answer: Answer | null = official.length > 0 ? { kind: 'choice', keys: official.map((key) => key.toUpperCase()) } : null;
    return {
      id: String(problem.problem_id ?? ''),
      kind: content.ProblemType === 1 ? 'single-choice' : content.ProblemType === 2 ? 'multi-choice' : content.ProblemType === 6 ? 'judgement' : content.ProblemType === 4 ? 'fill-blank' : 'unknown',
      rawType: String(content.ProblemType ?? ''),
      body: { markdown: content.Body ?? '', plainText: content.Body ?? '', decodeState: 'not-needed', sourceHash: sha256Hex(content.Body ?? '') },
      options: (content.Options ?? []).map((option) => ({
        key: option.key ?? '',
        body: { markdown: option.value ?? '', plainText: option.value ?? '', decodeState: 'not-needed' as const, sourceHash: sha256Hex(option.value ?? '') },
      })),
      fingerprint: sha256Hex(JSON.stringify([problem.problem_id, content.ProblemType ?? null, content.Body ?? ''])),
      attemptsUsed: null,
      maxAttempts: null,
      myAnswer: null,
      feedback: answer === null ? null : { origin: 'platform-feedback', answer, sourceId: 'official', alternatives: [] },
    };
  });
  return { schemaVersion: 1, id: `feedback-${ref.assessmentId}`, ref, questions };
}
