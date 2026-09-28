// Stable SDK entry: client factory + aggregate helper over the safe public surface.
export * from './public.js';
export type { LearningClient } from './types/client.js';

import { LearningError } from './types/errors.js';
import type { ErrorData } from './types/errors.js';
import type { Platform, Scope } from './types/refs.js';
import { ActionInputSchema, ExportInputSchema } from './types/models.js';
import type { AuthFlow, Capability, Course, ExportInput, Job } from './types/models.js';
import type { Page } from './types/errors.js';
import type { LearningClient } from './types/client.js';
import type { Options, Runtime } from './runtime/types.js';
import { createSessionHttp, SessionCookieJar } from './http/client.js';
import { AuthLifecycle } from './auth/flow.js';
import { importLegacyCookies } from './auth/legacy.js';
import type { LegacyCookie } from './auth/legacy.js';
import { readSession, revokeSession, writeSession } from './session/store.js';
import { yktCourses, yktOutline, yktResolveCourse } from './providers/ykt/catalog.js';
import { yktProbeProvider, yktQrLaunch } from './providers/ykt/auth.js';
import { fetchLeafInfo, yktLessons, yktMedia, yktSlides, yktTranscript } from './providers/ykt/resources.js';
import { YKT_BASE } from './providers/ykt/schemas.js';
import { yktAssessmentGet, yktAssessmentsResolve, yktEmbeddedRead } from './providers/ykt/assessments.js';
import { yktExamRead } from './providers/ykt/exam-read.js';
import { xtxCourses, xtxOutline } from './providers/xuetang/catalog.js';
import { xtxProbeProvider, xtxQrLaunch } from './providers/xuetang/auth.js';
import { xtxMedia, xtxTranscript } from './providers/xuetang/resources.js';
import { xtxExamRead, xtxExamResolve } from './providers/xuetang/exam-read.js';
import { xtxHomeworkRead } from './providers/xuetang/homework-read.js';
import { zhsQrLaunch, zhsWechatQrLaunch } from './providers/zhs/auth.js';
import { zhsHikeCourses, zhsHikeOutline, zhsShareCourses, zhsShareOutline } from './providers/zhs/catalog.js';
import { zhidaoQuery } from './providers/zhs/http.js';
import { importFeedbackSet, importLegacyDraft } from './services/drafts.js';
export { exportDraftYaml, parseLearningDraft } from './services/drafts.js';
import { matchDraft } from './content/match.js';
import { proposeMatches } from './services/model.js';
import { probeSession } from './auth/flow.js';
import { JobRunner } from './services/jobs.js';
import { advanceExport } from './services/export-runner.js';
import { ActionStore } from './services/actions.js';
import { submitHomeworkProblem, submitEmbeddedAnswer } from './providers/ykt/homework-write.js';
import { advanceYktStudy, reconcileYktHeartbeat, yktReadProgress } from './providers/ykt/study.js';
import { advanceXtxStudy, reconcileXtxHeartbeat, xtxReadProgress, xtxReadStudyIdentity } from './providers/xuetang/study.js';
import { fetchDiscussionComments, fetchUnitDiscussion, postComment, submitXtxProblem } from './providers/xuetang/homework-write.js';
import { sha256Hex } from './types/sha256.js';
import { encodeExamAnswer, xtxReadStartCover, xtxSaveExam, xtxStartExam } from './providers/xuetang/exam-write.js';
import { advanceHikeStudy, advanceShareStudy, reconcileHikeSave, reconcileShareSave, zhsHikeReadProgress, zhsSharePopupPoints, zhsSharePrelearningNote, zhsShareReadProgress, zhsShareReadState, zhsShareSave } from './providers/zhs/study.js';
import { YktLiveSession } from './providers/ykt/live.js';
import { z } from 'zod';

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
  zhs: new Set(['auth.begin', 'auth.importLegacy', 'catalog.courses', 'catalog.outline']),
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

function zhsUuid(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as { uuid?: unknown };
    return typeof value.uuid === 'string' && value.uuid !== '' ? value.uuid : null;
  } catch { return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null; }
}

