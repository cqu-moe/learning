import type { Answer, AnswerDraft, FeedbackSet, Match, Question } from '../types/models.js';

function optionBodies(question: Question): Map<string, string> {
  const map = new Map<string, string>();
  for (const option of question.options) map.set(option.key, option.body.plainText);
  return map;
}

function contentKey(question: Question): string {
  return JSON.stringify([question.body.plainText, [...optionBodies(question).entries()].sort((a, b) => a[1].localeCompare(b[1]))]);
}

/** Content-based matching with option reordering; undecoded or foreign kinds never auto-apply (A131/A132). */
export function matchDraft(draft: AnswerDraft, sources: FeedbackSet[], questions: Question[]): Match[] {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  return draft.entries.map((entry) => {
    const target = questionById.get(entry.questionId);
    if (target === undefined) {
      return { questionId: entry.questionId, state: 'missing', answer: null, sourceId: null, reason: 'question not found in target assessment' };
    }
    if (target.body.decodeState !== 'not-needed' && target.body.decodeState !== 'complete') {
      return { questionId: entry.questionId, state: 'blocked', answer: null, sourceId: null, reason: 'question body is not fully decoded' };
    }
    const candidates: Array<{ source: FeedbackSet; question: Question }> = [];
    let foreignContentMatch = false;
    for (const source of sources) {
      for (const candidate of source.questions) {
        const contentMatches = candidate.fingerprint === entry.fingerprint || contentKey(candidate) === contentKey(target);
        if (!contentMatches) continue;
        if (source.ref.kind !== draft.ref.kind) {
          foreignContentMatch = true;
          continue;
        }
        candidates.push({ source, question: candidate });
      }
    }
    if (candidates.length === 0 && foreignContentMatch) {
      return { questionId: entry.questionId, state: 'blocked', answer: null, sourceId: null, reason: 'source assessment kind differs (exam vs homework)' };
    }
    if (candidates.length === 0) {
      return { questionId: entry.questionId, state: 'missing', answer: null, sourceId: null, reason: 'no feedback question matched' };
    }
    const distinct = new Set(candidates.map(({ question }) => {
      const answer = question.feedback?.answer ?? null;
      return JSON.stringify([question.fingerprint, answer?.kind === 'choice' ? { kind: 'choice', keys: [...answer.keys].sort() } : answer]);
    }));
    if (distinct.size > 1) {
      return { questionId: entry.questionId, state: 'ambiguous', answer: null, sourceId: null, reason: 'distinct questions or conflicting feedback matched' };
    }
    const { question: source, source: set } = candidates[0]!;
    const official = source.feedback?.answer ?? null;
    if (official === null || official.kind !== 'choice') {
      return { questionId: entry.questionId, state: 'missing', answer: null, sourceId: null, reason: 'source has no usable official answer' };
    }
    const sourceOptions = optionBodies(source);
    const targetOptions = optionBodies(target);
    const sourceBodyCount = new Map<string, number>();
    for (const body of sourceOptions.values()) sourceBodyCount.set(body, (sourceBodyCount.get(body) ?? 0) + 1);
    if ([...sourceBodyCount.values()].some((count) => count > 1)) {
      return { questionId: entry.questionId, state: 'ambiguous', answer: null, sourceId: null, reason: 'duplicate option bodies in source' };
    }
    const bodyCount = new Map<string, number>();
    for (const body of targetOptions.values()) bodyCount.set(body, (bodyCount.get(body) ?? 0) + 1);
    const mappedKeys: string[] = [];
    for (const key of official.keys) {
      const body = sourceOptions.get(key);
      if (body === undefined) {
        return { questionId: entry.questionId, state: 'missing', answer: null, sourceId: null, reason: 'official key not present in source options' };
      }
      if ((bodyCount.get(body) ?? 0) > 1) {
        return { questionId: entry.questionId, state: 'ambiguous', answer: null, sourceId: null, reason: 'duplicate option bodies block remapping' };
      }
      const targetKey = [...targetOptions.entries()].find(([, value]) => value === body)?.[0];
      if (targetKey === undefined) {
        return { questionId: entry.questionId, state: 'missing', answer: null, sourceId: null, reason: 'option body not present in target' };
      }
      mappedKeys.push(targetKey);
    }
    const answer: Answer = { kind: 'choice', keys: [...new Set(mappedKeys)].sort() };
    return {
      questionId: entry.questionId,
      state: source.fingerprint === entry.fingerprint ? 'exact' : 'suggested',
      answer,
      sourceId: set.id,
      reason: source.fingerprint === entry.fingerprint ? 'fingerprint match' : 'content match with option remapping',
    };
  });
}
