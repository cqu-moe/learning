// Stable SDK entry: client factory + aggregate helper over the safe public surface.
export * from './public.js';
export type { LearningClient } from './types/client.js';

import { LearningError } from './types/errors.js';
import type { ErrorData } from './types/errors.js';
import type { Platform, Scope } from './types/refs.js';
import type { AuthFlow, Capability, Course } from './types/models.js';
import type { Page } from './types/errors.js';
import type { LearningClient } from './types/client.js';
import type { Options, Runtime } from './runtime/types.js';
import { createSessionHttp, SessionCookieJar } from './http/client.js';
import { AuthLifecycle } from './auth/flow.js';
import { importLegacyCookies } from './auth/legacy.js';
import type { LegacyCookie } from './auth/legacy.js';
import { readSession, revokeSession } from './session/store.js';
import { yktCourses, yktOutline, yktResolveCourse } from './providers/ykt/catalog.js';
import { yktProbeProvider, yktQrLaunch } from './providers/ykt/auth.js';
import { yktLessons, yktMedia, yktSlides, yktTranscript } from './providers/ykt/resources.js';
import { yktAssessmentGet, yktAssessmentsResolve } from './providers/ykt/assessments.js';
import { yktExamRead } from './providers/ykt/exam-read.js';
import { xtxCourses, xtxOutline } from './providers/xuetang/catalog.js';
import { xtxProbeProvider, xtxQrLaunch } from './providers/xuetang/auth.js';
import { xtxMedia, xtxTranscript } from './providers/xuetang/resources.js';
import { xtxExamRead, xtxExamResolve } from './providers/xuetang/exam-read.js';
import { probeSession } from './auth/flow.js';

const PLATFORM_HOSTS: Record<Platform, string[]> = {
  ykt: ['yuketang.cn', 'xuetangx.com'],
  xuetang: ['xuetangx.com'],
  zhs: ['zhihuishu.com'],
};

function unsupported(platform: Platform, what: string): LearningError {
  return new LearningError({
    code: 'UNSUPPORTED',
    message: `${platform}.${what} is not implemented in this build`,
    retryAfterMs: null,
    operationId: null,
  });
}

function asyncUnsupported<T>(platform: Platform, what: string): Promise<T> {
  return Promise.reject(unsupported(platform, what));
}

const CAPABILITY_IDS = [
  'auth.begin',
  'auth.probe',
  'auth.importLegacy',
  'catalog.courses',
  'catalog.outline',
  'catalog.progress',
  'resources.media',
  'resources.transcript',
  'resources.lessons',
  'resources.slides',
  'assessments.get',
  'assessments.draft',
  'assessments.match',
  'discussions.get',
  'actions.prepare',
  'jobs.createExport',
] as const;

const IMPLEMENTED: Record<Platform, Set<string>> = {
  ykt: new Set(['auth.begin', 'auth.probe', 'auth.importLegacy', 'catalog.courses', 'catalog.outline', 'catalog.resolveCourse', 'resources.media', 'resources.transcript', 'resources.lessons', 'resources.slides', 'assessments.resolve', 'assessments.get']),
  xuetang: new Set(['auth.begin', 'auth.probe', 'auth.importLegacy', 'catalog.courses', 'catalog.outline', 'resources.media', 'resources.transcript', 'assessments.resolve', 'assessments.get']),
  zhs: new Set(['auth.importLegacy']),
};

function capabilitiesFor(platform: Platform): Capability[] {
  const implemented = IMPLEMENTED[platform];
  return CAPABILITY_IDS.map((id) => ({
    id: `${platform}.${id}`,
    system: null,
    state: implemented.has(id) ? ('unverified' as const) : ('unimplemented' as const),
    reason: implemented.has(id) ? 'fixture-tested; no live platform verification yet' : 'provider implementation lands in a later task',
  }));
}

