import { LearningError } from '../../types/errors.js';
import type { ActionInput, ItemResult, Job, Progress, Receipt } from '../../types/models.js';
import type { ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import type { Clock } from '../../runtime/types.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';
import { xtxLeafInfo, xtxMedia } from './resources.js';
import type { SessionCookieJar } from '../../http/cookies.js';
import type { JobRunner } from '../../services/jobs.js';

export interface XtxStudyIdentity { courseId: string; userId: string; skuId: string; videoId: string; ccid: string; duration: number; exerciseId: string | null }

export async function xtxReadStudyIdentity(http: SessionHttp, resource: ResourceRef): Promise<XtxStudyIdentity> {
  if (resource.native.kind !== 'xuetang' || resource.course.native.kind !== 'xuetang') throw new LearningError({ code: 'INVALID_INPUT', message: 'Xuetang study needs a Xuetang video ref', retryAfterMs: null, operationId: null });
  const leaf = await xtxLeafInfo(http, resource);
  const ccid = leaf.content_info?.media?.ccid ?? '';
  let duration = leaf.content_info?.media?.duration ?? 0;
  if (duration <= 0 && ccid !== '') duration = (await xtxMedia(http, resource)).variants.find((variant) => variant.durationSeconds !== null)?.durationSeconds ?? 0;
  const identity: XtxStudyIdentity = { courseId: String(leaf.course_id ?? ''), userId: String(leaf.user_id ?? ''), skuId: String(leaf.sku_id ?? ''), videoId: String(leaf.id ?? resource.native.leafId), ccid, duration,
    exerciseId: leaf.content_info?.media?.exercise_id ? String(leaf.content_info.media.exercise_id) : null };
  if ([identity.courseId, identity.userId, identity.skuId, identity.videoId, identity.ccid].some((value) => value === '' || value === '0') ||
    [identity.courseId, identity.userId, identity.videoId].some((value) => !Number.isSafeInteger(Number(value)) || Number(value) <= 0) ||
    !Number.isFinite(duration) || duration <= 0) {
    throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'Xuetang leaf lacks study identifiers or duration', retryAfterMs: null, operationId: null });
  }
  return identity;
}

export function buildXtxStudyRow(identity: XtxStudyIdentity, input: { event: 'loadstart' | 'loadeddata' | 'play' | 'ratechange' | 'heartbeat' | 'videoend'; cp: number; speed: number; sq: number; tsMs: number; classroomId: string; pg: string }) {
  if (!Number.isSafeInteger(input.speed) || input.speed < 1 || input.speed > 5 || input.cp < 0 || input.cp > identity.duration || !Number.isSafeInteger(input.sq) || input.sq <= 0) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'invalid Xuetang heartbeat position, speed or sequence', retryAfterMs: null, operationId: null });
  }
  return {
    i: 5, et: input.event, p: 'web', n: /^[0-9A-F]{32}$/.test(identity.ccid) ? 'cc' : '', lob: 'xt', cp: Math.round(input.cp * 10) / 10,
    fp: 0, tp: 0, sp: input.speed, ts: String(input.tsMs), u: Number(identity.userId), c: Number(identity.courseId), v: Number(identity.videoId),
    cc: identity.ccid, d: Math.round(identity.duration * 10) / 10, pg: input.pg, sq: input.sq, t: 'video', uip: '', skuid: identity.skuId,
    classroomid: input.classroomId, cards_id: 0, slide: 0, v_url: '',
  };
}

interface XtxCursor { resourceKey: string; phase: 'start' | 'rate' | 'heart'; cp: number; sq: number; baseline: number; awaiting: boolean; stalls: number; awaitingSinceMs?: number }
function parseStudyCursor(raw: string | null): XtxCursor | null {
  if (raw === null) return null;
  try {
    const row = JSON.parse(raw) as Partial<XtxCursor>;
    if (typeof row.resourceKey !== 'string' || !['start', 'rate', 'heart'].includes(row.phase ?? '') || typeof row.cp !== 'number' || typeof row.sq !== 'number' || typeof row.baseline !== 'number' || typeof row.awaiting !== 'boolean' || typeof row.stalls !== 'number' || row.awaitingSinceMs !== undefined && !Number.isSafeInteger(row.awaitingSinceMs)) return null;
    return row as XtxCursor;
  } catch { return null; }
}

