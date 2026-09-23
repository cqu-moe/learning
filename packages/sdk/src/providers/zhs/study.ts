import { getEv, hms, WatchPoint } from './crypto.js';
import { hikeSign } from './crypto.js';
import { LearningError } from '../../types/errors.js';
import type { ActionInput, ItemResult, Job, Progress, Receipt } from '../../types/models.js';
import type { ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import type { Clock } from '../../runtime/types.js';
import { parseHikeTree, parseShareVideoList } from './catalog.js';
import { zhidaoQuery } from './http.js';
import type { JobRunner } from '../../services/jobs.js';

export async function zhsShareReadState(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<{ progress: Progress; identity: { recruitId: string; courseId: string; ccCourseId: string; videoSec: number | null } }> {
  if (resource.native.kind !== 'zhs-share' || resource.course.native.kind !== 'zhs-share') throw new LearningError({ code: 'INVALID_INPUT', message: 'share progress needs a share resource', retryAfterMs: null, operationId: null });
  const racId = resource.course.native.recruitAndCourseId;
  const chapterId = resource.native.chapterId;
  const lessonId = resource.native.lessonId;
  const smallLessonId = resource.native.smallLessonId;
  const videoId = resource.native.videoId;
  await http.request({ kind: 'read', method: 'GET', url: `https://studyservice-api.zhihuishu.com/login/gologin?fromurl=${encodeURIComponent(`https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${racId}`)}` });
  const course = await zhidaoQuery(http, clock, '/learning/queryCourse', { recruitAndCourseId: racId }, { racId });
  const data = course.data as { recruitId?: number | string; courseInfo?: { courseId?: number | string } } | undefined;
  const recruitId = Number(data?.recruitId);
  if (!Number.isSafeInteger(recruitId) || recruitId <= 0) throw new LearningError({ code: 'PROTOCOL', message: 'share course has no recruitId', retryAfterMs: null, operationId: null });
  const videos = await zhidaoQuery(http, clock, '/learning/videolist', { recruitAndCourseId: racId }, { racId });
  const parsed = parseShareVideoList(videos as Parameters<typeof parseShareVideoList>[0]);
  const leaf = parsed.leaves.find((item) => item.chapterId === chapterId && item.lessonId === lessonId && item.smallLessonId === smallLessonId && item.videoId === videoId);
  if (leaf === undefined) throw new LearningError({ code: 'PROTOCOL', message: 'share video is missing from videolist', retryAfterMs: null, operationId: null });
  const state = await zhidaoQuery(http, clock, '/learning/queryStuyInfo', {
    lessonIds: [Number(lessonId)], lessonVideoIds: smallLessonId === '0' ? [] : [Number(smallLessonId)], recruitId,
  }, { racId });
  const states = (state.data ?? {}) as { lv?: Record<string, { watchState?: number; studyTotalTime?: number }>; lesson?: Record<string, { watchState?: number; studyTotalTime?: number }> };
  const watched = states.lv?.[smallLessonId] ?? states.lesson?.[lessonId];
  if (watched === undefined) throw new LearningError({ code: 'PROTOCOL', message: 'share progress has no matching lesson state', retryAfterMs: null, operationId: null });
  const seconds = Number(watched.studyTotalTime ?? 0);
  const duration = leaf.videoSec;
  if (!Number.isFinite(seconds) || seconds < 0 || duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new LearningError({ code: 'PROTOCOL', message: 'share progress numbers are invalid', retryAfterMs: null, operationId: null });
  return { progress: { resource, serverCompleted: watched.watchState === 1, serverFraction: duration === null ? null : Math.min(seconds / duration, 1), serverSeconds: seconds, durationSeconds: duration, observedAtMs: clock.nowMs() },
    identity: { recruitId: String(recruitId), courseId: String(data?.courseInfo?.courseId ?? ''), ccCourseId: parsed.courseId, videoSec: duration } };
}

export async function zhsShareReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<Progress> {
  return (await zhsShareReadState(http, clock, resource)).progress;
}

export async function zhsHikeReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef, requireVideo = false): Promise<Progress> {
  if (resource.native.kind !== 'zhs-hike' || resource.course.native.kind !== 'zhs-hike') throw new LearningError({ code: 'INVALID_INPUT', message: 'hike progress needs a hike resource', retryAfterMs: null, operationId: null });
  const response = await http.request({ kind: 'read', method: 'GET', url: `https://studyresources.zhihuishu.com/studyResources/stuResouce/queryResourceMenuTree?courseId=${resource.course.native.courseId}&_=${clock.nowMs()}` });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `hike resource tree returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = await response.json() as { code?: number; status?: number; rt?: Array<Record<string, unknown>> };
  if ((payload.code !== undefined && payload.code !== 0) || (payload.status !== undefined && payload.status !== 200) || !Array.isArray(payload.rt)) throw new LearningError({ code: 'PROTOCOL', message: 'hike resource tree has an invalid envelope', retryAfterMs: null, operationId: null });
  const roots = parseHikeTree(payload).nodes;
  const fileId = resource.native.fileId;
  const find = (nodes: typeof roots): (typeof roots)[number] | null => {
    for (const node of nodes) {
      if (node.fileId === fileId) return node;
      const child = find(node.children);
      if (child !== null) return child;
    }
    return null;
  };
  const node = find(roots);
  if (node === null) throw new LearningError({ code: 'PROTOCOL', message: 'hike file is missing from the course tree', retryAfterMs: null, operationId: null });
  if (requireVideo && node.kind !== 'video') throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'hike file is not a verified video', retryAfterMs: null, operationId: null });
  if (!Number.isFinite(node.studyTime) || node.studyTime < 0 || !Number.isFinite(node.totalTime) || node.totalTime < 0) throw new LearningError({ code: 'PROTOCOL', message: 'hike progress numbers are invalid', retryAfterMs: null, operationId: null });
  const durationSeconds = node.totalTime > 0 ? node.totalTime : null;
  return { resource, serverCompleted: durationSeconds === null ? null : node.studyTime >= durationSeconds,
    serverFraction: durationSeconds === null ? null : Math.min(node.studyTime / durationSeconds, 1),
    serverSeconds: node.studyTime, durationSeconds, observedAtMs: clock.nowMs() };
}

interface HikeCursor { resourceKey: string; startedAtMs: number; serverSeconds: number; stalls: number }
function hikeCursor(raw: string | null): HikeCursor | null {
  if (raw === null) return null;
  try {
    const row = JSON.parse(raw) as Partial<HikeCursor>;
    return typeof row.resourceKey === 'string' && typeof row.startedAtMs === 'number' && typeof row.serverSeconds === 'number' && typeof row.stalls === 'number' ? row as HikeCursor : null;
  } catch { return null; }
}

/** One signed save after real elapsed time; `rt` is the only credited position. */
export async function advanceHikeStudy(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; http: SessionHttp; clock: Clock; uuid: string }): Promise<Job> {
  const { job, action, runner, http, clock, uuid } = input;
  if (uuid === '') throw new LearningError({ code: 'AUTH_REQUIRED', message: 'hike study needs a validated UUID', retryAfterMs: null, operationId: job.id });
  const next = action.resources.find((resource) => !job.items.some((item) => item.key === resource.key));
  if (next === undefined) return runner.advance(job.id, async () => ({ completed: true }));
  return runner.advance(job.id, async () => {
    const now = clock.nowMs();
    const finish = (state: ItemResult['state'], message: string | null) => {
      const items: ItemResult[] = [...job.items, { key: next.key, state, message, artifacts: [] }];
      return { completed: items.length === action.resources.length, items };
    };
    if (now - job.createdAtMs > action.settings.maxDurationSeconds * 1000) return finish('needs-input', 'hike study duration budget expired');
    const progress = await zhsHikeReadProgress(http, clock, next, true);
    if (progress.durationSeconds === null || progress.serverSeconds === null) return finish('needs-input', 'hike file duration is unknown');
    const target = Math.min(progress.durationSeconds, progress.durationSeconds * action.settings.targetFraction);
    if (progress.serverSeconds >= target) return finish('succeeded', progress.serverCompleted ? 'server completed' : 'target reached; server completion is not claimed');
    const prior = hikeCursor((await runner.metadata(job.id)).cursor);
    const cursor: HikeCursor = prior?.resourceKey === next.key ? prior : { resourceKey: next.key, startedAtMs: now, serverSeconds: progress.serverSeconds, stalls: 0 };
    if (prior === null || prior.resourceKey !== next.key) {
      await runner.setCursor(job.id, JSON.stringify(cursor));
      return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 1000 };
    }
    const elapsed = Math.max(0, (now - cursor.startedAtMs) / 1000);
    const start = Math.floor(progress.serverSeconds);
    const end = Math.min(Math.ceil(target), Math.floor(start + elapsed * action.settings.speed));
    const delta = end - start;
    if (delta <= 0) return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 1000 };
    if (next.native.kind !== 'zhs-hike' || next.course.native.kind !== 'zhs-hike') return finish('needs-input', 'hike resource identifiers changed');
    const courseId = next.course.native.courseId;
    const fileId = next.native.fileId;
    const signature = hikeSign(uuid, courseId, fileId, delta, cursor.startedAtMs, now, end, start);
    const query = new URLSearchParams({ uuid, courseId, fileId, studyTotalTime: String(delta), startWatchTime: String(start), endWatchTime: String(end), startDate: String(cursor.startedAtMs), endDate: String(now), signature, _: String(now) });
    const operationId = `hike:${job.id}:${next.key}:${end}`;
    await runner.setPendingOperation(job.id, operationId);
    const response = await http.request({ kind: 'write', method: 'GET', url: `https://hike-teaching.zhihuishu.com/stuStudy/saveStuStudyRecord?${query.toString()}` });
    if (response.status !== 200) throw new LearningError({ code: 'UNCERTAIN', message: `hike save returned HTTP ${response.status}`, retryAfterMs: null, operationId });
    const payload = await response.json() as { status?: number; rt?: number | string };
    if (payload.status !== 200 || payload.rt === undefined) throw new LearningError({ code: 'UNCERTAIN', message: 'hike save acknowledgement lacks authoritative rt', retryAfterMs: null, operationId });
    const serverSeconds = Number(payload.rt);
    if (!Number.isFinite(serverSeconds) || serverSeconds < 0) throw new LearningError({ code: 'UNCERTAIN', message: 'hike save returned invalid rt', retryAfterMs: null, operationId });
    await runner.setPendingOperation(job.id, null);
    const stalls = serverSeconds <= progress.serverSeconds ? cursor.stalls + 1 : 0;
    if (stalls >= 3) return finish('needs-input', 'hike server rt stalled three times');
    await runner.setCursor(job.id, JSON.stringify({ resourceKey: next.key, startedAtMs: now, serverSeconds, stalls } satisfies HikeCursor));
    if (serverSeconds >= target) return finish('succeeded', serverSeconds >= progress.durationSeconds ? 'server completed' : 'target reached; server completion is not claimed');
    return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 1000 };
  });
}

