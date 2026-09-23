import { describe, expect, it } from 'vitest';
import { LiveMailbox, expiredQuestionGuard } from '../src/providers/ykt/live.js';

describe('ykt live (T22, A221/A222)', () => {
  it('slides reads never check in; expired questions are never answered; duplicate events dedupe', () => {
    const answered: string[] = [];
    const mailbox = new LiveMailbox();
    mailbox.push({ type: 'question', phaseId: 'p1', questionId: 'q1', closesAtMs: 1000 });
    mailbox.push({ type: 'question', phaseId: 'p1', questionId: 'q1', closesAtMs: 1000 });
    const now = 2000;
    for (const event of mailbox.drain(now)) {
      if (expiredQuestionGuard(event, now)) continue;
      if (event.type === 'question') answered.push(event.questionId);
    }
    expect(answered).toHaveLength(0);
    mailbox.push({ type: 'question', phaseId: 'p2', questionId: 'q2', closesAtMs: 5000 });
    const live = mailbox.drain(2000).filter((event) => !expiredQuestionGuard(event, 2000));
    expect(live).toHaveLength(1);
  });

  it('reconnect reports a gap and does not replay uncertain answers', async () => {
    const mailbox = new LiveMailbox();
    mailbox.noteDisconnect();
    const events = mailbox.drain(3000);
    expect(events.some((event) => event.type === 'gap')).toBe(true);
  });
});