export async function advanceXtxStudy(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; http: SessionHttp; jar: SessionCookieJar; clock: Clock }): Promise<Job> {
  const { job, action, runner, http, jar, clock } = input;
  const next = action.resources.find((resource) => !job.items.some((item) => item.key === resource.key));
  if (next === undefined) return runner.advance(job.id, async () => ({ completed: true }));
  return runner.advance(job.id, async () => {
    const now = clock.nowMs();
    const finish = (state: ItemResult['state'], message: string | null) => {
      const items: ItemResult[] = [...job.items, { key: next.key, state, message, artifacts: [] }];
      return { completed: items.length === action.resources.length, items, ...(state === 'needs-input' ? { status: 'needs-input' as const } : {}) };
    };
    if (now - job.createdAtMs > action.settings.maxDurationSeconds * 1000) return finish('needs-input', 'study duration budget expired');
    const before = await xtxReadProgress(http, clock, next);
    if (before.serverFraction !== null && before.serverFraction >= action.settings.targetFraction) return finish('succeeded', before.serverCompleted ? 'server completed' : 'target fraction reached; server completion is not claimed');
    const previous = parseStudyCursor((await runner.metadata(job.id)).cursor);
    const cursor = previous?.resourceKey === next.key ? previous : null;
    if (cursor?.awaiting && (before.serverFraction ?? 0) <= cursor.baseline) {
      const since = cursor.awaitingSinceMs ?? now;
      if (now - since >= 180_000) return finish('needs-input', 'server schedule did not advance within 180 seconds; do not resend heartbeat');
      await runner.setCursor(job.id, JSON.stringify({ ...cursor, awaitingSinceMs: since, stalls: cursor.stalls + 1 }));
      return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 5000 };
    }
    let identity: XtxStudyIdentity;
    try { identity = await xtxReadStudyIdentity(http, next); }
    catch (cause) {
      if (cause instanceof LearningError && cause.data.code === 'INTERACTION_REQUIRED') return finish('needs-input', cause.message);
      throw cause;
    }
    if (identity.exerciseId !== null && action.settings.questionMode === 'pause') return finish('needs-input', 'embedded question requires review');
    const phase = cursor?.phase ?? 'start';
    const cp = cursor?.cp ?? (before.serverFraction ?? 0) * identity.duration;
    const seq = cursor?.sq ?? 0;
    const classroomId = next.course.native.kind === 'xuetang' ? next.course.native.classroomId : '';
    const pg = `${job.id}_${identity.videoId}`;
    const event = (kind: 'loadstart' | 'loadeddata' | 'play' | 'ratechange' | 'heartbeat' | 'videoend', position: number, sq: number) => buildXtxStudyRow(identity, { event: kind, cp: position, speed: action.settings.speed, sq, tsMs: now, classroomId, pg });
    let rows;
    let nextPhase: XtxCursor['phase'];
    let nextCp = cp;
    if (phase === 'start') { rows = [event('loadstart', cp, seq + 1), event('loadeddata', cp, seq + 2), event('play', cp, seq + 3)]; nextPhase = 'rate'; }
    else if (phase === 'rate') { rows = [event('ratechange', cp, seq + 1)]; nextPhase = 'heart'; }
    else {
      nextCp = Math.min(identity.duration, identity.duration * action.settings.targetFraction, cp + 5 * action.settings.speed);
      rows = [event('heartbeat', nextCp, seq + 1)];
      if (nextCp >= identity.duration && action.settings.targetFraction === 1) rows.push(event('videoend', identity.duration, seq + 2));
      nextPhase = 'heart';
    }
    const csrf = await jar.cookieValue(new URL(XTX_BASE), 'csrftoken');
    if (csrf === null) return finish('needs-input', 'CSRF cookie is missing');
    const baseline = before.serverFraction ?? 0;
    const pendingId = `xtx-heartbeat:${job.id}:${next.key}:${seq + 1}`;
    await runner.setCursor(job.id, JSON.stringify({ resourceKey: next.key, phase: nextPhase, cp: nextCp, sq: seq + rows.length, baseline, awaiting: phase === 'heart', stalls: 0, awaitingSinceMs: now } satisfies XtxCursor));
    await runner.setPendingOperation(job.id, pendingId);
    const response = await http.request({ kind: 'write', method: 'POST', url: `${XTX_BASE}/video-log/heartbeat/`,
      headers: { ...XTX_BASE_HEADERS, 'x-csrftoken': csrf, 'content-type': 'application/json;charset=utf-8', referer: `${XTX_BASE}/` },
      body: JSON.stringify({ heart_data: rows }) });
    if (response.status !== 200) throw new LearningError({ code: 'UNCERTAIN', message: `Xuetang heartbeat returned HTTP ${response.status}`, retryAfterMs: null, operationId: pendingId });
    const body = await response.text();
    if (body !== '') {
      let parsed: { success?: boolean };
      try { parsed = JSON.parse(body) as { success?: boolean }; }
      catch { throw new LearningError({ code: 'UNCERTAIN', message: 'Xuetang heartbeat acknowledgement is invalid', retryAfterMs: null, operationId: pendingId }); }
      if (parsed.success === false) throw new LearningError({ code: 'UNCERTAIN', message: 'Xuetang heartbeat was rejected', retryAfterMs: null, operationId: pendingId });
    }
    if (phase === 'heart') {
      const after = await xtxReadProgress(http, clock, next);
      await runner.setPendingOperation(job.id, null);
      if ((after.serverFraction ?? 0) >= action.settings.targetFraction) return finish('succeeded', after.serverCompleted ? 'server completed' : 'target fraction reached; server completion is not claimed');
      await runner.setCursor(job.id, JSON.stringify({ resourceKey: next.key, phase: nextPhase, cp: nextCp, sq: seq + rows.length, baseline: Math.max(baseline, after.serverFraction ?? 0), awaiting: (after.serverFraction ?? 0) <= baseline, stalls: 0, awaitingSinceMs: now } satisfies XtxCursor));
    } else await runner.setPendingOperation(job.id, null);
    return { completed: false, status: 'waiting' as const, nextRunAtMs: clock.nowMs() + 5000 };
  });
}