export async function reconcileHikeSave(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; http: SessionHttp; clock: Clock; operationId: string }): Promise<Receipt> {
  const meta = await input.runner.metadata(input.job.id);
  const cursor = hikeCursor(meta.cursor);
  if (meta.pendingOperationId !== input.operationId || cursor === null || input.job.status !== 'uncertain') throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'job has no matching uncertain hike save', retryAfterMs: null, operationId: input.operationId });
  const resource = input.action.resources.find((item) => item.key === cursor.resourceKey);
  if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'hike cursor resource is missing', retryAfterMs: null, operationId: input.operationId });
  const seconds = (await zhsHikeReadProgress(input.http, input.clock, resource, true)).serverSeconds ?? 0;
  if (seconds <= cursor.serverSeconds) return { operationId: input.operationId, state: 'uncertain', message: 'hike server time has not advanced; do not resend', result: { serverSeconds: seconds } };
  await input.runner.confirmPendingAndPause(input.job.id, input.operationId);
  return { operationId: input.operationId, state: 'confirmed', message: 'hike server time advanced', result: { serverSeconds: seconds } };
}

export interface ShareSaveEvInput {
  recruitId: string;
  lessonId: string;
  smallId: string;
  videoId: string;
  chapterId: string;
  played: number;
  lastSubmit: number;
  videoSec: number;
  uuid: string;
  tokenB64?: string;
  courseId?: string;
}

