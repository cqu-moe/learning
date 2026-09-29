import { LearningError } from '../../types/errors.js';
import type { ActionInput, ItemResult, Job, Progress, Receipt } from '../../types/models.js';
import type { ResourceRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import type { Clock } from '../../runtime/types.js';
import { fetchLeafInfo } from './resources.js';
import { fetchClassroomContext } from './catalog.js';
import { fetchEmbeddedList } from './homework-write.js';
import { YKT_BASE } from './schemas.js';
import type { JobRunner } from '../../services/jobs.js';

export interface YktStudyIdentity { courseId: string; userId: string; skuId: string; ccid: string; exerciseId: string | null }
type YktObserved = { kind: 'article'; title: string | null; progress: Progress; skuId: string | null } | { kind: 'video'; title: string | null; progress: Progress; identity: YktStudyIdentity };

/** Read the platform's watch state; missing IDs/duration stay unknown. */
export async function yktReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<YktObserved> {
  if (resource.native.kind !== 'ykt' || resource.course.native.kind !== 'ykt') throw new LearningError({ code: 'INVALID_INPUT', message: 'Yuketang progress needs a Yuketang video ref', retryAfterMs: null, operationId: null });
  const classroomId = resource.course.native.classroomId;
  const videoId = resource.native.leafId;
  const leaf = await fetchLeafInfo(http, classroomId, videoId);
  if (leaf?.leaf_type === 3) {
    if (typeof leaf.finish !== 'boolean') throw new LearningError({ code: 'PROTOCOL', message: 'article leaf_info lacks finish state', retryAfterMs: null, operationId: null });
    const skuId = leaf.sku_id === undefined ? null : String(leaf.sku_id);
    const title = typeof leaf.name === 'string' && leaf.name !== '' ? leaf.name : null;
    return { kind: 'article', title, skuId: skuId === '0' || skuId === '' ? null : skuId, progress: { resource, serverCompleted: leaf.finish, serverFraction: leaf.finish ? 1 : 0, serverSeconds: null, durationSeconds: null, observedAtMs: clock.nowMs() } };
  }
  const identity: YktStudyIdentity = { courseId: String(leaf?.course_id ?? ''), userId: String(leaf?.user_id ?? ''), skuId: String(leaf?.sku_id ?? ''), ccid: String(leaf?.content_info?.media?.ccid ?? ''), exerciseId: leaf?.content_info?.media?.exercise_id ? String(leaf.content_info.media.exercise_id) : null };
  if ([identity.courseId, identity.userId, identity.skuId, identity.ccid].some((value) => value === '' || value === '0')) throw new LearningError({ code: 'PROTOCOL', message: 'leaf_info lacks the identifiers required for progress', retryAfterMs: null, operationId: null });
  const query = new URLSearchParams({ cid: identity.courseId, user_id: identity.userId, classroom_id: classroomId, video_type: 'video', vtype: 'rate', video_id: videoId, snapshot: '1', no_loading: 'true' });
  const response = await http.request({ kind: 'read', method: 'GET', url: `${YKT_BASE}/video-log/get_video_watch_progress/?${query.toString()}`, headers: { xtbz: 'ykt' } });
  if (response.status !== 200) throw new LearningError({ code: 'PROTOCOL', message: `watch progress returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
  const payload = await response.json();
  if (typeof payload !== 'object' || payload === null || (payload as { success?: boolean }).success === false) throw new LearningError({ code: 'PROTOCOL', message: 'watch progress returned an error envelope', retryAfterMs: null, operationId: null });
  const observed = parseWatchProgress(payload, videoId);
  if (![observed.rate, observed.videoLength, observed.lastPoint].every((value) => Number.isFinite(value) && value >= 0) || observed.rate > 1) throw new LearningError({ code: 'PROTOCOL', message: 'watch progress numbers are invalid', retryAfterMs: null, operationId: null });
  const leafDuration = Number(leaf?.content_info?.media?.duration ?? 0);
  const durationSeconds = observed.videoLength > 0 ? observed.videoLength : leafDuration > 0 ? leafDuration : null;
  const title = typeof leaf?.name === 'string' && leaf.name !== '' ? leaf.name : null;
  return { kind: 'video', title, identity, progress: { resource, serverCompleted: observed.completed, serverFraction: observed.rate, serverSeconds: observed.lastPoint, durationSeconds, observedAtMs: clock.nowMs() } };
}

interface StudyCursor { resourceKey: string; cp: number; sq: number; baseline: number; awaiting: boolean; stalls: number }
function parseCursor(value: string | null): StudyCursor | null {
  if (value === null) return null;
  try {
    const row = JSON.parse(value) as Partial<StudyCursor>;
    if (typeof row.resourceKey !== 'string' || typeof row.cp !== 'number' || typeof row.sq !== 'number' || typeof row.baseline !== 'number' || typeof row.awaiting !== 'boolean' || typeof row.stalls !== 'number') return null;
    return row as StudyCursor;
  } catch { return null; }
}

/** One wall-clock heartbeat at most per advance; never backfills time spent offline. */
export async function advanceYktStudy(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; http: SessionHttp; clock: Clock }): Promise<Job> {
  const { job, action, runner, http, clock } = input;
  const next = action.resources.find((resource) => !job.items.some((item) => item.key === resource.key));
  if (next === undefined) return runner.advance(job.id, async () => ({ completed: true }));
  return runner.advance(job.id, async () => {
    const now = clock.nowMs();
    const finish = (state: ItemResult['state'], message: string | null) => {
      const items: ItemResult[] = [...job.items, { key: next.key, state, message, artifacts: [] }];
      return { completed: items.length === action.resources.length, items, ...(state === 'needs-input' ? { status: 'needs-input' as const } : {}) };
    };
    if (now - job.createdAtMs > action.settings.maxDurationSeconds * 1000) return finish('needs-input', 'study duration budget expired');
    const observed = await yktReadProgress(http, clock, next);
    const { progress } = observed;
    if (observed.kind === 'article') {
      if (progress.serverCompleted) return finish('succeeded', 'server completed');
      if (observed.skuId === null) return finish('needs-input', 'article sku is missing');
      const classroomId = next.course.native.kind === 'ykt' ? next.course.native.classroomId : '';
      const leafId = next.native.kind === 'ykt' ? next.native.leafId : '';
      const context = await fetchClassroomContext(http, classroomId);
      const operationId = `article:${job.id}:${next.key}`;
      await runner.setPendingOperation(job.id, operationId);
      const response = await http.request({ kind: 'write', method: 'GET', url: `${YKT_BASE}/mooc-api/v1/lms/learn/user_article_finish/${leafId}/?cid=${classroomId}&sid=${observed.skuId}`,
        headers: { xtbz: 'ykt', 'university-id': context.universityId, 'uv-id': context.universityId, 'classroom-id': classroomId, 'xt-agent': 'web' } });
      if (response.status !== 200) throw new LearningError({ code: 'UNCERTAIN', message: `article finish returned HTTP ${response.status}`, retryAfterMs: null, operationId });
      const body = await response.json() as { success?: unknown };
      if (body?.success !== true) throw new LearningError({ code: 'UNCERTAIN', message: 'article finish acknowledgement is invalid', retryAfterMs: null, operationId });
      const after = await yktReadProgress(http, clock, next);
      await runner.setPendingOperation(job.id, null);
      return after.progress.serverCompleted ? finish('succeeded', 'server completed') : finish('needs-input', 'article finish acknowledged but server completion was not observed');
    }
    const { identity } = observed;
    if (identity.exerciseId !== null) {
      const classroomId = next.course.native.kind === 'ykt' ? next.course.native.classroomId : '';
      const leafId = next.native.kind === 'ykt' ? next.native.leafId : '';
      const problems = await fetchEmbeddedList(http, { classroomId, leafId, skuId: identity.skuId, exerciseId: identity.exerciseId });
      const unsolved = problems.filter((problem) => !problem.isRight);
      if (unsolved.length > 0) return finish('needs-input', `${unsolved.length} embedded question(s) need explicit reviewed answers`);
    }
    if (progress.serverFraction !== null && (progress.serverCompleted || progress.serverFraction >= action.settings.targetFraction)) return finish('succeeded', progress.serverCompleted ? 'server completed' : 'target fraction reached; server completion is not claimed');
    const duration = progress.durationSeconds;
    if (duration === null || duration <= 0) return finish('needs-input', 'server duration is unknown');
    await runner.emitProgress(job.id, next.key, progress.serverFraction ?? 0, { title: observed.title, durationSeconds: duration, serverSeconds: progress.serverSeconds });
    const previous = parseCursor((await runner.metadata(job.id)).cursor);
    const cursor = previous?.resourceKey === next.key ? previous : null;
    if (cursor?.awaiting) {
      if ((progress.serverFraction ?? 0) <= cursor.baseline) {
        const stalls = cursor.stalls + 1;
        if (stalls >= 3) return finish('needs-input', 'heartbeat was acknowledged but progress did not advance');
        await runner.setCursor(job.id, JSON.stringify({ ...cursor, stalls }));
        return { completed: false, status: 'waiting' as const, nextRunAtMs: now + 5000 };
      }
    }
    const cpStart = Math.max(progress.serverSeconds ?? 0, cursor?.cp ?? 0);
    const row = buildYktHeartbeats({ cpStart, duration, speed: action.settings.speed, userId: identity.userId,
      courseId: identity.courseId, videoId: next.native.kind === 'ykt' ? next.native.leafId : '', skuId: identity.skuId,
      classroomId: next.course.native.kind === 'ykt' ? next.course.native.classroomId : '', ccid: identity.ccid,
      pg: `${job.id}_${next.native.kind === 'ykt' ? next.native.leafId : ''}`, tsStartMs: now })[0];
    if (row === undefined) return finish('needs-input', 'no valid heartbeat could be constructed');
    row.cp = Math.min(row.cp, duration * action.settings.targetFraction);
    row.sq = (cursor?.sq ?? 0) + 1;
    const baseline = progress.serverFraction ?? 0;
    const sending: StudyCursor = { resourceKey: next.key, cp: row.cp, sq: row.sq, baseline, awaiting: true, stalls: 0 };
    await runner.setCursor(job.id, JSON.stringify(sending));
    await runner.setPendingOperation(job.id, `heartbeat:${job.id}:${next.key}:${row.sq}`);
    const response = await http.request({ kind: 'write', method: 'POST', url: `${YKT_BASE}/video-log/heartbeat/`,
      headers: { 'content-type': 'application/json;charset=utf-8', xtbz: 'ykt', 'classroom-id': row.classroomid,
        'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ heart_data: [row] }) });
    if (response.status !== 200) throw new LearningError({ code: 'UNCERTAIN', message: `heartbeat returned HTTP ${response.status}`, retryAfterMs: null, operationId: `heartbeat:${job.id}:${next.key}:${row.sq}` });
    const body = await response.text();
    if (body !== '') {
      let parsed: { success?: boolean };
      try { parsed = JSON.parse(body) as { success?: boolean }; }
      catch { throw new LearningError({ code: 'UNCERTAIN', message: 'heartbeat acknowledgement is invalid', retryAfterMs: null, operationId: `heartbeat:${job.id}:${next.key}:${row.sq}` }); }
      if (parsed.success === false) throw new LearningError({ code: 'UNCERTAIN', message: 'heartbeat was rejected', retryAfterMs: null, operationId: `heartbeat:${job.id}:${next.key}:${row.sq}` });
    }
    await runner.setPendingOperation(job.id, null);
    const after = (await yktReadProgress(http, clock, next)).progress;
    if (after.serverCompleted || (after.serverFraction ?? 0) >= action.settings.targetFraction) return finish('succeeded', after.serverCompleted ? 'server completed' : 'target fraction reached; server completion is not claimed');
    await runner.emitProgress(job.id, next.key, after.serverFraction ?? 0, { title: observed.title, durationSeconds: after.durationSeconds, serverSeconds: after.serverSeconds });
    await runner.setCursor(job.id, JSON.stringify({ ...sending, awaiting: (after.serverFraction ?? 0) <= baseline, baseline: Math.max(baseline, after.serverFraction ?? 0) }));
    return { completed: false, status: 'waiting' as const, nextRunAtMs: clock.nowMs() + 5000 };
  });
}

/** A lost heartbeat response is resolved only by a newer authoritative watch rate. */
export async function reconcileYktHeartbeat(input: { job: Job; action: Extract<ActionInput, { kind: 'study' }>; runner: JobRunner; http: SessionHttp; clock: Clock; operationId: string }): Promise<Receipt> {
  const meta = await input.runner.metadata(input.job.id);
  if (input.operationId.startsWith(`article:${input.job.id}:`)) {
    if (meta.pendingOperationId !== input.operationId || input.job.status !== 'uncertain') throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'job has no matching uncertain article finish', retryAfterMs: null, operationId: input.operationId });
    const resourceKey = input.operationId.slice(`article:${input.job.id}:`.length);
    const resource = input.action.resources.find((item) => item.key === resourceKey);
    if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'article resource is missing', retryAfterMs: null, operationId: input.operationId });
    const observed = await yktReadProgress(input.http, input.clock, resource);
    if (observed.kind !== 'article') throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'article type changed', retryAfterMs: null, operationId: input.operationId });
    if (!observed.progress.serverCompleted) return { operationId: input.operationId, state: 'uncertain', message: 'article completion is not visible; do not resend', result: { serverCompleted: false } };
    await input.runner.confirmPendingAndPause(input.job.id, input.operationId);
    return { operationId: input.operationId, state: 'confirmed', message: 'article completion confirmed by leaf_info', result: { serverCompleted: true } };
  }
  const cursor = parseCursor(meta.cursor);
  if (meta.pendingOperationId !== input.operationId || cursor === null || input.job.status !== 'uncertain') {
    throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'job has no matching uncertain heartbeat', retryAfterMs: null, operationId: input.operationId });
  }
  const resource = input.action.resources.find((item) => item.key === cursor.resourceKey);
  if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'study cursor resource is missing', retryAfterMs: null, operationId: input.operationId });
  const observed = await yktReadProgress(input.http, input.clock, resource);
  const fraction = observed.progress.serverFraction ?? 0;
  if (fraction <= cursor.baseline) return { operationId: input.operationId, state: 'uncertain', message: 'server progress has not advanced; do not resend', result: { serverFraction: fraction } };
  await input.runner.confirmPendingAndPause(input.job.id, input.operationId);
  return { operationId: input.operationId, state: 'confirmed', message: 'server watch progress advanced', result: { serverFraction: fraction } };
}

export interface YktHeartbeatRow {
  i: number;
  et: string;
  p: string;
  n: string;
  lob: string;
  cp: number;
  fp: number;
  tp: number;
  sp: number;
  ts: string;
  u: string;
  uip: string;
  c: string;
  v: string;
  skuid: string;
  classroomid: string;
  cc: string;
  d: number;
  pg: string;
  sq: number;
  t: string;
  cards_id: number;
  slide: number;
}

export interface YktHeartbeatOptions {
  cpStart: number;
  duration: number;
  speed: number;
  userId: string;
  courseId: string;
  videoId: string;
  skuId: string;
  classroomId: string;
  ccid: string;
  pg: string;
  tsStartMs: number;
}

/** Pure ykt heartbeat builder: 5s wall-clock beats, cp += 5*speed clamped, ts is string ms (Y08). */
export function buildYktHeartbeats(options: YktHeartbeatOptions): YktHeartbeatRow[] {
  if (options.speed < 1) {
    throw new LearningError({ code: 'INVALID_INPUT', message: `speed must be >= 1, got ${options.speed}`, retryAfterMs: null, operationId: null });
  }
  if (options.duration <= 0) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'duration unknown or zero; refusing to fabricate progress', retryAfterMs: null, operationId: null });
  }
  if (options.cpStart < 0) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'cpStart must be >= 0', retryAfterMs: null, operationId: null });
  }
  const step = 5 * options.speed;
  const remaining = options.duration - options.cpStart;
  if (remaining <= 0) return [];
  const beats = Math.ceil(remaining / step);
  const rows: YktHeartbeatRow[] = [];
  for (let n = 1; n <= beats; n += 1) {
    const cp = Math.min(options.cpStart + step * n, options.duration);
    rows.push({
      i: 5,
      et: 'heartbeat',
      p: 'web',
      n: 'ali-cdn.xuetangx.com',
      lob: 'ykt',
      cp,
      fp: 0,
      tp: options.duration,
      sp: options.speed,
      ts: String(options.tsStartMs + 5000 * (n - 1)),
      u: options.userId,
      uip: '',
      c: options.courseId,
      v: options.videoId,
      skuid: options.skuId,
      classroomid: options.classroomId,
      cc: options.ccid,
      d: options.duration,
      pg: options.pg,
      sq: n,
      t: 'video',
      cards_id: 0,
      slide: 0,
    });
  }
  return rows;
}

export interface YktWatchProgress { rate: number; completed: boolean; videoLength: number; lastPoint: number }

/** watch_progress envelope: per-video dict appears top-level and/or under data (Y08). */
export function parseWatchProgress(payload: unknown, videoId: string): YktWatchProgress {
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const info = (data[videoId] ?? body[videoId] ?? {}) as Record<string, unknown>;
  return {
    rate: Number(info.rate ?? 0),
    completed: Number(info.completed ?? 0) !== 0,
    videoLength: Number(info.video_length ?? 0),
    lastPoint: Number(info.last_point ?? 0),
  };
}
