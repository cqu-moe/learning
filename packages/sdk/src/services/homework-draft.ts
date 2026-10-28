import YAML from 'yaml';
import { z } from 'zod';
import { LearningError, parseDto } from '../types/errors.js';
import { AnswerDraftSchema, AssessmentSchema, QuestionKindSchema } from '../types/models.js';
import type { Answer, AnswerDraft, Assessment, Question } from '../types/models.js';

export const HOMEWORK_DRAFT_FORMAT = 'learning-homework/v1';

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MetadataQuestionSchema = z
  .object({
    id: z.string().min(1),
    fingerprint: z.string().min(1),
    kind: QuestionKindSchema,
    options: z.array(z.string().min(1)),
  })
  .strict();

const SimpleAnswerSchema = z.union([
  z.null(),
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

const HomeworkDraftFileSchema = z
  .object({
    format: z.literal(HOMEWORK_DRAFT_FORMAT),
    metadata: z
      .object({
        draft: AnswerDraftSchema,
        questions: z.array(MetadataQuestionSchema),
      })
      .strict(),
    answers: z.record(z.string().min(1), SimpleAnswerSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const questions = value.metadata.questions;
    const entries = value.metadata.draft.entries;
    if (new Set(questions.map((question) => question.id)).size !== questions.length) {
      ctx.addIssue({ code: 'custom', path: ['metadata', 'questions'], message: 'duplicate question id' });
      return;
    }
    if (new Set(entries.map((entry) => entry.questionId)).size !== entries.length) {
      ctx.addIssue({ code: 'custom', path: ['metadata', 'draft', 'entries'], message: 'duplicate question id' });
      return;
    }
    if (questions.length !== entries.length) {
      ctx.addIssue({ code: 'custom', path: ['metadata'], message: 'question metadata does not match draft' });
      return;
    }
    for (const question of questions) {
      const entry = entries.find((candidate) => candidate.questionId === question.id);
      if (entry?.fingerprint !== question.fingerprint) {
        ctx.addIssue({ code: 'custom', path: ['metadata', question.id], message: 'question metadata does not match draft' });
      }
    }
    const answerIds = new Set(Object.keys(value.answers));
    for (const question of questions) {
      if (!answerIds.delete(question.id)) {
        ctx.addIssue({ code: 'custom', path: ['answers', question.id], message: 'answer is missing' });
      }
    }
    for (const questionId of answerIds) {
      ctx.addIssue({ code: 'custom', path: ['answers', questionId], message: 'unknown answer key' });
    }
  });

type MetadataQuestion = z.infer<typeof MetadataQuestionSchema>;
type HomeworkDraftFile = z.infer<typeof HomeworkDraftFileSchema>;

function invalid(message: string): never {
  throw new LearningError({ code: 'INVALID_INPUT', message, retryAfterMs: null, operationId: null });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameAnswer(left: Answer, right: Answer): boolean {
  if (left.kind === 'choice' && right.kind === 'choice') {
    const keys = (answer: Answer & { kind: 'choice' }) => [...answer.keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return stableJson(keys(left)) === stableJson(keys(right));
  }
  if (left.kind === 'fill-blank' && right.kind === 'fill-blank') {
    const blanks = (answer: Answer & { kind: 'fill-blank' }) =>
      answer.blanks
        .map((blank) => ({ id: blank.id, text: blank.text }))
        .sort((a, b) => {
          const leftJson = stableJson(a);
          const rightJson = stableJson(b);
          return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
        });
    return stableJson(blanks(left)) === stableJson(blanks(right));
  }
  return stableJson(left) === stableJson(right);
}

function validateQuestion(question: Question): MetadataQuestion {
  const options = question.options.map((option) => option.key);
  if (new Set(options).size !== options.length) invalid(`question ${question.id} has duplicate option keys`);
  if ((question.kind === 'single-choice' || question.kind === 'multi-choice') && options.length === 0) {
    invalid(`question ${question.id} has no options`);
  }
  return { id: question.id, fingerprint: question.fingerprint, kind: question.kind, options };
}

function assertAnswerFitsQuestion(answer: Answer, question: MetadataQuestion): void {
  if (answer.kind === 'unset') return;
  if (question.kind === 'short-answer' || question.kind === 'unknown') {
    invalid(`question ${question.id} can only be left unset`);
  }
  if (question.kind === 'single-choice' || question.kind === 'multi-choice') {
    if (answer.kind !== 'choice') invalid(`question ${question.id} requires a choice answer`);
    if (answer.keys.some((key) => !question.options.includes(key))) {
      invalid(`question ${question.id} has an illegal option`);
    }
    if (question.kind === 'single-choice' && answer.keys.length !== 1) {
      invalid(`question ${question.id} requires exactly one option`);
    }
    return;
  }
  if (question.kind === 'judgement' && answer.kind !== 'judgement') {
    invalid(`question ${question.id} requires a judgement answer`);
  }
  if (question.kind === 'fill-blank' && answer.kind !== 'fill-blank') {
    invalid(`question ${question.id} requires a fill-blank answer`);
  }
  if (answer.kind === 'fill-blank' && answer.blanks.some((blank) => blank.text.trim() === '')) {
    invalid(`question ${question.id} has a blank fill-blank answer`);
  }
}

function validateBundle(draft: AnswerDraft, assessment: Assessment): {
  draft: AnswerDraft;
  assessment: Assessment;
  questions: MetadataQuestion[];
} {
  const validDraft = parseDto(AnswerDraftSchema, draft, 'homework draft');
  const validAssessment = parseDto(AssessmentSchema, assessment, 'assessment');
  if (validAssessment.ref.kind !== 'homework' || validAssessment.ref.resource.course.scope.platform !== 'ykt' || validAssessment.ref.resource.native.kind !== 'ykt' || validAssessment.ref.resource.course.native.kind !== 'ykt') {
    invalid('draft is for a Yuketang regular homework assessment only');
  }
  if (stableJson(validDraft.ref) !== stableJson(validAssessment.ref) || validDraft.fingerprint !== validAssessment.fingerprint) {
    invalid('draft and assessment identity do not match');
  }
  const questions = validAssessment.questions.map(validateQuestion);
  if (new Set(questions.map((question) => question.id)).size !== questions.length) invalid('assessment has duplicate question ids');
  if (new Set(validDraft.entries.map((entry) => entry.questionId)).size !== validDraft.entries.length) invalid('draft has duplicate question ids');
  if (questions.length !== validDraft.entries.length) invalid('draft and assessment question sets do not match');
  for (const question of questions) {
    const entry = validDraft.entries.find((candidate) => candidate.questionId === question.id);
    if (entry?.fingerprint !== question.fingerprint) invalid(`draft fingerprint does not match question ${question.id}`);
    assertAnswerFitsQuestion(entry.answer, question);
  }
  return { draft: validDraft, assessment: validAssessment, questions };
}

function parseYaml(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_DRAFT_BYTES) {
    invalid('homework draft exceeds the 4MiB limit');
  }
  try {
    return YAML.parse(text, { strict: true, maxAliasCount: 0 });
  } catch (error) {
    throw new LearningError(
      { code: 'INVALID_INPUT', message: 'homework draft is not strict YAML', retryAfterMs: null, operationId: null },
      { cause: error },
    );
  }
}

function compactAnswer(answer: Answer, question: MetadataQuestion): string | string[] | null {
  if (answer.kind === 'unset') return null;
  if (answer.kind === 'choice') {
    if (question.kind !== 'single-choice') return answer.keys;
    const key = answer.keys[0];
    return key === undefined ? invalid('choice answer is empty') : key;
  }
  if (answer.kind === 'judgement') return answer.value ? '正确' : '错误';
  if (answer.kind === 'fill-blank') return answer.blanks.map((blank) => blank.text);
  return invalid(`unsupported answer kind: ${answer.kind}`);
}

function commentText(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '(empty)';
}

function answerExample(question: MetadataQuestion): string {
  if (question.kind === 'single-choice') return question.options[0] ?? 'A';
  if (question.kind === 'multi-choice') return `[${question.options.slice(0, 2).join(', ') || 'A, B'}]`;
  if (question.kind === 'judgement') return '正确 / 错误';
  if (question.kind === 'short-answer' || question.kind === 'unknown') return 'null（暂不能填写）';
  return '[第一空, 第二空]';
}

function renderAnswerComments(question: Question, metadata: MetadataQuestion): string[] {
  const lines = [`# ${question.id}. ${commentText(question.body.plainText || question.body.markdown)}`];
  for (const option of question.options) {
    lines.push(`#   ${option.key}. ${commentText(option.body.plainText || option.body.markdown)}`);
  }
  lines.push(`# example: ${answerExample(metadata)}`, metadata.kind === 'short-answer' || metadata.kind === 'unknown' ? '# null = 暂不能填写' : '# null = 未作答');
  return lines;
}

function parseAnswer(raw: string | string[] | null, question: MetadataQuestion, previous: Answer): Answer {
  if (raw === null) return { kind: 'unset' };
  if (question.kind === 'short-answer' || question.kind === 'unknown') {
    invalid(`question ${question.id} can only be null`);
  }
  if (question.kind === 'judgement') {
    if (raw === '正确') return { kind: 'judgement', value: true };
    if (raw === '错误') return { kind: 'judgement', value: false };
    invalid(`question ${question.id} requires 正确 or 错误`);
  }
  if (question.kind === 'single-choice') {
    if (typeof raw !== 'string') invalid(`question ${question.id} requires one option letter`);
    const key = raw.toUpperCase();
    if (!question.options.includes(key)) invalid(`question ${question.id} has an illegal option`);
    return { kind: 'choice', keys: [key] };
  }
  if (question.kind === 'multi-choice') {
    if (!Array.isArray(raw) || raw.length === 0) invalid(`question ${question.id} requires a non-empty option list`);
    const keys = [...new Set(raw.map((key) => key.toUpperCase()))].sort();
    if (keys.some((key) => !question.options.includes(key))) invalid(`question ${question.id} has an illegal option`);
    return { kind: 'choice', keys };
  }
  if (!Array.isArray(raw) || raw.length === 0) invalid(`question ${question.id} requires a non-empty text list`);
  if (raw.some((text) => text.trim() === '')) invalid(`question ${question.id} has a blank fill-blank answer`);
  const ids = previous.kind === 'fill-blank' && previous.blanks.length === raw.length
    ? previous.blanks.map((blank) => blank.id)
    : raw.map((_, index) => String(index + 1));
  return { kind: 'fill-blank', blanks: raw.map((text, index) => ({ id: ids[index] ?? String(index + 1), text })) };
}

function parseFile(value: HomeworkDraftFile): AnswerDraft {
  const questions = value.metadata.questions;
  const draft = value.metadata.draft;
  const entries = draft.entries;
  if (draft.ref.kind !== 'homework' || draft.ref.resource.course.scope.platform !== 'ykt' || draft.ref.resource.native.kind !== 'ykt' || draft.ref.resource.course.native.kind !== 'ykt') {
    invalid('draft is for a Yuketang regular homework assessment only');
  }
  if (new Set(questions.map((question) => question.id)).size !== questions.length) invalid('duplicate question id');
  if (new Set(entries.map((entry) => entry.questionId)).size !== entries.length) invalid('duplicate question id');
  if (questions.length !== entries.length) invalid('question metadata does not match draft');
  for (const question of questions) {
    if (new Set(question.options).size !== question.options.length) invalid(`question ${question.id} has duplicate option keys`);
    const entry = entries.find((candidate) => candidate.questionId === question.id);
    if (entry?.fingerprint !== question.fingerprint) invalid(`question metadata does not match question ${question.id}`);
    assertAnswerFitsQuestion(entry.answer, question);
  }

  return {
    ...draft,
    entries: entries.map((entry) => {
      const question = questions.find((candidate) => candidate.id === entry.questionId);
      if (question === undefined) invalid(`missing question metadata for ${entry.questionId}`);
      const answer = parseAnswer(value.answers[entry.questionId] ?? null, question, entry.answer);
      assertAnswerFitsQuestion(answer, question);
      const unchanged = sameAnswer(answer, entry.answer);
      return {
        ...entry,
        answer: unchanged ? entry.answer : answer,
        evidence: unchanged ? entry.evidence : answer.kind === 'unset' ? null : {
          origin: 'user',
          answer,
          sourceId: 'user',
          alternatives: [],
        },
      };
    }),
  };
}

export function exportHomeworkDraftYaml(draft: AnswerDraft, assessment: Assessment): string {
  const valid = validateBundle(draft, assessment);
  const metadata = {
    draft: JSON.parse(JSON.stringify(valid.draft)) as AnswerDraft,
    questions: valid.questions,
  };
  const entryById = new Map(valid.draft.entries.map((entry) => [entry.questionId, entry]));
  const lines = [
    `format: ${HOMEWORK_DRAFT_FORMAT}`,
    '# 只填写 answers；null 表示未作答。题型不支持时请保留 null。',
    '',
    valid.assessment.questions.length ? 'answers:' : 'answers: {}',
  ];
  for (const question of valid.assessment.questions) {
    const metadataQuestion = valid.questions.find((candidate) => candidate.id === question.id);
    const entry = entryById.get(question.id);
    if (metadataQuestion === undefined || entry === undefined) invalid(`missing draft entry for question ${question.id}`);
    lines.push(...renderAnswerComments(question, metadataQuestion));
    lines.push(`  ${JSON.stringify(question.id)}: ${JSON.stringify(compactAnswer(entry.answer, metadataQuestion))}`);
  }
  lines.push('', '# 以下校验信息由程序维护，请勿修改。', YAML.stringify({ metadata }).trimEnd());
  const text = `${lines.join('\n')}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_DRAFT_BYTES) invalid('homework draft exceeds the 4MiB limit');
  return text;
}

export function parseHomeworkDraft(text: string): AnswerDraft {
  return parseFile(parseDto(HomeworkDraftFileSchema, parseYaml(text), 'homework draft'));
}