/** share saveDatabaseIntervalTimeV2 ev payload: raw_ev 10-field order (Z03/Z05). */
export function buildShareSaveEv(input: ShareSaveEvInput): { sdsew: string; zwsds: string; courseId: string } {
  const rawEv = [
    input.recruitId,
    input.lessonId,
    input.smallId,
    input.videoId,
    input.chapterId,
    '0',
    Math.trunc(input.played - input.lastSubmit),
    Math.trunc(input.played),
    hms(Math.min(input.videoSec, Math.trunc(input.played))),
    input.uuid + 'zhs',
  ];
  return {
    sdsew: getEv(rawEv),
    zwsds: input.tokenB64 ?? '',
    courseId: input.courseId ?? '55',
  };
}

export async function zhsShareSave(input: { http: SessionHttp; clock: Clock; resource: ResourceRef; ids: { recruitId: string; courseId: string; ccCourseId: string; videoSec: number }; uuid: string; noteId: string; played: number; lastSubmit: number; watchPoint: string }): Promise<void> {
  const { resource, ids } = input;
  if (resource.native.kind !== 'zhs-share' || resource.course.native.kind !== 'zhs-share') throw new LearningError({ code: 'INVALID_INPUT', message: 'share save needs a share resource', retryAfterMs: null, operationId: null });
  const ev = buildShareSaveEv({ recruitId: ids.recruitId, lessonId: resource.native.lessonId, smallId: resource.native.smallLessonId,
    videoId: resource.native.videoId, chapterId: resource.native.chapterId, played: input.played, lastSubmit: input.lastSubmit,
    videoSec: ids.videoSec, uuid: input.uuid, tokenB64: btoa(input.noteId), courseId: ids.courseId });
  const response = await zhidaoQuery(input.http, input.clock, '/learning/saveDatabaseIntervalTimeV2',
    { ewssw: input.watchPoint, sdsew: ev.sdsew, zwsds: ev.zwsds, courseId: ev.courseId },
    { racId: resource.course.native.recruitAndCourseId, effect: 'write' });
  if (response.code !== 0 && response.code !== 200) throw new LearningError({ code: 'UNCERTAIN', message: 'share save has no explicit success code', retryAfterMs: null, operationId: null });
}

