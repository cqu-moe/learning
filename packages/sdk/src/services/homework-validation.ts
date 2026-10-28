import { LearningError } from '../types/errors.js';
import type { AnswerDraft, Assessment, Question } from '../types/models.js';

function invalid(message: string): LearningError {
  return new LearningError({ code: 'INVALID_INPUT', message, retryAfterMs: null, operationId: null });
}

function changed(message: string): LearningError {
  return new LearningError({ code: 'PRECONDITION_CHANGED', message, retryAfterMs: null, operationId: null });
}

export function validateYktHomeworkQuestion(assessment: Assessment, draft: AnswerDraft, questionId: string): Question {
  const entry = draft.entries.find((item) => item.questionId === questionId);
  if (entry === undefined || entry.answer.kind === 'unset') throw invalid('selected question has no answer');
  const question = assessment.questions.find((item) => item.id === questionId);
  if (question === undefined || question.fingerprint !== entry.fingerprint) {
    throw changed('homework question changed since draft creation');
  }
  if ([question.body, ...question.options.map(option => option.body)].some(body => !['complete', 'not-needed'].includes(body.decodeState))) {
    throw changed('homework question is not fully readable');
  }
  if (question.kind === 'short-answer' || question.kind === 'unknown') {
    throw invalid(`ordinary Yuketang homework cannot submit question kind ${question.kind}`);
  }
  if ((question.attemptsUsed ?? 0) > 0) throw changed('homework problem was already submitted');

  if ((question.kind === 'single-choice' || question.kind === 'multi-choice') && entry.answer.kind !== 'choice') {
    throw invalid('answer kind does not match question kind');
  }
  if (question.kind === 'judgement' && entry.answer.kind !== 'judgement') throw invalid('answer kind does not match question kind');
  if (question.kind === 'fill-blank' && entry.answer.kind !== 'fill-blank') throw invalid('answer kind does not match question kind');

  if (entry.answer.kind === 'choice') {
    if (question.kind === 'single-choice' && entry.answer.keys.length !== 1) throw invalid('single-choice answer needs exactly one key');
    const keys = new Set(question.options.map((option) => option.key));
    if (entry.answer.keys.some((key) => !keys.has(key))) throw invalid('choice answer contains an unknown option key');
  }
  if (entry.answer.kind === 'fill-blank' && entry.answer.blanks.length === 0) throw invalid('fill-blank answer needs at least one blank');
  if (entry.answer.kind === 'fill-blank' && entry.answer.blanks.some((blank) => blank.text.trim() === '')) {
    throw invalid('fill-blank answer text cannot be empty');
  }
  return question;
}
