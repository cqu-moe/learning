import { LearningError } from '../../types/errors.js';
import type { Answer } from '../../types/models.js';

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
