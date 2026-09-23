import { describe, expect, it } from 'vitest';
import { buildShareSaveEv, hikeStallDecision, serverCompletedForTarget } from '../src/providers/zhs/study.js';
import { WatchPoint, getEv } from '../src/providers/zhs/crypto.js';

describe('zhs study (T21, A211/A212)', () => {
  it('share save ev encodes the 10-field order with watchPoint retained', () => {
    const wp = new WatchPoint();
    wp.add(10);
    expect(wp.get()).toBe('0,1,2,2,3,3,3');
    const ev = buildShareSaveEv({
      recruitId: '9',
      lessonId: '10',
      smallId: '0',
      videoId: 'V1',
      chapterId: '1',
      played: 10,
      lastSubmit: 0,
      videoSec: 30,
      uuid: 'u1',
    });
    expect(ev.sdsew).toBe(getEv(['9', '10', '0', 'V1', '1', '0', 10, 10, '0:00:10', 'u1zhs']));
    expect(ev.zwsds).toBe('');
    expect(ev.courseId).toBe('55');
  });

  it('hike stops after three no-progress server reads (needs-input)', () => {
    expect(hikeStallDecision([30, 30, 30])).toBe('needs-input');
    expect(hikeStallDecision([30, 60, 90])).toBe('continue');
    expect(hikeStallDecision([30, 30])).toBe('continue');
  });

  it('target 0.91 never forces serverCompleted (A211)', () => {
    expect(serverCompletedForTarget(0.91, 0.91)).toBe(false);
    expect(serverCompletedForTarget(1, 0.91)).toBe(true);
  });
});
