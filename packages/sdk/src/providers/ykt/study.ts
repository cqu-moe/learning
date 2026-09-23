import { LearningError } from '../../types/errors.js';

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