export async function zhsSharePopupPoints(http: SessionHttp, clock: Clock, resource: ResourceRef, ids: { recruitId: string; ccCourseId: string }): Promise<Array<{ timeSec: number }>> {
  if (resource.native.kind !== 'zhs-share' || resource.course.native.kind !== 'zhs-share') throw new LearningError({ code: 'INVALID_INPUT', message: 'popup lookup needs a share resource', retryAfterMs: null, operationId: null });
  const payload = await zhidaoQuery(http, clock, '/popupAnswer/loadVideoPointerInfo', {
    lessonId: resource.native.lessonId, lessonVideoId: resource.native.smallLessonId, recruitId: ids.recruitId, courseId: ids.ccCourseId,
  }, { racId: resource.course.native.recruitAndCourseId });
  const points = (payload.data as { questionPoint?: Array<{ timeSec?: number }> } | undefined)?.questionPoint;
  if (!Array.isArray(points)) throw new LearningError({ code: 'PROTOCOL', message: 'share popup points are unavailable', retryAfterMs: null, operationId: null });
  return points.filter((point): point is { timeSec: number } => typeof point.timeSec === 'number' && Number.isFinite(point.timeSec));
}

export async function zhsSharePrelearningNote(http: SessionHttp, clock: Clock, resource: ResourceRef, ids: { recruitId: string; ccCourseId: string }): Promise<string> {
  if (resource.native.kind !== 'zhs-share' || resource.course.native.kind !== 'zhs-share') throw new LearningError({ code: 'INVALID_INPUT', message: 'prelearning note needs a share resource', retryAfterMs: null, operationId: null });
  const payload = await zhidaoQuery(http, clock, '/learning/prelearningNote', {
    ccCourseId: ids.ccCourseId, chapterId: resource.native.chapterId, isApply: 1,
    lessonId: resource.native.lessonId, lessonVideoId: resource.native.smallLessonId, recruitId: ids.recruitId, videoId: resource.native.videoId,
  }, { racId: resource.course.native.recruitAndCourseId, effect: 'write' });
  const id = (payload.data as { studiedLessonDto?: { id?: number | string } } | undefined)?.studiedLessonDto?.id;
  if (id === undefined || !/^\d+$/.test(String(id)) || String(id) === '0') throw new LearningError({ code: 'UNCERTAIN', message: 'prelearning note has no confirmed id', retryAfterMs: null, operationId: null });
  return String(id);
}

