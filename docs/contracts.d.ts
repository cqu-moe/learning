/** learning 1.1 specification declarations (SDK + CLI phase). This is not an SDK implementation. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Platform = 'ykt' | 'xuetang' | 'zhs';
export type System = 'ykt-standard' | 'ykt-kg' | 'xuetang' | 'zhs-share' | 'zhs-hike';
export interface Scope { userId: string; profileId: string; platform: Platform }
export interface Options { signal?: AbortSignal; deadlineAtMs?: number }
export interface Warning { code: string; message: string; resourceKey: string | null }
export interface Result<T> { value: T; warnings: Warning[] }
export interface Page<T> { items: T[]; nextCursor: string | null; completeness: 'complete' | 'more' | 'unknown'; warnings: Warning[] }
export interface PageInput { cursor?: string; limit?: number }
export type CourseLocator =
  | { kind: 'ykt'; classroomId: string }
  | { kind: 'xuetang'; classroomId: string; courseSign: string; skuId: string }
  | { kind: 'zhs-share'; recruitAndCourseId: string }
  | { kind: 'zhs-hike'; courseId: string };
export interface CourseRef { scope: Scope; key: string; native: CourseLocator }
export type ResourceLocator =
  | { kind: 'ykt'; leafId: string; leafInfoId: string | null }
  | { kind: 'xuetang'; leafId: string; leafInfoId: string | null }
  | { kind: 'zhs-share'; chapterId: string; lessonId: string; smallLessonId: string; videoId: string }
  | { kind: 'zhs-hike'; fileId: string };
export interface ResourceRef { course: CourseRef; key: string; native: ResourceLocator }
export interface LessonRef { scope: Scope; course: CourseRef | null; lessonId: string }
export interface AssessmentRef { resource: ResourceRef; kind: 'homework' | 'exam' | 'embedded'; assessmentId: string }
export interface ThreadRef { resource: ResourceRef; topicId: string }
export interface Course { ref: CourseRef; title: string; system: System | null; term: string | null; teachers: string[]; locked: boolean | null }
export type ResourceKind = 'video' | 'document' | 'homework' | 'exam' | 'discussion' | 'unknown';
export interface Resource { ref: ResourceRef; title: string; kind: ResourceKind; path: string[]; order: number; durationSeconds: number | null; locked: boolean | null }
export interface OutlineNode { id: string; title: string; children: OutlineNode[]; resources: Resource[] }
export interface Outline { course: CourseRef; roots: OutlineNode[]; completeness: 'complete' | 'unknown' }
export interface Progress { resource: ResourceRef; serverCompleted: boolean | null; serverFraction: number | null; serverSeconds: number | null; durationSeconds: number | null; observedAtMs: number }
export interface RichText { markdown: string; plainText: string; decodeState: 'not-needed' | 'complete' | 'partial' | 'unavailable'; sourceHash: string }
export interface Lesson { ref: LessonRef; title: string; startsAtMs: number | null; finished: boolean | null }
export interface SlideDeck { lesson: LessonRef; presentationId: string; title: string; pages: { index: number; assetId: string }[] }
export interface MediaInfo { resource: ResourceRef; variants: { id: string; quality: string; mimeType: string; durationSeconds: number | null }[] }
export interface Transcript { language: string; state: 'available' | 'absent'; segments: { text: string; startMs: number; endMs: number }[] }
export interface Artifact { id: string; scope: Scope; filename: string; mimeType: string; bytes: number; sha256: string; createdAtMs: number }
export type Answer =
  | { kind: 'choice'; keys: string[] }
  | { kind: 'judgement'; value: boolean }
  | { kind: 'fill-blank'; blanks: { id: string; text: string }[] }
  | { kind: 'short-answer'; text: string }
  | { kind: 'unset' };
export type QuestionKind = 'single-choice' | 'multi-choice' | 'judgement' | 'fill-blank' | 'short-answer' | 'unknown';
export interface AnswerEvidence { origin: 'user' | 'platform-feedback' | 'model'; answer: Answer; sourceId: string; alternatives: { blankId: string; texts: string[] }[] }
export interface Question { id: string; kind: QuestionKind; rawType: string; body: RichText; options: { key: string; body: RichText }[]; fingerprint: string; attemptsUsed: number | null; maxAttempts: number | null; myAnswer: Answer | null; feedback: AnswerEvidence | null }
export interface Assessment { ref: AssessmentRef; title: string; state: 'not-started' | 'in-progress' | 'submitted' | 'unknown'; timed: boolean | null; fingerprint: string; questions: Question[] }
export interface AnswerDraft { schemaVersion: 1; id: string; ref: AssessmentRef; fingerprint: string; entries: { questionId: string; fingerprint: string; answer: Answer; evidence: AnswerEvidence | null }[] }
export interface FeedbackSet { schemaVersion: 1; id: string; ref: AssessmentRef; questions: Question[] }
export interface Match { questionId: string; state: 'exact' | 'suggested' | 'ambiguous' | 'missing' | 'blocked'; answer: Answer | null; sourceId: string | null; reason: string }
export interface Thread { ref: ThreadRef; body: RichText; replies: { id: string; body: RichText; own: boolean }[]; nextCursor: string | null }
export interface DiscussionDraft { id: string; ref: ThreadRef; text: string; sourceHash: string; origin: 'user' | 'model' }
export interface Capability { id: string; system: System | null; state: 'ready' | 'unverified' | 'unimplemented' | 'unsupported' | 'missing-runtime'; reason: string | null }
export interface SessionView { scope: Scope; generation: number; displayName: string | null; platformUserId: string | null; identityVerified: boolean; checkedAtMs: number }
export type Probe = { state: 'valid'; session: SessionView } | { state: 'expired' } | { state: 'indeterminate'; error: ErrorData };
export type QrDisplay = { type: 'text'; value: string } | { type: 'png'; base64: string } | { type: 'jpeg'; base64: string };
export type AuthEvent =
  | { type: 'qr'; generation: number; qr: QrDisplay; expiresAtMs: number }
  | { type: 'waiting' | 'scanned' | 'exchanging'; generation: number }
  | { type: 'authenticated'; session: SessionView }
  | { type: 'failed'; error: ErrorData }
  | { type: 'canceled' };
export interface AuthFlow { id: string; events: AsyncIterable<AuthEvent>; result: Promise<SessionView>; cancel(): Promise<void> }
export type LoginInput = { method: 'qr'; variant?: 'default' | 'native' } | { method: 'password'; username: string; password: string };
export interface StudySettings { speed: number; targetFraction: number; questionMode: 'pause' | 'reviewed' | 'model'; maxDurationSeconds: number }
export type ActionInput =
  | { kind: 'homework.apply'; draft: AnswerDraft; questionIds: string[] }
  | { kind: 'exam.start'; ref: AssessmentRef }
  | { kind: 'exam.save' | 'exam.finalize'; draft: AnswerDraft }
  | { kind: 'discussion.post'; draft: DiscussionDraft }
  | { kind: 'study'; resources: ResourceRef[]; settings: StudySettings }
  | { kind: 'document.visit'; resource: ResourceRef }
  | { kind: 'live.join'; lesson: LessonRef; maxDurationSeconds: number }
  | { kind: 'live.answer'; liveJobId: string; questionId: string; phaseId: string; answer: Answer };
export interface Preview { id: string; scope: Scope; kind: ActionInput['kind']; digest: string; generation: number; expiresAtMs: number; description: string; startsTimer: boolean; finalSubmission: boolean; blockers: string[]; warnings: Warning[] }
export interface Receipt { operationId: string; state: 'confirmed' | 'uncertain' | 'rejected'; message: string; result: Json }
export type Execution = { type: 'receipt'; receipt: Receipt } | { type: 'job'; job: Job };
export type ExportInput =
  | { type: 'media'; resources: ResourceRef[]; quality: 'best' | 'hd' | 'sd'; subtitles: boolean }
  | { type: 'assessments'; refs: AssessmentRef[]; format: 'json' | 'markdown' | 'yaml' }
  | { type: 'slides'; lessons: LessonRef[]; format: 'images' | 'pdf'; liveJobId: string | null };
export type JobStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'needs-input' | 'uncertain' | 'succeeded' | 'partial' | 'failed' | 'canceled';
export interface ItemResult { key: string; state: 'succeeded' | 'failed' | 'skipped' | 'needs-input' | 'uncertain'; message: string | null; artifacts: Artifact[] }
export interface Job { id: string; scope: Scope; kind: 'export' | 'study' | 'homework' | 'live'; status: JobStatus; createdAtMs: number; updatedAtMs: number; nextRunAtMs: number | null; completed: number; total: number | null; items: ItemResult[]; warnings: Warning[] }
export type JobEvent =
  | { sequence: number; type: 'state'; job: Job }
  | { sequence: number; type: 'progress'; jobId: string; resourceKey: string; estimatedSeconds: number | null; serverFraction: number | null; title?: string | null; durationSeconds?: number | null; serverSeconds?: number | null }
  | { sequence: number; type: 'question'; jobId: string; phaseId: string; question: Question; closesAtMs: number | null }
  | { sequence: number; type: 'gap'; jobId: string; message: string };
export type ErrorCode = 'INVALID_INPUT' | 'AUTH_REQUIRED' | 'AUTH_EXPIRED' | 'FORBIDDEN' | 'INTERACTION_REQUIRED' | 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'PROTOCOL' | 'UNSUPPORTED' | 'MISSING_RUNTIME' | 'CONFLICT' | 'PREVIEW_EXPIRED' | 'PRECONDITION_CHANGED' | 'UNCERTAIN' | 'CANCELED' | 'BUDGET' | 'INTEGRITY' | 'CONTENT_UNREADABLE' | 'STORAGE' | 'VERSION';
export interface ErrorData { code: ErrorCode; message: string; retryAfterMs: number | null; operationId: string | null }
export interface LearningClient {
  readonly scope: Scope;
  capabilities(): Capability[];
  auth: {
    begin(input: LoginInput, options?: Options): Promise<AuthFlow>;
    probe(options?: Options): Promise<Probe>;
    importLegacy(input: { format: 'ykt' | 'xuetang' | 'zhs' | 'cookie-array'; text: string }, options?: Options): Promise<Result<SessionView>>;
    disconnect(options?: Options): Promise<void>;
  };
  catalog: {
    resolveCourse(url: string, options?: Options): Promise<CourseRef>;
    courses(input?: PageInput, options?: Options): Promise<Page<Course>>;
    outline(course: CourseRef, options?: Options): Promise<Result<Outline>>;
    progress(resource: ResourceRef, options?: Options): Promise<Result<Progress>>;
  };
  resources: {
    media(resource: ResourceRef, options?: Options): Promise<MediaInfo>;
    transcript(resource: ResourceRef, options?: Options): Promise<Result<Transcript>>;
    lessons(course: CourseRef, page?: PageInput, options?: Options): Promise<Page<Lesson>>;
    slides(lesson: LessonRef, liveJobId?: string, options?: Options): Promise<Result<SlideDeck[]>>;
    resolveLesson(url: string, options?: Options): Promise<LessonRef>;
  };
  assessments: {
    resolve(resource: ResourceRef, options?: Options): Promise<AssessmentRef[]>;
    get(ref: AssessmentRef, options?: Options): Promise<Assessment>;
    draft(ref: AssessmentRef, options?: Options): Promise<AnswerDraft>;
    importDraft(text: string, format: 'learning' | 'ykt' | 'xuetang', options?: Options): Promise<Result<AnswerDraft>>;
    importFeedback(text: string, ref: AssessmentRef, options?: Options): Promise<FeedbackSet>;
    match(draft: AnswerDraft, sources: FeedbackSet[], options?: Options): Promise<Match[]>;
    propose(draft: AnswerDraft, questionIds: string[], options?: Options): Promise<Match[]>;
  };
  discussions: {
    resolve(resource: ResourceRef, options?: Options): Promise<ThreadRef>;
    get(ref: ThreadRef, page?: PageInput, options?: Options): Promise<Thread>;
    draft(ref: ThreadRef, options?: Options): Promise<DiscussionDraft>;
    propose(ref: ThreadRef, options?: Options): Promise<DiscussionDraft>;
  };
  actions: {
    prepare(input: ActionInput, options?: Options): Promise<Preview>;
    execute(previewId: string, options?: Options): Promise<Execution>;
    reconcile(operationId: string, options?: Options): Promise<Receipt>;
  };
  jobs: {
    createExport(input: ExportInput, options?: Options): Promise<Job>;
    get(jobId: string, options?: Options): Promise<Job>;
    list(input?: PageInput, options?: Options): Promise<Page<Job>>;
    events(jobId: string, afterSequence: number, options?: Options): Promise<JobEvent[]>;
    advance(jobId: string, options?: Options): Promise<Job>;
    pause(jobId: string, options?: Options): Promise<Job>;
    resume(jobId: string, options?: Options): Promise<Job>;
    cancel(jobId: string, options?: Options): Promise<Job>;
  };
  close(): Promise<void>;
}
export interface StoredValue { revision: number; value: Json }
export interface StateStore {
  get(key: string): Promise<StoredValue | null>;
  list(prefix: string, cursor: string | null, limit: number): Promise<{ items: { key: string; record: StoredValue }[]; nextCursor: string | null }>;
  commit(input: { expected: { key: string; revision: number | null }[]; changes: { key: string; value: Json | null }[] }): Promise<boolean>;
}
export interface BlobWriter { write(bytes: Uint8Array): Promise<void>; checkpoint(): Promise<Json>; finish(): Promise<{ bytes: number; sha256: string }>; abort(): Promise<void> }
export interface ArtifactStore {
  create(input: { id: string; mimeType: string }): Promise<BlobWriter>;
  resume(input: { id: string; checkpoint: Json }): Promise<BlobWriter>;
  open(id: string, options?: Options): Promise<ReadableStream<Uint8Array>>;
  remove(id: string): Promise<void>;
}
export interface Socket { send(message: string): Promise<void>; messages: AsyncIterable<string | Uint8Array>; close(): Promise<void> }
export interface Transport {
  fetch(input: Request): Promise<Response>;
  connect(input: { url: string; headers: Record<string, string>; signal: AbortSignal }): Promise<Socket>;
}
export interface Clock { nowMs(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
export interface DecodeResult { mapping: { from: string; to: string; score: number }[]; unresolved: string[]; rendererVersion: string }
export type RenderInput =
  | { type: 'font.decode'; fontArtifactId: string; characters: string[] }
  | { type: 'pdf.compose'; imageArtifactIds: string[]; title: string }
  | { type: 'slides.legacy'; lesson: LessonRef; approvedUrl: string; sessionGeneration: number };
export type RenderOutput = { type: 'font.decode'; decoded: DecodeResult } | { type: 'pdf.compose'; artifact: Artifact } | { type: 'slides.legacy'; slides: SlideDeck[] };
export type RenderState = { status: 'running' } | { status: 'succeeded'; result: RenderOutput } | { status: 'failed'; error: ErrorData } | { status: 'missing' };
export interface HeavyRenderer {
  start(input: { taskId: string; attempt: number; request: RenderInput; deadlineAtMs: number }, options?: Options): Promise<void>;
  status(taskId: string, attempt: number, options?: Options): Promise<RenderState>;
  cancel(taskId: string, attempt: number): Promise<void>;
}
export interface ModelClient { propose(input: { purpose: 'answers' | 'discussion'; content: Json; signal: AbortSignal }): Promise<unknown> }
export interface Runtime {
  transport: Transport;
  state: StateStore;
  artifacts: ArtifactStore;
  clock: Clock;
  masterKey: Uint8Array;
  heavy: HeavyRenderer | null;
  model: ModelClient | null;
  probeMediaDuration?: (url: string, options?: Options) => Promise<number | null>;
  log(event: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; fields: Record<string, string | number | boolean | null> }): void;
  wake(): Promise<void>;
}
export declare function createLearningClient(input: { scope: Scope; runtime: Runtime }): LearningClient;
export declare function aggregateCourses(clients: LearningClient[], options?: Options): Promise<({ scope: Scope; page: Page<Course> } | { scope: Scope; error: ErrorData })[]>;
