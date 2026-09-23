import { z } from 'zod';
import type { AnswerDraft, Match, Question } from '../types/models.js';
import type { ModelClient } from '../runtime/types.js';

const SuggestionWire = z.object({ questionId: z.string(), keys: z.array(z.string()).optional() });
const ResponseWire = z.object({ suggestions: z.array(SuggestionWire) });

/** Model proposals: only decoded question text is sent; results are schema-checked before use (A132). */
export async function proposeMatches(model: ModelClient | null, draft: AnswerDraft, questions: Question[]): Promise<Match[]> {
  if (model === null) {
    return draft.entries.map((entry) => ({
      questionId: entry.questionId,
      state: 'blocked',
      answer: null,
      sourceId: null,
      reason: 'no model client configured',
    }));
  }
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const payload = draft.entries.map((entry) => {
    const question = questionById.get(entry.questionId);
    return {
      questionId: entry.questionId,
      body: question?.body.plainText ?? '',
      decodeState: question?.body.decodeState ?? 'unavailable',
      options: (question?.options ?? []).map((option) => ({ key: option.key, body: option.body.plainText })),
    };
  });
  const controller = new AbortController();
  const raw = await model.propose({ purpose: 'answers', content: payload, signal: controller.signal });
  const parsed = ResponseWire.parse(raw);
  const byId = new Map(parsed.suggestions.map((suggestion) => [suggestion.questionId, suggestion]));
  return draft.entries.map((entry) => {
    const suggestion = byId.get(entry.questionId);
    if (suggestion === undefined || suggestion.keys === undefined || suggestion.keys.length === 0) {
      return { questionId: entry.questionId, state: 'missing', answer: null, sourceId: null, reason: 'model returned no usable suggestion' };
    }
    const question = questionById.get(entry.questionId);
    const validKeys = suggestion.keys.every((key) => question?.options.some((option) => option.key === key));
    if (!validKeys) {
      return { questionId: entry.questionId, state: 'blocked', answer: null, sourceId: null, reason: 'model suggested a nonexistent option' };
    }
    return {
      questionId: entry.questionId,
      state: 'suggested',
      answer: { kind: 'choice', keys: [...new Set(suggestion.keys)].sort() },
      sourceId: 'model',
      reason: 'model suggestion; requires user review',
    };
  });
}