export function createLearningClient(input: { scope: Scope; runtime: Runtime }): LearningClient {
  const { scope, runtime } = input;
  const jobRunner = new JobRunner(runtime.state, runtime.clock);
  const actionStore = new ActionStore(runtime.state, runtime.clock, runtime.masterKey);
  const liveSessions = new Map<string, YktLiveSession>();
  const ownsScope = (other: Scope): boolean => other.userId === scope.userId && other.profileId === scope.profileId && other.platform === scope.platform;
  const assertOwnedJob = async (id: string): Promise<Job> => {
    const job = await jobRunner.get(id);
    if (!ownsScope(job.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'job belongs to another profile', retryAfterMs: null, operationId: id });
    return job;
  };
  const sessionBox = { jar: new SessionCookieJar(), hydrated: false };
  const lifecycle = new AuthLifecycle({ scope, clock: runtime.clock, state: runtime.state, masterKey: runtime.masterKey });
  const clientRef: { current: LearningClient | null } = { current: null };
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
  const liveCheckin = async (lessonId: string): Promise<{ lessonToken: string; jwt: string }> => {
    const response = await (await httpBound()).request({ kind: 'write', method: 'POST', url: 'https://www.yuketang.cn/api/v3/lesson/checkin',
      headers: { 'content-type': 'application/json;charset=utf-8' }, body: JSON.stringify({ source: 1, lessonId }) });
    const payload = await response.json() as { code?: number; data?: { lessonToken?: string } };
    if (payload.code !== 0 || typeof payload.data?.lessonToken !== 'string' || payload.data.lessonToken === '') throw new LearningError({ code: 'UNCERTAIN', message: 'live checkin did not confirm a lesson token', retryAfterMs: null, operationId: null });
    return { lessonToken: payload.data.lessonToken, jwt: response.headers.get('set-auth') ?? '' };
  };
  const platform = scope.platform;
  const client: LearningClient = {
    scope,
    capabilities: () => capabilitiesFor(platform),
    auth: {
      begin: async (loginInput): Promise<AuthFlow> => {
        await lifecycle.seedGeneration();
        if (platform === 'ykt' && loginInput.method === 'qr') {
          const http = await httpBound();
          return lifecycle.begin(yktQrLaunch({ http, jar: sessionBox.jar, clock: runtime.clock }));
        }
        if (platform === 'xuetang' && loginInput.method === 'qr') {
          const http = await httpBound();
          return lifecycle.begin(xtxQrLaunch({ http, jar: sessionBox.jar, transport: runtime.transport, clock: runtime.clock }));
        }
        if (platform === 'zhs' && loginInput.method === 'qr') {
          await httpBound();
          const http = createSessionHttp({ transport: runtime.transport, clock: runtime.clock, jar: sessionBox.jar, allowHosts: [...PLATFORM_HOSTS.zhs, 'weixin.qq.com'] });
          return lifecycle.begin((loginInput.variant === 'native' ? zhsQrLaunch : zhsWechatQrLaunch)({ http, jar: sessionBox.jar, clock: runtime.clock }));
        }
        throw unsupported(platform, `auth.begin(${loginInput.method})`);
      },
      probe: async () => {
        if (platform === 'ykt') {
          const result = await probeSession({
            scope,
            state: runtime.state,
            masterKey: runtime.masterKey,
            provider: yktProbeProvider({ http: await httpBound(), clock: runtime.clock }),
          });
          if (result.state === 'valid') {
            const record = await readSession(runtime.state, runtime.masterKey, scope);
            if (record !== null && record.generation === result.session.generation && (!record.identityVerified || record.platformUserId !== result.session.platformUserId)) {
              await writeSession(runtime.state, runtime.masterKey, { ...record, platformUserId: result.session.platformUserId, identityVerified: true, displayName: result.session.displayName,
                checkedAtMs: runtime.clock.nowMs(), cookieJar: await sessionBox.jar.serialize() });
            }
          }
          return result;
        }
        if (platform === 'xuetang') {
          const result = await probeSession({
            scope,
            state: runtime.state,
            masterKey: runtime.masterKey,
            provider: xtxProbeProvider({ http: await httpBound(), clock: runtime.clock }),
          });
          if (result.state === 'valid') {
            const record = await readSession(runtime.state, runtime.masterKey, scope);
            if (record !== null && record.generation === result.session.generation && !record.identityVerified) {
              await writeSession(runtime.state, runtime.masterKey, { ...record, identityVerified: true, checkedAtMs: runtime.clock.nowMs(), cookieJar: await sessionBox.jar.serialize() });
            }
          }
          return result;
        }
        if (platform === 'zhs') {
          const http = await httpBound();
          return probeSession({ scope, state: runtime.state, masterKey: runtime.masterKey, provider: { probe: async (record) => {
            if (record === null) return null;
            const expectedUuid = zhsUuid(record.platformUserId);
            const payload = await zhidaoQuery(http, runtime.clock, '/login/getLoginUserInfo', {}, { method: 'GET' });
            const data = (payload.data ?? payload.result) as { uuid?: unknown; name?: unknown } | undefined;
            const uuid = typeof data?.uuid === 'string' ? zhsUuid(data.uuid) : null;
            if (uuid === null || expectedUuid !== null && uuid !== expectedUuid) return null;
            const updated = { ...record, platformUserId: uuid, identityVerified: true,
              displayName: typeof data?.name === 'string' ? data.name : record.displayName,
              checkedAtMs: runtime.clock.nowMs(), cookieJar: await sessionBox.jar.serialize() };
            await writeSession(runtime.state, runtime.masterKey, updated);
            return { scope, generation: updated.generation, displayName: updated.displayName, platformUserId: uuid, identityVerified: true, checkedAtMs: updated.checkedAtMs };
          } } });
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
        if (platform === 'zhs') {
          const http = await httpBound();
          const share = await zhsShareCourses(http, runtime.clock, scope);
          const uuid = zhsUuid((await readSession(runtime.state, runtime.masterKey, scope))?.platformUserId ?? null);
          if (uuid === null) return { items: share.items, nextCursor: null, completeness: 'unknown', warnings: [{ code: 'AUTH_REQUIRED', message: 'hike course list needs a validated ZHS UUID', resourceKey: null }] };
          const hike = await zhsHikeCourses(http, runtime.clock, scope, uuid);
          return { items: [...share.items, ...hike.items], nextCursor: null, completeness: 'complete', warnings: [] };
        }
        return asyncUnsupported(platform, 'catalog.courses');
      },
      outline: async (course) => {
        if (platform === 'ykt') return yktOutline(await httpBound(), scope, course);
        if (platform === 'xuetang') return xtxOutline(await httpBound(), course);
        if (platform === 'zhs') {
          const http = await httpBound();
          return course.native.kind === 'zhs-hike' ? zhsHikeOutline(http, runtime.clock, course) : zhsShareOutline(http, runtime.clock, course);
        }
        return asyncUnsupported(platform, `catalog.outline(${course.key})`);
      },
      progress: async (resource) => {
        if (!ownsScope(resource.course.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
        if (platform === 'ykt') return { value: (await yktReadProgress(await httpBound(), runtime.clock, resource)).progress, warnings: [] };
        if (platform === 'xuetang') return { value: await xtxReadProgress(await httpBound(), runtime.clock, resource), warnings: [] };
        if (platform === 'zhs' && resource.native.kind === 'zhs-hike') return { value: await zhsHikeReadProgress(await httpBound(), runtime.clock, resource), warnings: [] };
        if (platform === 'zhs' && resource.native.kind === 'zhs-share') return { value: await zhsShareReadProgress(await httpBound(), runtime.clock, resource), warnings: [] };
        return asyncUnsupported(platform, `catalog.progress(${resource.key})`);
      },
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
        if (!ownsScope(lesson.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'lesson belongs to another profile', retryAfterMs: null, operationId: null });
        if (platform === 'ykt') return yktSlides(await httpBound(), lesson);
        return asyncUnsupported(platform, `resources.slides(${lesson.lessonId})`);
      },
      resolveLesson: async (url) => {
        if (platform !== 'ykt') return asyncUnsupported(platform, `resources.resolveLesson(${url})`);
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new LearningError({ code: 'INVALID_INPUT', message: 'lesson must be an HTTPS URL', retryAfterMs: null, operationId: null }); }
        if (parsed.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*yuketang\.cn$/i.test(parsed.hostname)) {
          throw new LearningError({ code: 'FORBIDDEN', message: 'lesson URL host is not Yuketang', retryAfterMs: null, operationId: null });
        }
        const lessonId = parsed.searchParams.get('lesson_id');
        if (lessonId === null || !/^[1-9]\d*$/.test(lessonId)) throw new LearningError({ code: 'INVALID_INPUT', message: 'lesson URL needs a valid lesson_id', retryAfterMs: null, operationId: null });
        return { scope, course: null, lessonId };
      },
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
          if (ref.kind === 'embedded') return yktEmbeddedRead(await httpBound(), ref);
          return yktAssessmentGet(await httpBound(), ref);
        }
        if (platform === 'xuetang' && ref.kind === 'exam') return xtxExamRead(await httpBound(), ref);
        if (platform === 'xuetang' && ref.kind === 'homework') return xtxHomeworkRead(await httpBound(), ref);
        return asyncUnsupported(platform, `assessments.get(${ref.assessmentId})`);
      },
      draft: async (ref) => {
        const assessment = await clientRef.current!.assessments.get(ref);
        return {
          schemaVersion: 1 as const,
          id: `draft-${ref.assessmentId}`,
          ref,
          fingerprint: assessment.fingerprint,
          entries: assessment.questions.map((question) => ({
            questionId: question.id,
            fingerprint: question.fingerprint,
            answer: { kind: 'unset' as const },
            evidence: null,
          })),
        };
      },
      importDraft: (text, format) => importLegacyDraft(text, format, scope),
      importFeedback: (text, ref) => importFeedbackSet(text, ref),
      match: async (draft, sources) => {
        const assessment = await clientRef.current!.assessments.get(draft.ref);
        return matchDraft(draft, sources, assessment.questions);
      },
      propose: async (draft, questionIds) => {
        const assessment = await clientRef.current!.assessments.get(draft.ref);
        const questions = assessment.questions.filter((question) => questionIds.includes(question.id));
        return proposeMatches(runtime.model, draft, questions);
      },
    },
    discussions: {
      resolve: async (resource) => {
        if (!ownsScope(resource.course.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'discussion resource belongs to another profile', retryAfterMs: null, operationId: null });
        if (platform !== 'xuetang' || resource.native.kind !== 'xuetang' || resource.course.native.kind !== 'xuetang') return asyncUnsupported(platform, `discussions.resolve(${resource.key})`);
        const root = await fetchUnitDiscussion(await httpBound(), resource.course.native.classroomId, resource.native.leafId, resource.course.native.courseSign);
        return { resource, topicId: root.topicId };
      },
      get: async (ref, page) => {
        if (!ownsScope(ref.resource.course.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'discussion belongs to another profile', retryAfterMs: null, operationId: null });
        if (platform !== 'xuetang' || ref.resource.native.kind !== 'xuetang' || ref.resource.course.native.kind !== 'xuetang') return asyncUnsupported(platform, `discussions.get(${ref.topicId})`);
        const http = await httpBound();
        const root = await fetchUnitDiscussion(http, ref.resource.course.native.classroomId, ref.resource.native.leafId, ref.resource.course.native.courseSign);
        if (root.topicId !== ref.topicId) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'discussion thread changed', retryAfterMs: null, operationId: null });
        const offset = page?.cursor === undefined || page.cursor === null ? 0 : Number(page.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'invalid discussion cursor', retryAfterMs: null, operationId: null });
        const limit = Math.min(page?.limit ?? 10, 100);
        const comments = await fetchDiscussionComments(http, { classroomId: ref.resource.course.native.classroomId, leafId: ref.resource.native.leafId, topicId: ref.topicId, offset, limit });
        const session = await readSession(runtime.state, runtime.masterKey, scope);
        const rich = (text: string) => ({ markdown: text, plainText: text, decodeState: 'not-needed' as const, sourceHash: sha256Hex(text) });
        return { ref, body: rich(root.text), replies: comments.map((comment) => ({ id: comment.id, body: rich(comment.text), own: session?.platformUserId !== null && session?.platformUserId !== undefined && session.platformUserId === comment.userId })), nextCursor: comments.length === limit ? String(offset + limit) : null };
      },
      draft: async (ref) => {
        const thread = await clientRef.current!.discussions.get(ref);
        return { id: `discussion-${ref.topicId}`, ref, text: '', sourceHash: thread.body.sourceHash, origin: 'user' };
      },
      propose: async (ref) => {
        if (platform !== 'xuetang') return asyncUnsupported(platform, `discussions.propose(${ref.topicId})`);
        if (runtime.model === null) throw new LearningError({ code: 'MISSING_RUNTIME', message: 'model client is not configured', retryAfterMs: null, operationId: null });
        const thread = await clientRef.current!.discussions.get(ref);
        if (thread.body.decodeState !== 'complete' && thread.body.decodeState !== 'not-needed') throw new LearningError({ code: 'CONTENT_UNREADABLE', message: 'discussion topic is not decoded', retryAfterMs: null, operationId: null });
        const result = await runtime.model.propose({ purpose: 'discussion', content: { topic: thread.body.plainText }, signal: new AbortController().signal });
        const parsed = z.object({ text: z.string().trim().min(1).max(10_000) }).safeParse(result);
        if (!parsed.success) throw new LearningError({ code: 'PROTOCOL', message: 'model returned an invalid discussion draft', retryAfterMs: null, operationId: null });
        return { id: `discussion-${ref.topicId}-model`, ref, text: parsed.data.text, sourceHash: thread.body.sourceHash, origin: 'model' };
      },
    },
    actions: {
      prepare: async (actionInput) => {
        if (actionInput.kind === 'live.answer' && platform === 'ykt') {
          const job = await assertOwnedJob(actionInput.liveJobId);
          if (job.kind !== 'live' || !['running', 'waiting'].includes(job.status)) throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'live job is not active', retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified || (await jobRunner.metadata(job.id)).generation !== session.generation) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'live session changed before answer', retryAfterMs: null, operationId: null });
          const live = liveSessions.get(job.id);
          if (live === undefined) throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'live socket is not active in this process', retryAfterMs: null, operationId: null });
          live.validateAnswer(actionInput.questionId, actionInput.phaseId, actionInput.answer);
          return actionStore.prepare(actionInput, session.generation, async () => {
            await live.answer(await httpBound(), actionInput.questionId, actionInput.phaseId, actionInput.answer);
            return { operationId: 'ack', state: 'confirmed', message: 'current live answer acknowledged', result: { questionId: actionInput.questionId } };
          }, { scope, preflight: async () => { live.validateAnswer(actionInput.questionId, actionInput.phaseId, actionInput.answer); } });
        }
        if (actionInput.kind === 'live.join' && platform === 'ykt') {
          if (!ownsScope(actionInput.lesson.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'live lesson belongs to another profile', retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified || !session.platformUserId) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified Yuketang login required before live checkin', retryAfterMs: null, operationId: null });
          return actionStore.prepare(actionInput, session.generation, async () => {
            const { lessonToken, jwt } = await liveCheckin(actionInput.lesson.lessonId);
            const job = await jobRunner.create(scope, 'live', { total: null, payload: actionInput, generation: session.generation });
            liveSessions.set(job.id, new YktLiveSession({ transport: runtime.transport, clock: runtime.clock, wake: async () => { await jobRunner.wake(job.id); await runtime.wake(); },
              lessonId: actionInput.lesson.lessonId, userId: session.platformUserId!, lessonToken, jwt }));
            return { operationId: 'ack', state: 'confirmed', message: 'live checkin acknowledged', result: { jobId: job.id } };
          });
        }
        if (actionInput.kind === 'study' && platform === 'zhs') {
          const family = actionInput.resources[0]?.native.kind;
          if (family !== 'zhs-share' && family !== 'zhs-hike' || actionInput.resources.some((resource) => !ownsScope(resource.course.scope) || resource.native.kind !== family)) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS study needs one course family from this profile', retryAfterMs: null, operationId: null });
          const maxSpeed = family === 'zhs-share' ? 1.5 : 1.25;
          if (actionInput.settings.questionMode !== 'pause' || actionInput.settings.speed < 1 || actionInput.settings.speed > maxSpeed) throw new LearningError({ code: 'INVALID_INPUT', message: `ZHS ${family} study supports pause mode and speed 1..${maxSpeed}`, retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified || zhsUuid(session.platformUserId) === null) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified ZHS UUID is required before hike study', retryAfterMs: null, operationId: null });
          for (const resource of actionInput.resources) {
            const progress = family === 'zhs-share' ? await zhsShareReadProgress(await httpBound(), runtime.clock, resource) : await zhsHikeReadProgress(await httpBound(), runtime.clock, resource, true);
            if (progress.durationSeconds === null) throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'ZHS video duration is unknown', retryAfterMs: null, operationId: null });
          }
          return actionStore.prepare(actionInput, session.generation, async () => {
            const job = await jobRunner.create(scope, 'study', { total: actionInput.resources.length, payload: actionInput, generation: session.generation });
            return { operationId: 'ack', state: 'confirmed', message: 'hike study job created', result: { jobId: job.id } };
          });
        }
        if (actionInput.kind === 'exam.finalize' && platform === 'xuetang') {
          if (!ownsScope(actionInput.draft.ref.resource.course.scope) || actionInput.draft.ref.kind !== 'exam') throw new LearningError({ code: 'FORBIDDEN', message: 'final exam draft belongs to another profile or is not an exam', retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login required before final exam preview', retryAfterMs: null, operationId: null });
          return actionStore.prepare(actionInput, session.generation,
            async () => ({ operationId: 'blocked', state: 'rejected', message: 'E05 verification missing', result: null }),
            { blockers: ['E05: final submission requires independent authorized verification before activation'] });
        }
        if (actionInput.kind === 'exam.save' && platform === 'xuetang') {
          const draft = actionInput.draft;
          if (!ownsScope(draft.ref.resource.course.scope) || draft.ref.kind !== 'exam') throw new LearningError({ code: 'FORBIDDEN', message: 'exam draft belongs to another profile or is not an exam', retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login required before saving exam answers', retryAfterMs: null, operationId: null });
          const assessment = await clientRef.current!.assessments.get(draft.ref);
          if (assessment.state !== 'in-progress' || assessment.fingerprint !== draft.fingerprint) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'exam is not in progress or paper changed', retryAfterMs: null, operationId: null });
          const chosen = draft.entries.filter((entry) => entry.answer.kind !== 'unset');
          if (chosen.length === 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam draft contains no answers to save', retryAfterMs: null, operationId: null });
          const encoded = chosen.map((entry) => {
            const question = assessment.questions.find((item) => item.id === entry.questionId);
            if (question === undefined || question.fingerprint !== entry.fingerprint || question.kind === 'unknown') throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'exam question changed or has an unverified type', retryAfterMs: null, operationId: null });
            if (!['single-choice', 'multi-choice', 'judgement'].includes(question.kind)) throw new LearningError({ code: 'UNSUPPORTED', message: 'exam write shape for this question type is unverified', retryAfterMs: null, operationId: null });
            if ((question.kind === 'single-choice' || question.kind === 'multi-choice') && entry.answer.kind !== 'choice' || question.kind === 'judgement' && entry.answer.kind !== 'judgement') throw new LearningError({ code: 'INVALID_INPUT', message: 'exam answer kind does not match the question', retryAfterMs: null, operationId: null });
            const problemId = Number(entry.questionId);
            if (!Number.isSafeInteger(problemId) || problemId <= 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam problem id is not a safe integer', retryAfterMs: null, operationId: null });
            return { problem_id: problemId, result: encodeExamAnswer(entry.answer) };
          });
          return actionStore.prepare(actionInput, session.generation, async () => {
            const latest = await xtxReadStartCover(await httpBound(), draft.ref);
            if (latest.status !== 1) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'exam is no longer in progress', retryAfterMs: null, operationId: null });
            await xtxSaveExam(await httpBound(), draft.ref, latest.userId, encoded.map((item) => ({ ...item, time: runtime.clock.nowMs() })));
            return { operationId: 'ack', state: 'confirmed', message: 'exam answers cached; paper not finalized', result: { examId: draft.ref.assessmentId, count: encoded.length } };
          });
        }
        if (actionInput.kind === 'exam.start' && platform === 'xuetang') {
          if (!ownsScope(actionInput.ref.resource.course.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'exam belongs to another profile', retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login required before starting an exam', retryAfterMs: null, operationId: null });
          const cover = await xtxReadStartCover(await httpBound(), actionInput.ref);
          if (cover.status !== 0) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'exam is not in an unstarted state', retryAfterMs: null, operationId: null });
          return actionStore.prepare(actionInput, session.generation, async () => {
            const latest = await xtxReadStartCover(await httpBound(), actionInput.ref);
            if (latest.status !== 0 || latest.userId !== cover.userId) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'exam state changed before start', retryAfterMs: null, operationId: null });
            await xtxStartExam(await httpBound(), actionInput.ref, latest.userId);
            return { operationId: 'ack', state: 'confirmed', message: 'exam start acknowledged; timer may be running', result: { examId: actionInput.ref.assessmentId } };
          });
        }
        if (actionInput.kind === 'discussion.post' && platform === 'xuetang') {
          const draft = actionInput.draft;
          const resource = draft.ref.resource;
          if (!ownsScope(resource.course.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'discussion draft belongs to another profile', retryAfterMs: null, operationId: null });
          if (resource.native.kind !== 'xuetang' || resource.course.native.kind !== 'xuetang' || draft.text.trim() === '' || draft.text.length > 10_000) throw new LearningError({ code: 'INVALID_INPUT', message: 'invalid Xuetang discussion draft', retryAfterMs: null, operationId: null });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login required before posting', retryAfterMs: null, operationId: null });
          const root = await fetchUnitDiscussion(await httpBound(), resource.course.native.classroomId, resource.native.leafId, resource.course.native.courseSign);
          if (root.topicId !== draft.ref.topicId || sha256Hex(root.text) !== draft.sourceHash) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'discussion thread changed since draft creation', retryAfterMs: null, operationId: null });
          const classroomId = resource.course.native.classroomId;
          const leafId = resource.native.leafId;
          return actionStore.prepare(actionInput, session.generation, async () => {
            await postComment(await httpBound(), { classroomId, leafId, topicId: root.topicId, toUser: root.ownerUserId, text: draft.text });
            return { operationId: 'ack', state: 'confirmed', message: 'discussion post acknowledged', result: { topicId: root.topicId } };
          });
        }
        if (actionInput.kind === 'study' && (platform === 'ykt' || platform === 'xuetang')) {
          if (actionInput.resources.length === 0 || actionInput.resources.some((resource) => !ownsScope(resource.course.scope))) {
            throw new LearningError({ code: 'INVALID_INPUT', message: 'study needs resources from this profile', retryAfterMs: null, operationId: null });
          }
          if (actionInput.settings.questionMode !== 'pause') return asyncUnsupported(platform, `actions.prepare(study:${actionInput.settings.questionMode})`);
          if (!Number.isSafeInteger(actionInput.settings.speed) || actionInput.settings.speed < 1 || actionInput.settings.speed > 5) {
            throw new LearningError({ code: 'INVALID_INPUT', message: 'study speed must be an integer from 1 to 5', retryAfterMs: null, operationId: null });
          }
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login is required before study', retryAfterMs: null, operationId: null });
          for (const resource of actionInput.resources) {
            if (platform === 'ykt') {
              const observed = await yktReadProgress(await httpBound(), runtime.clock, resource);
              if (observed.kind === 'article' && !observed.progress.serverCompleted && observed.skuId === null) throw new LearningError({ code: 'PROTOCOL', message: 'article sku is missing', retryAfterMs: null, operationId: null });
              if (observed.kind === 'video' && observed.progress.durationSeconds === null && !observed.progress.serverCompleted) throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'video duration is unknown; study cannot be planned', retryAfterMs: null, operationId: null });
            } else {
              await xtxReadProgress(await httpBound(), runtime.clock, resource);
              await xtxReadStudyIdentity(await httpBound(), resource);
            }
          }
          return actionStore.prepare(actionInput, session.generation, async () => {
            const job = await jobRunner.create(scope, 'study', { total: actionInput.resources.length, payload: actionInput, generation: session.generation });
            return { operationId: 'ack', state: 'confirmed', message: 'study job created', result: { jobId: job.id } };
          });
        }
        if ((platform !== 'ykt' && platform !== 'xuetang') || actionInput.kind !== 'homework.apply') return asyncUnsupported(platform, `actions.prepare(${actionInput.kind})`);
        const owner = actionInput.draft.ref.resource.course.scope;
        if (!ownsScope(owner)) throw new LearningError({ code: 'FORBIDDEN', message: 'draft belongs to another profile', retryAfterMs: null, operationId: null });
        if (actionInput.questionIds.length !== 1) throw new LearningError({ code: 'INVALID_INPUT', message: 'submit one homework problem per preview', retryAfterMs: null, operationId: null });
        const questionId = actionInput.questionIds[0]!;
        const entry = actionInput.draft.entries.find((item) => item.questionId === questionId);
        if (entry === undefined || entry.answer.kind === 'unset') throw new LearningError({ code: 'INVALID_INPUT', message: 'selected question has no answer', retryAfterMs: null, operationId: null });
        const session = await readSession(runtime.state, runtime.masterKey, scope);
        if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login is required before homework submission', retryAfterMs: null, operationId: null });
        const assessment = await clientRef.current!.assessments.get(actionInput.draft.ref);
        const question = assessment.questions.find((item) => item.id === questionId);
        if (assessment.fingerprint !== actionInput.draft.fingerprint || question === undefined || question.fingerprint !== entry.fingerprint || question.kind === 'unknown') {
          throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'homework content changed since draft creation', retryAfterMs: null, operationId: null });
        }
        if (question.attemptsUsed !== null && question.attemptsUsed > 0) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'homework problem was already submitted', retryAfterMs: null, operationId: null });
        if ((question.kind === 'single-choice' || question.kind === 'multi-choice') && entry.answer.kind !== 'choice' ||
          question.kind === 'judgement' && entry.answer.kind !== 'judgement' ||
          question.kind === 'fill-blank' && entry.answer.kind !== 'fill-blank' ||
          question.kind === 'short-answer' && entry.answer.kind !== 'short-answer') {
          throw new LearningError({ code: 'INVALID_INPUT', message: 'answer kind does not match question kind', retryAfterMs: null, operationId: null });
        }
        const course = actionInput.draft.ref.resource.course;
        if (platform === 'xuetang') {
          if (course.native.kind !== 'xuetang' || actionInput.draft.ref.resource.native.kind !== 'xuetang') return asyncUnsupported(platform, 'actions.prepare(homework.apply)');
          const leafId = actionInput.draft.ref.resource.native.leafId;
          const ids = { leafId, classroomId: course.native.classroomId, exerciseId: actionInput.draft.ref.assessmentId, problemId: questionId, courseSign: course.native.courseSign };
          return actionStore.prepare(actionInput, session.generation, async () => {
            const csrf = await sessionBox.jar.cookieValue(new URL('https://www.xuetangx.com/'), 'csrftoken');
            if (csrf === null) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'Xuetang CSRF cookie is missing', retryAfterMs: null, operationId: null });
            await submitXtxProblem(await httpBound(), ids, question.rawType, entry.answer, csrf);
            return { operationId: 'ack', state: 'confirmed', message: 'homework problem acknowledged', result: { questionId } };
          });
        }
        if (course.native.kind !== 'ykt') return asyncUnsupported(platform, 'actions.prepare(homework.apply)');
        const classroomId = course.native.classroomId;
        if (actionInput.draft.ref.kind === 'embedded') {
          const resource = actionInput.draft.ref.resource;
          if (resource.native.kind !== 'ykt') return asyncUnsupported(platform, 'actions.prepare(embedded.apply)');
          const leafId = resource.native.leafId;
          return actionStore.prepare(actionInput, session.generation, async () => {
            const current = await yktEmbeddedRead(await httpBound(), actionInput.draft.ref);
            const latest = current.questions.find((item) => item.id === questionId);
            if (current.fingerprint !== actionInput.draft.fingerprint || latest?.fingerprint !== entry.fingerprint || (latest.attemptsUsed ?? 0) > 0) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'embedded question changed or was already solved', retryAfterMs: null, operationId: null });
            const leaf = await fetchLeafInfo(await httpBound(), classroomId, leafId);
            const skuId = String(leaf?.sku_id ?? '');
            if (!/^[1-9]\d*$/.test(skuId) || String(leaf?.content_info?.media?.exercise_id ?? '') !== actionInput.draft.ref.assessmentId) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'embedded exercise identity changed', retryAfterMs: null, operationId: null });
            const csrf = await sessionBox.jar.cookieValue(new URL(YKT_BASE), 'csrftoken');
            if (csrf === null) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'Yuketang CSRF cookie is missing', retryAfterMs: null, operationId: null });
            const result = await submitEmbeddedAnswer(await httpBound(), { classroomId, leafId, skuId, exerciseId: actionInput.draft.ref.assessmentId, problemId: questionId }, entry.answer, csrf);
            return { operationId: 'ack', state: 'confirmed', message: result.isRight ? 'embedded answer correct' : 'embedded answer submitted but incorrect', result: { questionId, isRight: result.isRight, correctAnswer: result.correctAnswer } };
          });
        }
        return actionStore.prepare(actionInput, session.generation, async () => {
          await submitHomeworkProblem(await httpBound(), classroomId, questionId, entry.answer);
          return { operationId: 'ack', state: 'confirmed', message: 'homework problem acknowledged', result: { questionId } };
        });
      },
      execute: async (previewId) => {
        const operation = await actionStore.inspect(previewId);
        if (!ownsScope(operation.preview.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'preview belongs to another profile', retryAfterMs: null, operationId: operation.operationId });
        const session = await readSession(runtime.state, runtime.masterKey, scope);
        if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login is required before action execution', retryAfterMs: null, operationId: null });
        const receipt = await actionStore.execute(previewId, { generation: session.generation });
        if (operation.preview.kind === 'study' || operation.preview.kind === 'live.join') {
          const result = receipt.result;
          if (result === null || typeof result !== 'object' || Array.isArray(result) || typeof result.jobId !== 'string') {
            throw new LearningError({ code: 'INTEGRITY', message: 'study operation has no saved job id', retryAfterMs: null, operationId: receipt.operationId });
          }
          return { type: 'job', job: await assertOwnedJob(result.jobId) };
        }
        return { type: 'receipt', receipt };
      },
      reconcile: async (operationId) => {
        if (((operationId.startsWith('heartbeat:') || operationId.startsWith('article:')) && platform === 'ykt') || (operationId.startsWith('xtx-heartbeat:') && platform === 'xuetang') || ((operationId.startsWith('hike:') || operationId.startsWith('share-save:') || operationId.startsWith('prelearn:')) && platform === 'zhs')) {
          const jobId = /^(?:(?:xtx-)?heartbeat|article|hike|share-save|prelearn):(job-[^:]+):/.exec(operationId)?.[1];
          if (jobId === undefined) throw new LearningError({ code: 'INVALID_INPUT', message: 'invalid heartbeat operation id', retryAfterMs: null, operationId });
          let job = await assertOwnedJob(jobId);
          if (job.status === 'running' && (await jobRunner.metadata(jobId)).running) job = await jobRunner.recoverInterrupted(jobId);
          const saved = ActionInputSchema.parse(await jobRunner.input(jobId));
          if (saved.kind !== 'study') throw new LearningError({ code: 'INTEGRITY', message: 'heartbeat job input is invalid', retryAfterMs: null, operationId });
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || (await jobRunner.metadata(jobId)).generation !== session.generation) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'session changed before heartbeat reconciliation', retryAfterMs: null, operationId });
          if (platform === 'ykt') return reconcileYktHeartbeat({ job, action: saved, runner: jobRunner, http: await httpBound(), clock: runtime.clock, operationId });
          if (platform === 'xuetang') return reconcileXtxHeartbeat({ job, action: saved, runner: jobRunner, http: await httpBound(), clock: runtime.clock, operationId });
          if (operationId.startsWith('prelearn:')) return { operationId, state: 'uncertain', message: 'prelearning note outcome cannot be proven from watch state; do not repeat', result: null };
          if (operationId.startsWith('share-save:')) {
            const resourceKey = operationId.split(':')[2];
            const resource = saved.resources.find((item) => item.key === resourceKey);
            if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'share pending resource missing', retryAfterMs: null, operationId });
            const http = await httpBound();
            return reconcileShareSave({ job, action: saved, runner: jobRunner, operationId, readState: () => zhsShareReadState(http, runtime.clock, resource) });
          }
          return reconcileHikeSave({ job, action: saved, runner: jobRunner, http: await httpBound(), clock: runtime.clock, operationId });
        }
        const operation = await actionStore.inspect(operationId);
        if (!ownsScope(operation.preview.scope)) throw new LearningError({ code: 'FORBIDDEN', message: 'operation belongs to another profile', retryAfterMs: null, operationId });
        return actionStore.reconcile(operationId, async () => null);
      },
    },
    jobs: {
      createExport: async (raw) => {
        const exportInput: ExportInput = ExportInputSchema.parse(raw);
        const refs = exportInput.type === 'media' ? exportInput.resources.map((item) => item.course.scope)
          : exportInput.type === 'assessments' ? exportInput.refs.map((item) => item.resource.course.scope)
            : exportInput.lessons.map((item) => item.scope);
        if (refs.length === 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'export input must contain at least one item', retryAfterMs: null, operationId: null });
        if (refs.some((item) => !ownsScope(item))) throw new LearningError({ code: 'FORBIDDEN', message: 'export input belongs to another profile', retryAfterMs: null, operationId: null });
        const keys = exportInput.type === 'media' ? exportInput.resources.map((item) => item.key)
          : exportInput.type === 'assessments' ? exportInput.refs.map((item) => `${item.resource.key}:${item.assessmentId}`)
            : exportInput.lessons.map((item) => item.lessonId);
        if (new Set(keys).size !== keys.length) throw new LearningError({ code: 'INVALID_INPUT', message: 'export input contains duplicate items', retryAfterMs: null, operationId: null });
        return jobRunner.create(scope, 'export', { total: refs.length, payload: exportInput });
      },
      get: (jobId) => assertOwnedJob(jobId),
      list: (input) => jobRunner.list(input, scope),
      events: async (jobId, afterSequence) => { await assertOwnedJob(jobId); return jobRunner.events(jobId, afterSequence); },
      advance: async (jobId) => {
        const job = await assertOwnedJob(jobId);
        if (job.kind === 'live' && platform === 'ykt') {
          const live = liveSessions.get(jobId);
          if (live === undefined) return jobRunner.advance(jobId, async () => ({ completed: true, items: [{ key: jobId, state: 'needs-input', message: 'live socket cannot resume after process exit without a new confirmed checkin', artifacts: [] }] }));
          const result = await jobRunner.advance(jobId, async () => {
            await live.connect();
            const drained = live.drain(runtime.clock.nowMs());
            for (const event of drained.events) {
              if (event.type === 'gap') { await jobRunner.emitGap(jobId, event.message); continue; }
              const kind = event.problemType === 1 ? 'single-choice' : event.problemType === 2 ? 'multi-choice' : event.problemType === 3 ? 'judgement' : event.problemType === 4 ? 'fill-blank' : 'unknown';
              await jobRunner.emitQuestion(jobId, event.phaseId, {
                id: event.questionId, kind, rawType: String(event.problemType ?? ''),
                body: { markdown: '', plainText: '', decodeState: 'unavailable', sourceHash: sha256Hex('') },
                options: [], fingerprint: sha256Hex(JSON.stringify([event.phaseId, event.questionId])),
                attemptsUsed: null, maxAttempts: null, myAnswer: null, feedback: null,
              }, event.closesAtMs);
            }
            return { completed: drained.finished, status: 'waiting' as const, nextRunAtMs: runtime.clock.nowMs() + 1000 };
          });
          if (result.status === 'succeeded') { await live.close(); liveSessions.delete(jobId); }
          return result;
        }
        if (job.kind === 'study' && platform === 'ykt') {
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login required to advance study', retryAfterMs: null, operationId: jobId });
          if ((await jobRunner.metadata(jobId)).generation !== session.generation) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'session generation changed since job creation', retryAfterMs: null, operationId: jobId });
          const saved = ActionInputSchema.parse(await jobRunner.input(jobId));
          if (saved.kind !== 'study') throw new LearningError({ code: 'INTEGRITY', message: 'study job has invalid input', retryAfterMs: null, operationId: jobId });
          const http = await httpBound();
          return advanceYktStudy({ job, action: saved, runner: jobRunner, http, jar: sessionBox.jar, clock: runtime.clock });
        }
        if (job.kind === 'study' && platform === 'xuetang') {
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          if (session === null || !session.identityVerified) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified login required to advance study', retryAfterMs: null, operationId: jobId });
          if ((await jobRunner.metadata(jobId)).generation !== session.generation) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'session generation changed since job creation', retryAfterMs: null, operationId: jobId });
          const saved = ActionInputSchema.parse(await jobRunner.input(jobId));
          if (saved.kind !== 'study') throw new LearningError({ code: 'INTEGRITY', message: 'study job has invalid input', retryAfterMs: null, operationId: jobId });
          const http = await httpBound();
          return advanceXtxStudy({ job, action: saved, runner: jobRunner, http, jar: sessionBox.jar, clock: runtime.clock });
        }
        if (job.kind === 'study' && platform === 'zhs') {
          const session = await readSession(runtime.state, runtime.masterKey, scope);
          const uuid = zhsUuid(session?.platformUserId ?? null);
          if (session === null || !session.identityVerified || uuid === null) throw new LearningError({ code: 'AUTH_REQUIRED', message: 'verified ZHS UUID required to advance hike study', retryAfterMs: null, operationId: jobId });
          if ((await jobRunner.metadata(jobId)).generation !== session.generation) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'session generation changed since job creation', retryAfterMs: null, operationId: jobId });
          const saved = ActionInputSchema.parse(await jobRunner.input(jobId));
          if (saved.kind !== 'study') throw new LearningError({ code: 'INTEGRITY', message: 'hike job has invalid input', retryAfterMs: null, operationId: jobId });
          if (saved.resources[0]?.native.kind === 'zhs-share') {
            const resource = saved.resources.find((item) => !job.items.some((result) => result.key === item.key)) ?? saved.resources[0];
            if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'share job has no resource', retryAfterMs: null, operationId: jobId });
            const http = await httpBound();
            return advanceShareStudy({ job, action: saved, runner: jobRunner, clock: runtime.clock, uuid,
              readState: () => zhsShareReadState(http, runtime.clock, resource),
              popupPoints: (ids) => zhsSharePopupPoints(http, runtime.clock, resource, ids),
              prelearningNote: (ids) => zhsSharePrelearningNote(http, runtime.clock, resource, ids),
              save: (details) => zhsShareSave({ http, clock: runtime.clock, resource, uuid, ...details }),
            });
          }
          return advanceHikeStudy({ job, action: saved, runner: jobRunner, http: await httpBound(), clock: runtime.clock, uuid });
        }
        if (job.kind !== 'export') return asyncUnsupported(platform, `jobs.advance(${jobId})`);
        return advanceExport({
          runner: jobRunner,
          runtime,
          job,
          scope,
          getAssessment: (ref) => clientRef.current!.assessments.get(ref),
          getSlides: async (ref) => (await clientRef.current!.resources.slides(ref)).value,
          getSlideImage: async (url) => {
            const response = await (await httpBound()).request({ kind: 'read', method: 'GET', url });
            if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `slide image returned HTTP ${response.status}`, retryAfterMs: null, operationId: job.id });
            return { bytes: await response.bytes(32 * 1024 * 1024), mimeType: response.headers.get('content-type')?.split(';')[0] ?? '' };
          },
          getMedia: (ref) => clientRef.current!.resources.media(ref),
          getTranscript: async (ref) => (await clientRef.current!.resources.transcript(ref)).value,
          getAsset: async (url, maxBytes, headers) => {
            const response = await (await httpBound()).request({ kind: 'read', method: 'GET', url, ...(headers === undefined ? {} : { headers }) });
            if (response.status !== 200 && response.status !== 206 && !(headers?.range && response.status === 416)) throw new LearningError({ code: 'PROTOCOL', message: `media asset returned HTTP ${response.status}`, retryAfterMs: null, operationId: job.id });
            return { status: response.status, headers: response.headers, mimeType: response.headers.get('content-type')?.split(';')[0] ?? '', stream: response.stream(maxBytes) };
          },
        });
      },
      pause: async (jobId) => { await assertOwnedJob(jobId); const live = liveSessions.get(jobId); if (live) { await live.close(); liveSessions.delete(jobId); } return jobRunner.pause(jobId); },
      resume: async (jobId) => {
        const job = await assertOwnedJob(jobId);
        if (job.kind !== 'live') return jobRunner.resume(jobId);
        if (platform !== 'ykt' || !['paused', 'waiting', 'needs-input', 'uncertain'].includes(job.status)) throw new LearningError({ code: 'CONFLICT', message: 'live job cannot rejoin from its current state', retryAfterMs: null, operationId: jobId });
        const session = await readSession(runtime.state, runtime.masterKey, scope);
        if (session === null || !session.identityVerified || !session.platformUserId || (await jobRunner.metadata(jobId)).generation !== session.generation) throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'live session changed before rejoin', retryAfterMs: null, operationId: jobId });
        const saved = ActionInputSchema.parse(await jobRunner.input(jobId));
        if (saved.kind !== 'live.join') throw new LearningError({ code: 'INTEGRITY', message: 'live job has invalid input', retryAfterMs: null, operationId: jobId });
        const { lessonToken, jwt } = await liveCheckin(saved.lesson.lessonId);
        const live = new YktLiveSession({ transport: runtime.transport, clock: runtime.clock, wake: async () => { await jobRunner.wake(jobId); await runtime.wake(); },
          lessonId: saved.lesson.lessonId, userId: session.platformUserId, lessonToken, jwt });
        liveSessions.set(jobId, live);
        try {
          const requeued = await jobRunner.requeueLive(jobId);
          await jobRunner.emitGap(jobId, 'live socket re-established; events during process exit were not recoverable');
          return requeued;
        } catch (cause) { await live.close(); liveSessions.delete(jobId); throw cause; }
      },
      cancel: async (jobId) => { await assertOwnedJob(jobId); const live = liveSessions.get(jobId); if (live) { await live.close(); liveSessions.delete(jobId); } return jobRunner.cancel(jobId); },
    },
    close: async () => { await Promise.all([...liveSessions.values()].map((live) => live.close())); liveSessions.clear(); },
  };
  clientRef.current = client;
  return client;
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
