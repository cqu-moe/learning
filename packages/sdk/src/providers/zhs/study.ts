import { getEv, hms } from './crypto.js';

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
