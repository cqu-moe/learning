import { LearningError } from '../../types/errors.js';
import type { Lesson, MediaInfo, SlideDeck, Transcript } from '../../types/models.js';
import type { CourseRef, ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { moocEnvelopeChecked, YKT_BASE } from './schemas.js';

interface LeafInfoWire {
  data?: { leaf_type?: number; finish?: boolean; course_id?: number | string; user_id?: number | string; sku_id?: number | string; content_info?: { media?: { ccid?: string; exercise_id?: number }; leaf_type_id?: number } };
}

export async function fetchLeafInfo(http: SessionHttp, classroomId: string, leafId: string): Promise<LeafInfoWire['data']> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/mooc-api/v1/lms/learn/leaf_info/${classroomId}/${leafId}/?classroom_id=${classroomId}`,
    headers: { xtbz: 'ykt' },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  moocEnvelopeChecked(payload, `leaf_info/${leafId}`);
  return (payload.data ?? {}) as LeafInfoWire['data'];
}

export async function yktLessons(http: SessionHttp, course: CourseRef): Promise<{ items: Lesson[]; nextCursor: null; completeness: 'complete' | 'unknown'; warnings: [] }> {
  if (course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt lessons requires a ykt course ref', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/v2/api/web/logs/learn/${course.native.classroomId}?actype=14&page=0&offset=500&sort=-1`,
  });
  const payload = (await response.json()) as { data?: { activities?: Array<Record<string, unknown>> } };
  const activities = payload.data?.activities ?? [];
  const items = activities
    .filter((a) => a.type === 14)
    .map((a) => ({
      ref: {
        scope: course.scope,
        course,
        lessonId: String(a.courseware_id ?? ''),
      },
      title: String(a.title ?? ''),
      startsAtMs: typeof a.create_time === 'number' ? a.create_time : null,
      finished: typeof a.is_finished === 'boolean' ? a.is_finished : null,
    }))
    .reverse();
  // E03: the old offset window is 500; a full window means more pages may exist unverified.
  const completeness = activities.length >= 500 ? 'unknown' : 'complete';
  return { items, nextCursor: null, completeness, warnings: [] };
}