export function createLearningClient(input: { scope: Scope; runtime: Runtime }): LearningClient {
  const { scope, runtime } = input;
  const sessionBox = { jar: new SessionCookieJar(), hydrated: false };
  const lifecycle = new AuthLifecycle({ scope, clock: runtime.clock, state: runtime.state, masterKey: runtime.masterKey });
  const httpBound = async () => {
    if (!sessionBox.hydrated) {
      const record = await readSession(runtime.state, runtime.masterKey, scope);
      if (record !== null) {
        sessionBox.jar = await SessionCookieJar.deserialize(record.cookieJar);
      }
      sessionBox.hydrated = true;
    }
    return createSessionHttp({
      transport: runtime.transport,
      clock: runtime.clock,
      jar: sessionBox.jar,
      allowHosts: PLATFORM_HOSTS[scope.platform],
    });
  };
  new AuthLifecycle({ scope, clock: runtime.clock, state: runtime.state, masterKey: runtime.masterKey });
  const platform = scope.platform;
  return {
    scope,
    capabilities: () => capabilitiesFor(platform),
    auth: {
      begin: async (loginInput): Promise<AuthFlow> => {
        if (platform === 'ykt' && loginInput.method === 'qr') {
          const http = await httpBound();
          return lifecycle.begin(yktQrLaunch({ http, jar: sessionBox.jar, clock: runtime.clock }));
        }
        if (platform === 'xuetang' && loginInput.method === 'qr') {
          const http = await httpBound();
          return lifecycle.begin(xtxQrLaunch({ http, jar: sessionBox.jar, transport: runtime.transport, clock: runtime.clock }));
        }
        throw unsupported(platform, `auth.begin(${loginInput.method})`);
      },
      probe: async () => {
        if (platform === 'ykt') {
          return probeSession({
            scope,
            state: runtime.state,
            masterKey: runtime.masterKey,
            provider: yktProbeProvider({ http: await httpBound(), clock: runtime.clock }),
          });
        }
        if (platform === 'xuetang') {
          return probeSession({
            scope,
            state: runtime.state,
            masterKey: runtime.masterKey,
            provider: xtxProbeProvider({ http: await httpBound(), clock: runtime.clock }),
          });
        }
        return asyncUnsupported(platform, 'auth.probe');
      },
      importLegacy: async (legacyInput) => {
        if (legacyInput.format === 'cookie-array') {
          return importLegacyCookies(runtime, scope, JSON.parse(legacyInput.text) as LegacyCookie[]);
        }
        return asyncUnsupported(platform, `auth.importLegacy(${legacyInput.format})`);
      },
      disconnect: async () => {
        const record = await readSession(runtime.state, runtime.masterKey, scope);
        await revokeSession(runtime.state, runtime.masterKey, scope, record?.generation ?? 0);
      },
    },
    catalog: {
      resolveCourse: async (url) => {
        if (platform === 'ykt') return yktResolveCourse(scope, url);
        return asyncUnsupported(platform, `catalog.resolveCourse(${url})`);
      },
      courses: async (): Promise<Page<Course>> => {
        if (platform === 'ykt') return yktCourses(await httpBound(), scope);
        if (platform === 'xuetang') return xtxCourses(await httpBound(), scope);
        return asyncUnsupported(platform, 'catalog.courses');
      },
      outline: async (course) => {
        if (platform === 'ykt') return yktOutline(await httpBound(), scope, course);
        if (platform === 'xuetang') return xtxOutline(await httpBound(), course);
        return asyncUnsupported(platform, `catalog.outline(${course.key})`);
      },
      progress: (resource) => asyncUnsupported(platform, `catalog.progress(${resource.key})`),
    },
    resources: {
      media: async (resource) => {
        if (platform === 'ykt') return yktMedia(await httpBound(), resource);
        if (platform === 'xuetang') return xtxMedia(await httpBound(), resource);
        return asyncUnsupported(platform, `resources.media(${resource.key})`);
      },
      transcript: async (resource) => {
        if (platform === 'ykt') return yktTranscript(await httpBound(), resource);
        if (platform === 'xuetang') return xtxTranscript(await httpBound(), resource);
        return asyncUnsupported(platform, `resources.transcript(${resource.key})`);
      },
      lessons: async (course) => {
        if (platform === 'ykt') return yktLessons(await httpBound(), course);
        return asyncUnsupported(platform, 'resources.lessons');
      },
      slides: async (lesson) => {
        if (platform === 'ykt') return yktSlides(await httpBound(), lesson);
        return asyncUnsupported(platform, `resources.slides(${lesson.lessonId})`);
      },
      resolveLesson: (url) => asyncUnsupported(platform, `resources.resolveLesson(${url})`),
    },
    assessments: {
      resolve: async (resource) => {
        if (platform === 'ykt') return yktAssessmentsResolve(await httpBound(), resource);
        if (platform === 'xuetang') return xtxExamResolve(await httpBound(), resource);
        return asyncUnsupported(platform, `assessments.resolve(${resource.key})`);
      },
      get: async (ref) => {
        if (platform === 'ykt') {
          if (ref.kind === 'exam') return yktExamRead(await httpBound(), ref);
          return yktAssessmentGet(await httpBound(), ref);
        }
        if (platform === 'xuetang' && ref.kind === 'exam') return xtxExamRead(await httpBound(), ref);
        return asyncUnsupported(platform, `assessments.get(${ref.assessmentId})`);
      },
      draft: (ref) => asyncUnsupported(platform, `assessments.draft(${ref.assessmentId})`),
      importDraft: (_text, format) => asyncUnsupported(platform, `assessments.importDraft(${format})`),
      importFeedback: (_text, ref) => asyncUnsupported(platform, `assessments.importFeedback(${ref.assessmentId})`),
      match: () => asyncUnsupported(platform, 'assessments.match'),
      propose: () => asyncUnsupported(platform, 'assessments.propose'),
    },
    discussions: {
      resolve: (resource) => asyncUnsupported(platform, `discussions.resolve(${resource.key})`),
      get: (ref) => asyncUnsupported(platform, `discussions.get(${ref.topicId})`),
      draft: (ref) => asyncUnsupported(platform, `discussions.draft(${ref.topicId})`),
      propose: (ref) => asyncUnsupported(platform, `discussions.propose(${ref.topicId})`),
    },
    actions: {
      prepare: (actionInput) => asyncUnsupported(platform, `actions.prepare(${actionInput.kind})`),
      execute: (previewId) => asyncUnsupported(platform, `actions.execute(${previewId})`),
      reconcile: (operationId) => asyncUnsupported(platform, `actions.reconcile(${operationId})`),
    },
    jobs: {
      createExport: (exportInput) => asyncUnsupported(platform, `jobs.createExport(${exportInput.type})`),
      get: (jobId) => asyncUnsupported(platform, `jobs.get(${jobId})`),
      list: () => asyncUnsupported(platform, 'jobs.list'),
      events: (jobId) => asyncUnsupported(platform, `jobs.events(${jobId})`),
      advance: (jobId) => asyncUnsupported(platform, `jobs.advance(${jobId})`),
      pause: (jobId) => asyncUnsupported(platform, `jobs.pause(${jobId})`),
      resume: (jobId) => asyncUnsupported(platform, `jobs.resume(${jobId})`),
      cancel: (jobId) => asyncUnsupported(platform, `jobs.cancel(${jobId})`),
    },
    close: async () => {},
  };
}

export async function aggregateCourses(
  clients: LearningClient[],
  _options?: Options,
): Promise<({ scope: Scope; page: Page<Course> } | { scope: Scope; error: ErrorData })[]> {
  const results: ({ scope: Scope; page: Page<Course> } | { scope: Scope; error: ErrorData })[] = [];
  for (const client of clients) {
    try {
      const page = await client.catalog.courses();
      results.push({ scope: client.scope, page });
    } catch (error) {
      results.push({
        scope: client.scope,
        error:
          error instanceof LearningError
            ? error.data
            : { code: 'PROTOCOL', message: 'course aggregation failed', retryAfterMs: null, operationId: null },
      });
    }
  }
  return results;
}
