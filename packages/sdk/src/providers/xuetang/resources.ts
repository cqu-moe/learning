import { LearningError } from '../../types/errors.js';
import type { MediaInfo, Transcript } from '../../types/models.js';
import type { ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';

export interface XtxLeafInfo { id?: number | string; leaf_type?: number; course_id?: number | string; user_id?: number | string; sku_id?: number | string; content_info?: { media?: { ccid?: string; duration?: number; exercise_id?: number }; leaf_type_id?: number } }

export async function xtxLeafInfo(http: SessionHttp, ref: ResourceRef): Promise<XtxLeafInfo> {
  if (ref.native.kind !== 'xuetang' || ref.course.native.kind !== 'xuetang') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'xtx resources require xtx refs', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/api/v1/lms/learn/leaf_info/${ref.course.native.classroomId}/${ref.native.leafId}/?sign=${ref.course.native.courseSign}`,
    headers: XTX_BASE_HEADERS,
  });
  const payload = (await response.json()) as { success?: boolean; msg?: string; data?: XtxLeafInfo };
  if (payload.success === false) {
    throw new LearningError({ code: 'PROTOCOL', message: `leaf_info failed: ${payload.msg ?? 'success=false'}`, retryAfterMs: null, operationId: null });
  }
  return payload.data ?? {};
}

export async function xtxMedia(http: SessionHttp, ref: ResourceRef): Promise<MediaInfo> {
  const info = await xtxLeafInfo(http, ref);
  const ccid = info.content_info?.media?.ccid;
  if (ccid === undefined || ccid === '') {
    throw new LearningError({ code: 'UNSUPPORTED', message: 'leaf has no media ccid', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/api/v1/lms/service/playurl/${ccid}/?appid=10000`,
    headers: XTX_BASE_HEADERS,
  });
  const payload = (await response.json()) as { data?: { duration?: number; sources?: Record<string, string[]> } };
  const sources = payload.data?.sources ?? {};
  const duration = payload.data?.duration ?? null;
  const variants: MediaInfo['variants'] = [];
  const hd = sources.quality20?.[0];
  const sd = sources.quality10?.[0];
  if (hd !== undefined && hd !== '') variants.push({ id: hd, quality: 'hd', mimeType: 'video/mp4', durationSeconds: duration });
  if (sd !== undefined && sd !== '') variants.push({ id: sd, quality: 'sd', mimeType: 'video/mp4', durationSeconds: duration });
  return { resource: ref, variants };
}

export async function xtxTranscript(http: SessionHttp, ref: ResourceRef): Promise<{ value: Transcript; warnings: [] }> {
  if (ref.native.kind !== 'xuetang') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'xtx transcript requires xtx refs', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/c27/online_courseware/leaf_lecture_note/${ref.native.leafId}/?classroom_id=${ref.course.native.kind === 'xuetang' ? ref.course.native.classroomId : ''}`,
    headers: XTX_BASE_HEADERS,
  });
  const payload = (await response.json()) as { success?: boolean; data?: Array<{ text?: string; start?: number; end?: number }> };
  const rows = payload.success === false ? [] : payload.data ?? [];
  return {
    value: {
      language: 'zh-CN',
      state: rows.length > 0 ? 'available' : 'absent',
      segments: rows.map((row) => ({
        text: row.text ?? '',
        startMs: Math.round((row.start ?? 0) * 1000),
        endMs: Math.round((row.end ?? 0) * 1000),
      })),
    },
    warnings: [],
  };
}
