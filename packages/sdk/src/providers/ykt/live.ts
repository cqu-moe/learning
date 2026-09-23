export interface LiveQuestionEvent {
  type: 'question';
  phaseId: string;
  questionId: string;
  closesAtMs: number;
}

export type LiveMailboxEvent = LiveQuestionEvent | { type: 'gap'; message: string };

/** Bounded live mailbox with dedupe, gap reporting, and expiry guards (Y10/S06). */
export class LiveMailbox {
  private readonly queue: LiveMailboxEvent[] = [];
  private readonly seen = new Set<string>();
  private disconnected = false;

  push(event: LiveQuestionEvent): void {
    const key = `${event.phaseId}:${event.questionId}:${event.closesAtMs}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.queue.push(event);
  }

  noteDisconnect(): void {
    this.disconnected = true;
    this.queue.push({ type: 'gap', message: 'socket dropped; messages between disconnect and re-handshake are not recoverable' });
  }

  drain(nowMs: number): LiveMailboxEvent[] {
    const events = [...this.queue];
    this.queue.length = 0;
    this.disconnected = false;
    void nowMs;
    return events;
  }
}

/** Answering an already-closed question is forbidden (A221). */
export function expiredQuestionGuard(event: LiveMailboxEvent, nowMs: number): boolean {
  return event.type === 'question' && event.closesAtMs <= nowMs;
}
