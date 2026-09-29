import { z } from 'zod';
import { ErrorDataSchema, JsonSchema, WarningSchema } from './errors.js';
import {
  AssessmentRefSchema,
  CourseRefSchema,
  LessonRefSchema,
  ResourceRefSchema,
  ScopeSchema,
  SystemSchema,
  ThreadRefSchema,
} from './refs.js';
import type { LessonRef } from './refs.js';
import type { ErrorData } from './errors.js';

const nonEmpty = z.string().min(1);
const nonNegativeInt = z
  .number()
  .refine(Number.isFinite)
  .refine(Number.isSafeInteger)
  .nonnegative();
const nonNegativeNumber = z.number().refine(Number.isFinite).nonnegative();
const nonNegativeIntNullable = nonNegativeInt.nullable();
const nonNegativeNumberNullable = nonNegativeNumber.nullable();
const stringNullable = z.string().nullable();

export const CourseSchema = z.object({
  ref: CourseRefSchema,
  title: nonEmpty,
  system: SystemSchema.nullable(),
  term: stringNullable,
  teachers: z.array(z.string()),
  locked: z.boolean().nullable(),
});
export type Course = z.infer<typeof CourseSchema>;

export const ResourceKindSchema = z.enum([
  'video',
  'document',
  'homework',
  'exam',
  'discussion',
  'unknown',
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceSchema = z.object({
  ref: ResourceRefSchema,
  title: z.string(),
  kind: ResourceKindSchema,
  path: z.array(z.string()),
  order: nonNegativeInt,
  durationSeconds: nonNegativeNumberNullable,
  locked: z.boolean().nullable(),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const OutlineNodeSchema: z.ZodType<OutlineNode> = z.lazy(() =>
  z.object({
    id: nonEmpty,
    title: z.string(),
    children: z.array(OutlineNodeSchema),
    resources: z.array(ResourceSchema),
  }),
);
export interface OutlineNode {
  id: string;
  title: string;
  children: OutlineNode[];
  resources: Resource[];
}

export const OutlineSchema = z.object({
  course: CourseRefSchema,
  roots: z.array(OutlineNodeSchema),
  completeness: z.enum(['complete', 'unknown']),
});
export type Outline = z.infer<typeof OutlineSchema>;

export const ProgressSchema = z.object({
  resource: ResourceRefSchema,
  serverCompleted: z.boolean().nullable(),
  serverFraction: z.number().refine(Number.isFinite).min(0).max(1).nullable(),
  serverSeconds: nonNegativeNumberNullable,
  durationSeconds: nonNegativeNumberNullable,
  observedAtMs: nonNegativeInt,
});
export type Progress = z.infer<typeof ProgressSchema>;

export const RichTextSchema = z.object({
  markdown: z.string(),
  plainText: z.string(),
  decodeState: z.enum(['not-needed', 'complete', 'partial', 'unavailable']),
  sourceHash: nonEmpty,
});
export type RichText = z.infer<typeof RichTextSchema>;

export const LessonSchema = z.object({
  ref: LessonRefSchema,
  title: z.string(),
  startsAtMs: nonNegativeIntNullable,
  finished: z.boolean().nullable(),
});
export type Lesson = z.infer<typeof LessonSchema>;

export const SlideDeckSchema = z.object({
  lesson: LessonRefSchema,
  presentationId: nonEmpty,
  title: z.string(),
  pages: z.array(z.object({ index: nonNegativeInt, assetId: nonEmpty })),
});
export type SlideDeck = z.infer<typeof SlideDeckSchema>;

export const MediaInfoSchema = z.object({
  resource: ResourceRefSchema,
  variants: z.array(
    z.object({
      id: nonEmpty,
      quality: z.string(),
      mimeType: z.string(),
      durationSeconds: nonNegativeNumberNullable,
    }),
  ),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

export const TranscriptSchema = z.object({
  language: z.string(),
  state: z.enum(['available', 'absent']),
  segments: z.array(
    z.object({ text: z.string(), startMs: nonNegativeInt, endMs: nonNegativeInt }),
  ),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const ArtifactSchema = z.object({
  id: nonEmpty,
  scope: ScopeSchema,
  filename: z.string(),
  mimeType: z.string(),
  bytes: nonNegativeInt,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha256'),
  createdAtMs: nonNegativeInt,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const AnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), keys: z.array(nonEmpty).min(1) }),
  z.object({ kind: z.literal('judgement'), value: z.boolean() }),
  z.object({
    kind: z.literal('fill-blank'),
    blanks: z.array(z.object({ id: nonEmpty, text: z.string() })),
  }),
  z.object({ kind: z.literal('short-answer'), text: z.string() }),
  z.object({ kind: z.literal('unset') }),
]);
export type Answer = z.infer<typeof AnswerSchema>;

export const QuestionKindSchema = z.enum([
  'single-choice',
  'multi-choice',
  'judgement',
  'fill-blank',
  'short-answer',
  'unknown',
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

export const AnswerEvidenceSchema = z.object({
  origin: z.enum(['user', 'platform-feedback', 'model']),
  answer: AnswerSchema,
  sourceId: nonEmpty,
  alternatives: z.array(z.object({ blankId: nonEmpty, texts: z.array(z.string()) })),
});
export type AnswerEvidence = z.infer<typeof AnswerEvidenceSchema>;

export const QuestionSchema = z.object({
  id: nonEmpty,
  kind: QuestionKindSchema,
  rawType: z.string(),
  body: RichTextSchema,
  options: z.array(z.object({ key: z.string(), body: RichTextSchema })),
  fingerprint: nonEmpty,
  attemptsUsed: nonNegativeIntNullable,
  maxAttempts: nonNegativeIntNullable,
  myAnswer: AnswerSchema.nullable(),
  feedback: AnswerEvidenceSchema.nullable(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AssessmentSchema = z.object({
  ref: AssessmentRefSchema,
  title: z.string(),
  state: z.enum(['not-started', 'in-progress', 'submitted', 'unknown']),
  timed: z.boolean().nullable(),
  fingerprint: nonEmpty,
  questions: z.array(QuestionSchema),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const AnswerDraftSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  ref: AssessmentRefSchema,
  fingerprint: nonEmpty,
  entries: z.array(
    z.object({
      questionId: nonEmpty,
      fingerprint: nonEmpty,
      answer: AnswerSchema,
      evidence: AnswerEvidenceSchema.nullable(),
    }),
  ),
});
export type AnswerDraft = z.infer<typeof AnswerDraftSchema>;

export const FeedbackSetSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  ref: AssessmentRefSchema,
  questions: z.array(QuestionSchema),
});
export type FeedbackSet = z.infer<typeof FeedbackSetSchema>;

export const MatchSchema = z.object({
  questionId: nonEmpty,
  state: z.enum(['exact', 'suggested', 'ambiguous', 'missing', 'blocked']),
  answer: AnswerSchema.nullable(),
  sourceId: stringNullable,
  reason: z.string(),
});
export type Match = z.infer<typeof MatchSchema>;

export const ThreadSchema = z.object({
  ref: ThreadRefSchema,
  body: RichTextSchema,
  replies: z.array(z.object({ id: nonEmpty, body: RichTextSchema, own: z.boolean() })),
  nextCursor: stringNullable,
});
export type Thread = z.infer<typeof ThreadSchema>;

export const DiscussionDraftSchema = z.object({
  id: nonEmpty,
  ref: ThreadRefSchema,
  text: z.string(),
  sourceHash: nonEmpty,
  origin: z.enum(['user', 'model']),
});
export type DiscussionDraft = z.infer<typeof DiscussionDraftSchema>;

export const CapabilitySchema = z.object({
  id: nonEmpty,
  system: SystemSchema.nullable(),
  state: z.enum(['ready', 'unverified', 'unimplemented', 'unsupported', 'missing-runtime']),
  reason: stringNullable,
});
export type Capability = z.infer<typeof CapabilitySchema>;

export const SessionViewSchema = z.object({
  scope: ScopeSchema,
  generation: z.number().refine(Number.isFinite).refine(Number.isSafeInteger).positive(),
  displayName: stringNullable,
  platformUserId: stringNullable,
  identityVerified: z.boolean(),
  checkedAtMs: nonNegativeInt,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const ProbeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('valid'), session: SessionViewSchema }),
  z.object({ state: z.literal('expired') }),
  z.object({ state: z.literal('indeterminate'), error: ErrorDataSchema }),
]);
export type Probe = z.infer<typeof ProbeSchema>;

export const QrDisplaySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('png'), base64: z.string() }),
]);
export type QrDisplay = z.infer<typeof QrDisplaySchema>;

export const AuthEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('qr'),
    generation: nonNegativeInt,
    qr: QrDisplaySchema,
    expiresAtMs: nonNegativeInt,
  }),
  z.object({ type: z.literal('waiting'), generation: nonNegativeInt }),
  z.object({ type: z.literal('scanned'), generation: nonNegativeInt }),
  z.object({ type: z.literal('exchanging'), generation: nonNegativeInt }),
  z.object({ type: z.literal('authenticated'), session: SessionViewSchema }),
  z.object({ type: z.literal('failed'), error: ErrorDataSchema }),
  z.object({ type: z.literal('canceled') }),
]);
export type AuthEvent = z.infer<typeof AuthEventSchema>;