export async function yktSlides(http: SessionHttp, lessonRef: { scope: CourseRef['scope']; lessonId: string }): Promise<{ value: SlideDeck[]; warnings: [] }> {
  const lessonId = lessonRef.lessonId;
  const review = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/api/v3/classroom-report/student/review?lesson_id=${lessonId}`,
  });
  const reviewPayload = (await review.json()) as { data?: { timelineList?: Array<Record<string, unknown>> } };
  const seen = new Set<string>();
  const presentationIds: string[] = [];
  for (const item of reviewPayload.data?.timelineList ?? []) {
    const pid = item.presentationId;
    if (typeof pid === 'string' && pid !== '' && !seen.has(pid)) {
      seen.add(pid);
      presentationIds.push(pid);
    }
  }
  const decks: SlideDeck[] = [];
  for (const presentationId of presentationIds) {
    const summary = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${YKT_BASE}/api/v3/lesson-summary/student/presentation?lesson_id=${lessonId}&presentation_id=${presentationId}`,
    });
    const summaryPayload = (await summary.json()) as { data?: { presentation?: { title?: string } } };
    const ppt = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${YKT_BASE}/api/v3/classroom-report/student/ppt?lesson_id=${lessonId}&presentationId=${presentationId}`,
    });
    const pptPayload = (await ppt.json()) as { data?: { slideList?: Array<{ index?: number; cover?: string }> } };
    const slides = [...(pptPayload.data?.slideList ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    decks.push({
      lesson: { scope: lessonRef.scope, course: null, lessonId },
      presentationId,
      title: summaryPayload.data?.presentation?.title ?? 'untitled',
      pages: slides
        .filter((s) => typeof s.cover === 'string' && s.cover !== '')
        .map((s, index) => ({ index, assetId: s.cover ?? '' })),
    });
  }
  return { value: decks, warnings: [] };
}

export interface SubtitleEntry { language: string; url: string }

export function normalizeSubtitleList(data: unknown): SubtitleEntry[] {
  if (data === null || data === undefined) return [];
  if (typeof data === 'object' && !Array.isArray(data)) {
    return Object.entries(data as Record<string, unknown>)
      .filter(([, url]) => typeof url === 'string' && url !== '')
      .map(([language, url]) => ({ language, url: url as string }));
  }
  if (Array.isArray(data)) {
    const out: SubtitleEntry[] = [];
    for (const item of data) {
      if (typeof item === 'string' && item !== '') out.push({ language: 'und', url: item });
      else if (typeof item === 'object' && item !== null) {
        const record = item as { language?: unknown; url?: unknown };
        if (typeof record.url === 'string' && record.url !== '') {
          out.push({ language: typeof record.language === 'string' && record.language !== '' ? record.language : 'und', url: record.url });
        }
      }
    }
    return out;
  }
  return [];
}

export function parseSrt(text: string): { text: string; startMs: number; endMs: number }[] {
  const toMs = (stamp: string): number => {
    const match = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(stamp);
    if (match === null) return 0;
    const [, h, m, s, ms] = match;
    return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
  };
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const segments: { text: string; startMs: number; endMs: number }[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timing = lines.find((line) => line.includes('-->'));
    if (timing === undefined) continue;
    const [startRaw, endRaw] = timing.split('-->');
    const body = lines.slice(lines.indexOf(timing) + 1).join('\n').trim();
    if (body === '') continue;
    segments.push({ text: body, startMs: toMs(startRaw ?? ''), endMs: toMs(endRaw ?? '') });
  }
  return segments;
}

export async function yktMedia(http: SessionHttp, ref: ResourceRef): Promise<MediaInfo> {
  if (ref.native.kind !== 'ykt' || ref.course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt media requires ykt refs', retryAfterMs: null, operationId: null });
  }
  const info = await fetchLeafInfo(http, ref.course.native.classroomId, ref.native.leafId);
  const ccid = info?.content_info?.media?.ccid;
  if (ccid === undefined || ccid === '') {
    throw new LearningError({ code: 'UNSUPPORTED', message: 'leaf has no media ccid', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/api/open/audiovideo/playurl?video_id=${encodeURIComponent(ccid)}&provider=cc&file_type=1&is_single=0&domain=www.yuketang.cn`,
  });
  const payload = (await response.json()) as { data?: { playurl?: { sources?: Record<string, string[]> } } };
  const sources = payload.data?.playurl?.sources ?? {};
  const variants: MediaInfo['variants'] = [];
  const hd = sources.quality20?.[0];
  const sd = sources.quality10?.[0];
  if (hd !== undefined && hd !== '') variants.push({ id: hd, quality: 'hd', mimeType: 'application/vnd.apple.mpegurl', durationSeconds: null });
  if (sd !== undefined && sd !== '') variants.push({ id: sd, quality: 'sd', mimeType: 'application/vnd.apple.mpegurl', durationSeconds: null });
  return { resource: ref, variants };
}

export async function yktTranscript(http: SessionHttp, ref: ResourceRef): Promise<{ value: Transcript; warnings: [] }> {
  if (ref.native.kind !== 'ykt' || ref.course.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt transcript requires ykt refs', retryAfterMs: null, operationId: null });
  }
  const info = await fetchLeafInfo(http, ref.course.native.classroomId, ref.native.leafId);
  const ccid = info?.content_info?.media?.ccid;
  if (ccid === undefined || ccid === '') {
    throw new LearningError({ code: 'UNSUPPORTED', message: 'leaf has no media ccid', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/api/open/yunpan/video/subtitle/list?cc_id=${encodeURIComponent(ccid)}`,
  });
  const entries = normalizeSubtitleList(((await response.json()) as { data?: unknown }).data);
  if (entries.length === 0) {
    return { value: { language: 'und', state: 'absent', segments: [] }, warnings: [] };
  }
  const first = entries[0]!;
  const srt = await http.request({ kind: 'read', method: 'GET', url: first.url });
  return {
    value: { language: first.language, state: 'available', segments: parseSrt(await srt.text()) },
    warnings: [],
  };
}
