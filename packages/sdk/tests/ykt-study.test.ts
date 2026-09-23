import { describe, expect, it } from 'vitest';
import { buildYktHeartbeats, parseWatchProgress } from '../src/providers/ykt/study.js';

describe('ykt study heartbeats (T19, A191/A192)', () => {
  it('builds valid beats: no future ts, cp clamped to duration, sq from 1', () => {
    const clockNow = 1_728_000_000_000;
    const rows = buildYktHeartbeats({
      cpStart: 0,
      duration: 30,
      speed: 2,
      userId: '424242',
      courseId: '5184094',
      videoId: '701',
      skuId: '901',
      classroomId: '28927419',
      ccid: 'CC1',
      pg: '701_pg',
      tsStartMs: clockNow,
    });
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.et === 'heartbeat')).toBe(true);
    expect(rows.every((row) => Number(row.ts) <= clockNow + (rows.length - 1) * 5000)).toBe(true);
    expect(rows.map((row) => row.cp)).toEqual([10, 20, 30]);
    expect(rows.map((row) => row.sq)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.lob === 'ykt' && row.sp === 2 && row.tp === 30)).toBe(true);
  });

  it('guards bad inputs: speed<1, duration<=0 rejected; already-complete yields no beats', () => {
    expect(() => buildYktHeartbeats({ cpStart: 0, duration: 30, speed: 0, userId: 'u', courseId: 'c', videoId: 'v', skuId: 's', classroomId: 'cl', ccid: 'cc', pg: 'p', tsStartMs: 0 })).toThrow(/speed/);
    expect(() => buildYktHeartbeats({ cpStart: 0, duration: 0, speed: 1, userId: 'u', courseId: 'c', videoId: 'v', skuId: 's', classroomId: 'cl', ccid: 'cc', pg: 'p', tsStartMs: 0 })).toThrow(/duration/);
    expect(buildYktHeartbeats({ cpStart: 30, duration: 30, speed: 1, userId: 'u', courseId: 'c', videoId: 'v', skuId: 's', classroomId: 'cl', ccid: 'cc', pg: 'p', tsStartMs: 0 })).toEqual([]);
  });

  it('parses authoritative watch progress with defaults for never-watched videos', () => {
    const progress = parseWatchProgress({ data: { 701: { rate: 2, completed: 0, video_length: 30, last_point: 12 } } }, '701');
    expect(progress).toEqual({ rate: 2, completed: false, videoLength: 30, lastPoint: 12 });
    expect(parseWatchProgress({}, '999')).toEqual({ rate: 0, completed: false, videoLength: 0, lastPoint: 0 });
  });
});