export const LoginInputSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('qr'),
    variant: z.enum(['default', 'native']).optional(),
  }),
  z.object({
    method: z.literal('password'),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
]);
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const StudySettingsSchema = z.object({
  speed: z.number().refine(Number.isFinite).positive(),
  targetFraction: z.number().refine(Number.isFinite).min(0).max(1),
  questionMode: z.enum(['pause', 'reviewed', 'model']),
  maxDurationSeconds: z.number().refine(Number.isFinite).refine(Number.isSafeInteger).positive(),
});
export type StudySettings = z.infer<typeof StudySettingsSchema>;

const ActionKindSchema = z.enum([
  'homework.apply',
  'exam.start',
  'exam.save',
  'exam.finalize',
  'discussion.post',
  'study',
  'document.visit',
  'live.join',
  'live.answer',
]);

export const ActionInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('homework.apply'),
    draft: AnswerDraftSchema,
    questionIds: z.array(nonEmpty),
  }),
  z.object({ kind: z.literal('exam.start'), ref: AssessmentRefSchema }),
  z.object({ kind: z.literal('exam.save'), draft: AnswerDraftSchema }),
  z.object({ kind: z.literal('exam.finalize'), draft: AnswerDraftSchema }),
  z.object({ kind: z.literal('discussion.post'), draft: DiscussionDraftSchema }),
  z.object({
    kind: z.literal('study'),
    resources: z.array(ResourceRefSchema),
    settings: StudySettingsSchema,
  }),
  z.object({ kind: z.literal('document.visit'), resource: ResourceRefSchema }),
  z.object({
    kind: z.literal('live.join'),
    lesson: LessonRefSchema,
    maxDurationSeconds: z.number().refine(Number.isFinite).refine(Number.isSafeInteger).positive(),
  }),
  z.object({
    kind: z.literal('live.answer'),
    liveJobId: nonEmpty,
    questionId: nonEmpty,
    phaseId: nonEmpty,
    answer: AnswerSchema,
  }),
]);
export type ActionInput = z.infer<typeof ActionInputSchema>;

