import { LearningError } from '../../types/errors.js';
import type { Course, Outline, OutlineNode, Resource, ResourceKind } from '../../types/models.js';
import type { Page } from '../../types/errors.js';
import type { Clock } from '../../runtime/types.js';
import type { CourseRef, Scope } from '../../types/refs.js';
import { keyOfCourse, keyOfResource } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { homeQuery, zhidaoQuery } from './http.js';

const STUDY = 'https://studyservice-api.zhihuishu.com';
const STUDYRESOURCES = 'https://studyresources.zhihuishu.com';

export async function zhsShareCourses(http: SessionHttp, clock: Clock, scope: Scope): Promise<Page<Course>> {
  const items: Course[] = [];
  let page = 1;
  for (;;) {
    const payload = await homeQuery(http, clock, '/t/v1/student/course/share/queryShareCourseInfo', { status: 0, pageNo: page, pageSize: 5 });
    const result = (payload.result ?? {}) as { totalCount?: number; courseOpenDtos?: Array<{ recruitAndCourseId?: number | string; courseName?: string }> };
    const dtos = result.courseOpenDtos ?? [];
    for (const dto of dtos) {
      if (dto.recruitAndCourseId === undefined) {
        throw new LearningError({ code: 'PROTOCOL', message: 'share course missing recruitAndCourseId', retryAfterMs: null, operationId: null });
      }
      const native = { kind: 'zhs-share' as const, recruitAndCourseId: String(dto.recruitAndCourseId) };
      items.push({
        ref: { scope, key: keyOfCourse({ scope, key: 'pending', native }), native },
        title: dto.courseName ?? String(dto.recruitAndCourseId),
        system: 'zhs-share',
        term: null,
        teachers: [],
        locked: null,
      });
    }
    const total = Number(result.totalCount ?? 0);
    if (dtos.length === 0 || page * 5 >= total) break;
    page += 1;
  }
  return { items, nextCursor: null, completeness: 'complete', warnings: [] };
}

export interface ShareLeaf {
  chapterId: string;
  lessonId: string;
  smallLessonId: string;
  videoId: string;
  name: string;
  videoSec: number | null;
  path: string[];
}

export function parseShareVideoList(payload: { data?: { courseId?: number; videoChapterDtos?: Array<{ id?: number; name?: string; videoLessons?: Array<Record<string, unknown>> }> } }): { courseId: string; leaves: ShareLeaf[] } {
  const data = payload.data ?? {};
  const leaves: ShareLeaf[] = [];
  for (const chapter of data.videoChapterDtos ?? []) {
    const chapterId = String(chapter.id ?? 0);
    const chapterName = chapter.name ?? '';
    for (const lessonRaw of chapter.videoLessons ?? []) {
      const lesson = lessonRaw as { id?: number; name?: string; videoId?: unknown; videoSmallLessons?: Array<Record<string, unknown>> };
      const lessonId = String(lesson.id ?? 0);
      const lessonName = lesson.name ?? '';
      let smalls = lesson.videoSmallLessons;
      if ((smalls === undefined || smalls === null) && typeof lesson.videoId === 'string' && lesson.videoId !== '') {
        smalls = [{ ...lesson, id: 0 }]; // single-video lesson sentinel: small id 0
      }
      for (const small of smalls ?? []) {
        const videoId = String(small.videoId ?? '');
        if (videoId === '' || videoId === 'None') continue;
        leaves.push({
          chapterId,
          lessonId: String(small.lessonId ?? lessonId),
          smallLessonId: String(small.id ?? 0),
          videoId,
          name: String(small.name ?? lessonName),
          videoSec: typeof small.videoSec === 'number' ? small.videoSec : null,
          path: [chapterName, lessonName],
        });
      }
    }
  }
  return { courseId: String(data.courseId ?? 0), leaves };
}