interface ShareCursor { resourceKey: string; noteId: string; startedAtMs: number; baseline: number; awaiting: boolean; stalls: number }
function shareCursor(raw: string | null): ShareCursor | null {
  if (raw === null) return null;
  try {
    const row = JSON.parse(raw) as Partial<ShareCursor>;
    return typeof row.resourceKey === 'string' && typeof row.noteId === 'string' && typeof row.startedAtMs === 'number' && typeof row.baseline === 'number' && typeof row.awaiting === 'boolean' && typeof row.stalls === 'number' ? row as ShareCursor : null;
  } catch { return null; }
}

/** Default pause mode: no popup answer is fabricated and no offline time is replayed. */
export async function advanceShareStudy(input: {
  job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; clock: Clock; uuid: string;
  readState: () => Promise<{ progress: Progress; identity: { recruitId: string; courseId: string; ccCourseId: string; videoSec: number | null } }>;
  popupPoints: (ids: { recruitId: string; courseId: string; ccCourseId: string; videoSec: number }) => Promise<Array<{ timeSec: number }>>;
  prelearningNote: (ids: { recruitId: string; courseId: string; ccCourseId: string; videoSec: number }) => Promise<string>;
  save: (details: { played: number; lastSubmit: number; watchPoint: string; noteId: string; ids: { recruitId: string; courseId: string; ccCourseId: string; videoSec: number } }) => Promise<void>;
}): Promise<Job> {
  const { job, action, runner, clock } = input;
  const next = action.resources.find((resource) => !job.items.some((item) => item.key === resource.key));
  if (next === undefined) return runner.advance(job.id, async () => ({ completed: true }));
  return runner.advance(job.id, async () => {
    const now = clock.nowMs();
    const finish = (state: ItemResult['state'], message: string | null) => {
      const items: ItemResult[] = [...job.items, { key: next.key, state, message, artifacts: [] }];
      return { completed: items.length === action.resources.length, items };
    };
    if (now - job.createdAtMs > action.settings.maxDurationSeconds * 1000) return finish('needs-input', 'share study duration budget expired');
    const observed = await input.readState();
    const { progress, identity } = observed;
    const duration = progress.durationSeconds;
    const seconds = progress.serverSeconds;
    if (duration === null || seconds === null || identity.videoSec === null || identity.courseId === '' || identity.ccCourseId === '') return finish('needs-input', 'share video lacks duration or native course ids');
    const target = duration * action.settings.targetFraction;
    if (progress.serverCompleted || seconds >= target) return finish('succeeded', progress.serverCompleted ? 'server completed' : 'target reached; server completion is not claimed');
    const prior = shareCursor((await runner.metadata(job.id)).cursor);
    const cursor = prior?.resourceKey === next.key ? prior : null;
    if (cursor === null) {
      const ids = { ...identity, videoSec: identity.videoSec };
      const points = await input.popupPoints(ids);
      if (points.some((point) => Number.isFinite(point.timeSec) && point.timeSec > seconds && point.timeSec <= target)) return finish('needs-input', 'popup question requires a reviewed answer');
      const pending = `prelearn:${job.id}:${next.key}`;
      await runner.setPendingOperation(job.id, pending);
      const noteId = await input.prelearningNote(ids);
      if (!/^\d+$/.test(noteId) || noteId === '0') throw new LearningError({ code: 'UNCERTAIN', message: 'prelearning note has no confirmed id', retryAfterMs: null, operationId: pending });
      await runner.setPendingOperation(job.id, null);
      await runner.setCursor(job.id, JSON.stringify({ resourceKey: next.key, noteId, startedAtMs: now, baseline: seconds, awaiting: false, stalls: 0 } satisfies ShareCursor));
      return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 1000 };
    }
    if (cursor.awaiting && seconds <= cursor.baseline) {
      const stalls = cursor.stalls + 1;
      if (stalls >= 3) return finish('needs-input', 'share save acknowledged but watch state did not advance');
      await runner.setCursor(job.id, JSON.stringify({ ...cursor, stalls }));
      return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 5000 };
    }
    const elapsed = Math.max(0, (now - cursor.startedAtMs) / 1000);
    const played = Math.min(Math.ceil(target), Math.floor(seconds + elapsed * action.settings.speed));
    if (played <= seconds) return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 1000 };
    const wp = new WatchPoint(seconds); wp.add(played);
    const pending = `share-save:${job.id}:${next.key}:${played}`;
    await runner.setCursor(job.id, JSON.stringify({ ...cursor, baseline: seconds, awaiting: true, stalls: 0 }));
    await runner.setPendingOperation(job.id, pending);
    await input.save({ played, lastSubmit: seconds, watchPoint: wp.get(), noteId: cursor.noteId, ids: { ...identity, videoSec: identity.videoSec } });
    await runner.setPendingOperation(job.id, null);
    const after = (await input.readState()).progress;
    if (after.serverCompleted || (after.serverSeconds ?? 0) >= target) return finish('succeeded', after.serverCompleted ? 'server completed' : 'target reached; server completion is not claimed');
    await runner.setCursor(job.id, JSON.stringify({ resourceKey: next.key, noteId: cursor.noteId, startedAtMs: now, baseline: Math.max(seconds, after.serverSeconds ?? 0), awaiting: (after.serverSeconds ?? 0) <= seconds, stalls: 0 } satisfies ShareCursor));
    return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 1000 };
  });
}