export const PreviewSchema = z.object({
  id: nonEmpty,
  scope: ScopeSchema,
  kind: ActionKindSchema,
  digest: nonEmpty,
  generation: nonNegativeInt,
  expiresAtMs: nonNegativeInt,
  description: z.string(),
  startsTimer: z.boolean(),
  finalSubmission: z.boolean(),
  blockers: z.array(z.string()),
  warnings: z.array(WarningSchema).default([]),
});
export type Preview = z.infer<typeof PreviewSchema>;

export const ReceiptSchema = z.object({
  operationId: nonEmpty,
  state: z.enum(['confirmed', 'uncertain', 'rejected']),
  message: z.string(),
  result: JsonSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'paused',
  'needs-input',
  'uncertain',
  'succeeded',
  'partial',
  'failed',
  'canceled',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ItemResultSchema = z.object({
  key: nonEmpty,
  state: z.enum(['succeeded', 'failed', 'skipped', 'needs-input', 'uncertain']),
  message: stringNullable,
  artifacts: z.array(ArtifactSchema),
});
export type ItemResult = z.infer<typeof ItemResultSchema>;

export const JobSchema = z.object({
  id: nonEmpty,
  scope: ScopeSchema,
  kind: z.enum(['export', 'study', 'homework', 'live']),
  status: JobStatusSchema,
  createdAtMs: nonNegativeInt,
  updatedAtMs: nonNegativeInt,
  nextRunAtMs: nonNegativeIntNullable,
  completed: nonNegativeInt,
  total: nonNegativeIntNullable,
  items: z.array(ItemResultSchema),
  warnings: z.array(WarningSchema),
});
export type Job = z.infer<typeof JobSchema>;

export const JobEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), sequence: nonNegativeInt, job: JobSchema }),
  z.object({
    type: z.literal('progress'),
    sequence: nonNegativeInt,
    jobId: nonEmpty,
    resourceKey: z.string(),
    estimatedSeconds: nonNegativeNumberNullable,
    serverFraction: z.number().refine(Number.isFinite).min(0).max(1).nullable(),
  }),
  z.object({
    type: z.literal('question'),
    sequence: nonNegativeInt,
    jobId: nonEmpty,
    phaseId: nonEmpty,
    question: QuestionSchema,
    closesAtMs: nonNegativeIntNullable,
  }),
  z.object({ type: z.literal('gap'), sequence: nonNegativeInt, jobId: nonEmpty, message: z.string() }),
]);
export type JobEvent = z.infer<typeof JobEventSchema>;