export async function zhsShareOutline(http: SessionHttp, clock: Clock, ref: CourseRef): Promise<{ value: Outline; warnings: [] }> {
  if (ref.native.kind !== 'zhs-share') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'zhs share outline requires a zhs-share ref', retryAfterMs: null, operationId: null });
  }
  await http.request({
    kind: 'read',
    method: 'GET',
    url: `${STUDY}/login/gologin?fromurl=${encodeURIComponent(`https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${ref.native.recruitAndCourseId}`)}`,
  });
  await zhidaoQuery(http, clock, '/learning/queryCourse', { recruitAndCourseId: ref.native.recruitAndCourseId });
  const vl = await zhidaoQuery(http, clock, '/learning/videolist', { recruitAndCourseId: ref.native.recruitAndCourseId });
  const parsed = parseShareVideoList(vl as Parameters<typeof parseShareVideoList>[0]);
  const roots: OutlineNode[] = [];
  let counter = 0;
  const byChapter = new Map<string, Resource[]>();
  for (const leaf of parsed.leaves) {
    const native = { kind: 'zhs-share' as const, chapterId: leaf.chapterId, lessonId: leaf.lessonId, smallLessonId: leaf.smallLessonId, videoId: leaf.videoId };
    const resource: Resource = {
      ref: { course: ref, key: keyOfResource({ course: ref, key: 'pending', native }), native },
      title: leaf.name,
      kind: 'video',
      path: leaf.path,
      order: counter,
      durationSeconds: leaf.videoSec,
      locked: null,
    };
    counter += 1;
    const list = byChapter.get(leaf.chapterId) ?? [];
    list.push(resource);
    byChapter.set(leaf.chapterId, list);
  }
  for (const [chapterId, resources] of byChapter) {
    roots.push({ id: `ch:${chapterId}`, title: resources[0]?.path[0] ?? chapterId, children: [], resources });
  }
  return { value: { course: ref, roots, completeness: 'complete' }, warnings: [] };
}

export async function zhsHikeCourses(http: SessionHttp, scope: Scope): Promise<Page<Course>> {
  const response = await http.request({
    kind: 'read',
    method: 'POST',
    url: 'https://hikeservice.zhihuishu.com/student/course/aided/getMyCourseList',
  });
  const payload = (await response.json()) as { code?: number; result?: { startInngcourseList?: Array<{ courseId?: number; courseName?: string }> } };
  if (payload.code !== undefined && payload.code !== 0) {
    throw new LearningError({ code: 'PROTOCOL', message: `getMyCourseList code=${payload.code}`, retryAfterMs: null, operationId: null });
  }
  const items = (payload.result?.startInngcourseList ?? []).map((row) => {
    if (row.courseId === undefined) {
      throw new LearningError({ code: 'PROTOCOL', message: 'hike course missing courseId', retryAfterMs: null, operationId: null });
    }
    const native = { kind: 'zhs-hike' as const, courseId: String(row.courseId) };
    return {
      ref: { scope, key: keyOfCourse({ scope, key: 'pending', native }), native },
      title: row.courseName ?? String(row.courseId),
      system: 'zhs-hike',
      term: null,
      teachers: [],
      locked: null,
    } satisfies Course;
  });
  return { items, nextCursor: null, completeness: 'complete', warnings: [] };
}

export interface HikeNodeFlat { fileId: string; name: string; kind: ResourceKind; children: HikeNodeFlat[] }

export function parseHikeTree(payload: { rt?: Array<Record<string, unknown>> }): { nodes: HikeNodeFlat[] } {
  const walk = (raw: Record<string, unknown>): HikeNodeFlat => {
    const dataType = raw.dataType ?? null;
    const kind: ResourceKind = dataType === 1 ? 'video' : dataType === 2 ? 'document' : 'unknown';
    return {
      fileId: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      kind,
      children: ((raw.children ?? []) as Array<Record<string, unknown>>).map(walk),
    };
  };
  return { nodes: (payload.rt ?? []).map(walk) };
}

export async function zhsHikeOutline(http: SessionHttp, ref: CourseRef): Promise<{ value: Outline; warnings: [] }> {
  if (ref.native.kind !== 'zhs-hike') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'zhs hike outline requires a zhs-hike ref', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'POST',
    url: `${STUDYRESOURCES}/studyResources/stuResouce/queryResourceMenuTree?courseId=${ref.native.courseId}`,
  });
  const parsed = parseHikeTree((await response.json()) as { rt?: Array<Record<string, unknown>> });
  let counter = 0;
  const build = (node: HikeNodeFlat): OutlineNode => {
    counter += 1;
    const native = { kind: 'zhs-hike' as const, fileId: node.fileId };
    return {
      id: `n:${counter}:${node.fileId}`,
      title: node.name,
      children: node.children.map(build),
      resources: node.kind === 'unknown' && node.children.length === 0 ? [] : node.kind === 'unknown' ? [] : [{
        ref: { course: ref, key: keyOfResource({ course: ref, key: 'pending', native }), native },
        title: node.name,
        kind: node.kind,
        path: [],
        order: counter,
        durationSeconds: null,
        locked: null,
      } satisfies Resource],
    };
  };
  return { value: { course: ref, roots: parsed.nodes.map(build), completeness: 'complete' }, warnings: [] };
}