export async function reconcileShareSave(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; operationId: string; readState: () => Promise<{ progress: Progress }> }): Promise<Receipt> {
  const meta = await input.runner.metadata(input.job.id);
  const cursor = shareCursor(meta.cursor);
  if (meta.pendingOperationId !== input.operationId || cursor === null || input.job.status !== 'uncertain') throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'job has no matching uncertain share save', retryAfterMs: null, operationId: input.operationId });
  if (!input.action.resources.some((resource) => resource.key === cursor.resourceKey)) throw new LearningError({ code: 'INTEGRITY', message: 'share cursor resource is missing', retryAfterMs: null, operationId: input.operationId });
  const seconds = (await input.readState()).progress.serverSeconds ?? 0;
  if (seconds <= cursor.baseline) return { operationId: input.operationId, state: 'uncertain', message: 'share server time has not advanced; do not resend', result: { serverSeconds: seconds } };
  await input.runner.confirmPendingAndPause(input.job.id, input.operationId);
  return { operationId: input.operationId, state: 'confirmed', message: 'share watch state advanced', result: { serverSeconds: seconds } };
}

/** hike: three consecutive server rts without progress → needs-input (stall stop). */
export function hikeStallDecision(serverTimes: number[]): 'continue' | 'needs-input' {
  if (serverTimes.length < 3) return 'continue';
  const [a, b, c] = serverTimes.slice(-3) as [number, number, number];
  return a === b && b === c ? 'needs-input' : 'continue';
}

/** Only official completion (1.0) counts; a 0.91 target is not server completion (A211). */
export function serverCompletedForTarget(serverFraction: number, targetFraction: number): boolean {
  void targetFraction;
  return serverFraction >= 1;
}
