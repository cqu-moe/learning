import { getEv, hms } from './crypto.js';
import { LearningError } from '../../types/errors.js';
import type { Progress } from '../../types/models.js';
import type { ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import type { Clock } from '../../runtime/types.js';
import { parseHikeTree, parseShareVideoList } from './catalog.js';
import { zhidaoQuery } from './http.js';

export async function zhsShareReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<Progress> {
  if (resource.native.kind !== 'zhs-share' || resource.course.native.kind !== 'zhs-share') throw new LearningError({ code: 'INVALID_INPUT', message: 'share progress needs a share resource', retryAfterMs: null, operationId: null });
  const racId = resource.course.native.recruitAndCourseId;
  const chapterId = resource.native.chapterId;
  const lessonId = resource.native.lessonId;
  const smallLessonId = resource.native.smallLessonId;
  const videoId = resource.native.videoId;
  await http.request({ kind: 'read', method: 'GET', url: `https://studyservice-api.zhihuishu.com/login/gologin?fromurl=${encodeURIComponent(`https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${racId}`)}` });
  const course = await zhidaoQuery(http, clock, '/learning/queryCourse', { recruitAndCourseId: racId }, { racId });
  const data = course.data as { recruitId?: number | string } | undefined;
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
  return { resource, serverCompleted: watched.watchState === 1, serverFraction: duration === null ? null : Math.min(seconds / duration, 1), serverSeconds: seconds, durationSeconds: duration, observedAtMs: clock.nowMs() };
}

export async function zhsHikeReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<Progress> {
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
  if (!Number.isFinite(node.studyTime) || node.studyTime < 0 || !Number.isFinite(node.totalTime) || node.totalTime < 0) throw new LearningError({ code: 'PROTOCOL', message: 'hike progress numbers are invalid', retryAfterMs: null, operationId: null });
  const durationSeconds = node.totalTime > 0 ? node.totalTime : null;
  return { resource, serverCompleted: durationSeconds === null ? null : node.studyTime >= durationSeconds,
    serverFraction: durationSeconds === null ? null : Math.min(node.studyTime / durationSeconds, 1),
    serverSeconds: node.studyTime, durationSeconds, observedAtMs: clock.nowMs() };
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