export const ExecutionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('receipt'), receipt: ReceiptSchema }),
  z.object({ type: z.literal('job'), job: JobSchema }),
]);
export type Execution = z.infer<typeof ExecutionSchema>;

export const ExportInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('media'),
    resources: z.array(ResourceRefSchema),
    quality: z.enum(['best', 'hd', 'sd']),
    subtitles: z.boolean(),
  }),
  z.object({
    type: z.literal('assessments'),
    refs: z.array(AssessmentRefSchema),
    format: z.enum(['json', 'markdown', 'yaml']),
  }),
  z.object({
    type: z.literal('slides'),
    lessons: z.array(LessonRefSchema),
    format: z.enum(['images', 'pdf']),
    liveJobId: stringNullable,
  }),
]);
export type ExportInput = z.infer<typeof ExportInputSchema>;

export interface AuthFlow {
  id: string;
  events: AsyncIterable<AuthEvent>;
  result: Promise<SessionView>;
  cancel(): Promise<void>;
}

export interface DecodeResult {
  mapping: { from: string; to: string; score: number }[];
  unresolved: string[];
  rendererVersion: string;
}

export type RenderInput =
  | { type: 'font.decode'; fontArtifactId: string; characters: string[] }
  | { type: 'pdf.compose'; imageArtifactIds: string[]; title: string }
  | { type: 'slides.legacy'; lesson: LessonRef; approvedUrl: string; sessionGeneration: number };

export type RenderOutput =
  | { type: 'font.decode'; decoded: DecodeResult }
  | { type: 'pdf.compose'; artifact: Artifact }
  | { type: 'slides.legacy'; slides: SlideDeck[] };

export type RenderState =
  | { status: 'running' }
  | { status: 'succeeded'; result: RenderOutput }
  | { status: 'failed'; error: ErrorData }
  | { status: 'missing' };
