import { LearningError } from '../../types/errors.js';

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
