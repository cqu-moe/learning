import type {
  ActionInput,
  Assessment,
  AuthFlow,
  Capability,
  Course,
  DiscussionDraft,
  AnswerDraft,
  Execution,
  ExportInput,
  FeedbackSet,
  Job,
  JobEvent,
  Lesson,
  LoginInput,
  Match,
  MediaInfo,
  Outline,
  Receipt,
  Preview,
  Progress,
  Probe,
  SessionView,
  SlideDeck,
  Thread,
  Transcript,
} from './models.js';
import type { AssessmentRef, CourseRef, LessonRef, ResourceRef, Scope, ThreadRef } from './refs.js';
import type { Page, PageInput, Result } from './errors.js';
import type { Options } from '../runtime/types.js';

export interface LearningClient {
  readonly scope: Scope;
  capabilities(): Capability[];
  auth: {
    begin(input: LoginInput, options?: Options): Promise<AuthFlow>;
    probe(options?: Options): Promise<Probe>;
    importLegacy(
      input: { format: 'ykt' | 'xuetang' | 'zhs' | 'cookie-array'; text: string },
      options?: Options,
    ): Promise<Result<SessionView>>;
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