export async function reconcileXtxHeartbeat(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; http: SessionHttp; clock: Clock; operationId: string }): Promise<Receipt> {
  const meta = await input.runner.metadata(input.job.id);
  const cursor = parseStudyCursor(meta.cursor);
  if (meta.pendingOperationId !== input.operationId || cursor === null || input.job.status !== 'uncertain') throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'job has no matching uncertain Xuetang heartbeat', retryAfterMs: null, operationId: input.operationId });
  const resource = input.action.resources.find((item) => item.key === cursor.resourceKey);
  if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'study cursor resource is missing', retryAfterMs: null, operationId: input.operationId });
  const fraction = (await xtxReadProgress(input.http, input.clock, resource)).serverFraction ?? 0;
  if (fraction <= cursor.baseline) return { operationId: input.operationId, state: 'uncertain', message: 'schedule has not advanced; do not resend', result: { serverFraction: fraction } };
  await input.runner.confirmPendingAndPause(input.job.id, input.operationId);
  return { operationId: input.operationId, state: 'confirmed', message: 'server schedule advanced', result: { serverFraction: fraction } };
}

export async function xtxReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<Progress> {
  if (resource.native.kind !== 'xuetang' || resource.course.native.kind !== 'xuetang') throw new LearningError({ code: 'INVALID_INPUT', message: 'Xuetang schedule needs a Xuetang resource', retryAfterMs: null, operationId: null });
  const query = new URLSearchParams({ cid: resource.course.native.classroomId, sign: resource.course.native.courseSign });
  const response = await http.request({ kind: 'read', method: 'GET', url: `${XTX_BASE}/api/v1/lms/learn/course/schedule?${query.toString()}`, headers: XTX_BASE_HEADERS });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `schedule returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = await response.json() as { success?: boolean; data?: { leaf_schedules?: Record<string, unknown> }; leaf_schedules?: Record<string, unknown> };
  if (payload.success === false) throw new LearningError({ code: 'PROTOCOL', message: 'schedule returned success=false', retryAfterMs: null, operationId: null });
  const schedules = payload.data?.leaf_schedules ?? payload.leaf_schedules;
  if (schedules === undefined || typeof schedules !== 'object') throw new LearningError({ code: 'PROTOCOL', message: 'schedule has no leaf_schedules', retryAfterMs: null, operationId: null });
  const raw = schedules[resource.native.leafId];
  const fraction = raw === undefined || raw === null ? null : Number(raw);
  if (fraction !== null && (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)) throw new LearningError({ code: 'PROTOCOL', message: 'schedule leaf fraction is invalid', retryAfterMs: null, operationId: null });
  return { resource, serverCompleted: fraction === null ? null : fraction >= 1, serverFraction: fraction, serverSeconds: null, durationSeconds: null, observedAtMs: clock.nowMs() };
}

export interface XtxHeartRow { et: string; lob: string; cp: number; sp: number; ts: string; sq: number; c: string; v: string; classroomid: string; d: number; skuid?: string }

export interface XtxHeartBatchOptions {
  classroomId: string;
  courseId: string;
  leafId: string;
  videoId: string;
  userId: string;
  speed: number;
  duration: number;
  cpStart: number;
  sqStart: number;
  tsStartMs: number;
}

/** Pure xtx batch builder: ratechange row first, then heartbeat rows; batch = {heart_data: [...]} (X05). */
export function buildXtxHeartBatch(options: XtxHeartBatchOptions): { heart_data: XtxHeartRow[] } {
  if (options.speed < 1) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'speed must be >= 1', retryAfterMs: null, operationId: null });
  }
  if (options.duration <= 0) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'duration unknown; refusing to fabricate progress', retryAfterMs: null, operationId: null });
  }
  const rows: XtxHeartRow[] = [];
  let sq = options.sqStart;
  rows.push({
    et: 'ratechange',
    lob: 'xt',
    cp: options.cpStart,
    sp: options.speed,
    ts: String(options.tsStartMs),
    sq: (sq += 1),
    c: options.courseId,
    v: options.videoId,
    classroomid: options.classroomId,
    d: options.duration,
  });
  const step = 30 * options.speed;
  const beats = Math.ceil((options.duration - options.cpStart) / step);
  for (let n = 1; n <= beats; n += 1) {
    rows.push({
      et: 'heartbeat',
      lob: 'xt',
      cp: Math.min(options.cpStart + step * n, options.duration),
      sp: options.speed,
      ts: String(options.tsStartMs + n * 1000),
      sq: (sq += 1),
      c: options.courseId,
      v: options.videoId,
      classroomid: options.classroomId,
      d: options.duration,
    });
  }
  return { heart_data: rows };
}

/** Poll states for the authoritative schedule read-back: waiting → confirmed | timeout (X05/P-E02). */
export function schedulePollStates(options: { intervalMs: number; budgetMs: number; confirmAtAttempt: number | null }): Array<'waiting' | 'confirmed' | 'timeout'> {
  const maxAttempts = Math.floor(options.budgetMs / options.intervalMs);
  const states: Array<'waiting' | 'confirmed' | 'timeout'> = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.confirmAtAttempt === attempt) {
      states.push('confirmed');
      return states;
    }
    states.push('waiting');
  }
  states.push('timeout');
  return states;
}
