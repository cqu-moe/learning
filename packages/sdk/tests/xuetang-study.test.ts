import { describe, expect, it } from 'vitest';
import { buildXtxHeartBatch, schedulePollStates } from '../src/providers/xuetang/study.js';

describe('xtx study heartbeats (T20, A201/A202)', () => {
  it('builds a heart_data batch: ratechange first, lob=xt everywhere, sq/pg correct', () => {
    const batch = buildXtxHeartBatch({
      classroomId: '100',
      courseId: '5',
      leafId: '7',
      videoId: 'CCX1',
      userId: '77',
      speed: 2,
      duration: 30,
      cpStart: 0,
      sqStart: 0,
      tsStartMs: 1_000_000,
    });
    expect(batch.heart_data.length).toBe(2);
    expect(batch.heart_data[0]).toMatchObject({ et: 'ratechange', sp: 2, lob: 'xt' });
    expect(batch.heart_data.slice(1).every((row) => row.et === 'heartbeat')).toBe(true);
    expect(batch.heart_data.every((row) => row.lob === 'xt')).toBe(true);
    expect(batch.heart_data.map((row) => row.sq)).toEqual([1, 2]);
    const heartbeatRows = batch.heart_data.filter((row) => row.et === 'heartbeat');
    expect(heartbeatRows.every((row) => row.cp <= 30)).toBe(true);
    expect(heartbeatRows.every((row) => typeof row.ts === 'string')).toBe(true);
  });

  it('schedule read-back: pending is not complete; confirmed within 180s budget (A202)', () => {
    const states = schedulePollStates({ intervalMs: 6000, budgetMs: 180_000, confirmAtAttempt: 15 });
    expect(states.slice(0, 14).every((state) => state === 'waiting')).toBe(true);
    expect(states[14]).toBe('confirmed');
    const timeout = schedulePollStates({ intervalMs: 6000, budgetMs: 180_000, confirmAtAttempt: null });
    expect(timeout[timeout.length - 1]).toBe('timeout');
  });
});
