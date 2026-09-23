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

function capabilitiesFor(platform: Platform): Capability[] {
  return CAPABILITY_IDS.map((id) => ({
    id: `${platform}.${id}`,
    system: null,
    state: 'unimplemented' as const,
    reason: 'provider implementation lands in T06+',
  }));
}

export function createLearningClient(input: { scope: Scope; runtime: Runtime }): LearningClient {
  const { scope, runtime } = input;
  const jar = new SessionCookieJar();
  createSessionHttp({
    transport: runtime.transport,
    clock: runtime.clock,
    jar,
    allowHosts: PLATFORM_HOSTS[scope.platform],
  });
  new AuthLifecycle({ scope, clock: runtime.clock, state: runtime.state, masterKey: runtime.masterKey });
  const platform = scope.platform;
  return {
    scope,
    capabilities: () => capabilitiesFor(platform),
    auth: {
      begin: () => asyncUnsupported<AuthFlow>(platform, 'auth.begin'),
      probe: () => asyncUnsupported(platform, 'auth.probe'),
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
      resolveCourse: (url) => asyncUnsupported(platform, `catalog.resolveCourse(${url})`),
      courses: () => asyncUnsupported<Page<Course>>(platform, 'catalog.courses'),
      outline: (course) => asyncUnsupported(platform, `catalog.outline(${course.key})`),
      progress: (resource) => asyncUnsupported(platform, `catalog.progress(${resource.key})`),
    },
    resources: {
      media: (resource) => asyncUnsupported(platform, `resources.media(${resource.key})`),
      transcript: (resource) => asyncUnsupported(platform, `resources.transcript(${resource.key})`),
      lessons: () => asyncUnsupported(platform, 'resources.lessons'),
      slides: (lesson) => asyncUnsupported(platform, `resources.slides(${lesson.lessonId})`),
      resolveLesson: (url) => asyncUnsupported(platform, `resources.resolveLesson(${url})`),
    },
    assessments: {
      resolve: (resource) => asyncUnsupported(platform, `assessments.resolve(${resource.key})`),
      get: (ref) => asyncUnsupported(platform, `assessments.get(${ref.assessmentId})`),
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
