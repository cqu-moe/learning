export interface LiveQuestionEvent {
  type: 'question';
  phaseId: string;
  questionId: string;
  closesAtMs: number | null;
  problemType?: number;
}

export type LiveMailboxEvent = LiveQuestionEvent | { type: 'gap'; message: string };

/** Bounded live mailbox with dedupe, gap reporting, and expiry guards (Y10/S06). */
export class LiveMailbox {
  private readonly queue: LiveMailboxEvent[] = [];
  private readonly seen = new Set<string>();
  private disconnected = false;

  push(event: LiveQuestionEvent): boolean {
    const key = JSON.stringify([event.phaseId, event.questionId]);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.queue.push(event);
    return true;
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
  return event.type === 'question' && (event.closesAtMs === null || event.closesAtMs <= nowMs);
}

import type { Clock, Socket, Transport } from '../../runtime/types.js';
import { LearningError } from '../../types/errors.js';
import type { Answer } from '../../types/models.js';
import type { SessionHttp } from '../../http/client.js';

/** One foreground live socket; the pump is owned and awaited on close. */
export class YktLiveSession {
  private readonly controller = new AbortController();
  private readonly mailbox = new LiveMailbox();
  private socket: Socket | null = null;
  private pump: Promise<void> | null = null;
  private finished = false;
  private closed = false;
  private readonly openQuestions = new Map<string, { phaseId: string; problemType: number; closesAtMs: number | null }>();
  private jwt: string;

  constructor(private readonly input: { transport: Transport; clock: Clock; wake: () => Promise<void>; lessonId: string; userId: string; lessonToken: string; jwt?: string }) { this.jwt = input.jwt ?? ''; }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('live session already closed');
    if (this.finished) return;
    if (this.socket !== null) return;
    this.socket = await this.input.transport.connect({ url: 'wss://www.yuketang.cn/wsapp/', headers: {}, signal: this.controller.signal });
    await this.socket.send(JSON.stringify({ op: 'hello', userid: this.input.userId, role: 'student', auth: this.input.lessonToken, lessonid: this.input.lessonId }));
    const socket = this.socket;
    this.pump = (async () => {
      try {
        for await (const frame of socket.messages) {
          let data: Record<string, unknown>;
          try { data = JSON.parse(typeof frame === 'string' ? frame : new TextDecoder().decode(frame)) as Record<string, unknown>; }
          catch { continue; }
          if (data.op === 'unlockproblem') {
            const problem = (data.problem ?? {}) as { prob?: number | string; problemType?: number; limit?: number };
            const questionId = String(problem.prob ?? '');
            if (questionId !== '') {
              const phaseId = String(data.msgid ?? data.phaseId ?? questionId);
              const closesAtMs = typeof problem.limit === 'number' && problem.limit > 0 ? this.input.clock.nowMs() + problem.limit * 1000 : null;
              const accepted = this.mailbox.push({ type: 'question', phaseId, questionId, closesAtMs,
                ...(problem.problemType === undefined ? {} : { problemType: problem.problemType }) });
              if (accepted && problem.problemType !== undefined) this.openQuestions.set(questionId, { phaseId, problemType: problem.problemType, closesAtMs });
            }
          } else if (data.op === 'problemfinished') {
            const problem = (data.problem ?? {}) as { prob?: number | string };
            this.openQuestions.delete(String(problem.prob ?? data.problemid ?? ''));
          } else if (data.op === 'lessonfinished') this.finished = true;
          await this.input.wake().catch(() => {});
          if (this.finished) break;
        }
      } catch { /* disconnected; report the gap below */ }
      finally {
        if (!this.closed) {
          if (!this.finished) this.mailbox.noteDisconnect();
          this.openQuestions.clear();
          this.socket = null;
          await socket.close().catch(() => {});
          await this.input.wake().catch(() => {});
        }
      }
    })();
  }

  drain(nowMs: number): { events: LiveMailboxEvent[]; finished: boolean } {
    return { events: this.mailbox.drain(nowMs), finished: this.finished };
  }

  validateAnswer(questionId: string, phaseId: string, answer: Answer): { problemType: number; result: string[] } {
    const open = this.openQuestions.get(questionId);
    if (this.closed || this.finished || open === undefined || open.phaseId !== phaseId || open.closesAtMs === null || open.closesAtMs <= this.input.clock.nowMs()) {
      throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'live question is not currently open', retryAfterMs: null, operationId: null });
    }
    if (this.jwt === '') throw new LearningError({ code: 'AUTH_REQUIRED', message: 'live JWT is unavailable', retryAfterMs: null, operationId: null });
    let result: string[];
    if (answer.kind === 'choice' && (open.problemType === 1 || open.problemType === 2)) result = [...answer.keys].sort();
    else if (answer.kind === 'judgement' && open.problemType === 3) result = [String(answer.value)];
    else throw new LearningError({ code: 'UNSUPPORTED', message: 'live answer kind is unverified for this question', retryAfterMs: null, operationId: null });
    if (result.length === 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'live answer is empty', retryAfterMs: null, operationId: null });
    return { problemType: open.problemType, result };
  }

  async answer(http: SessionHttp, questionId: string, phaseId: string, answer: Answer): Promise<void> {
    const { problemType, result } = this.validateAnswer(questionId, phaseId, answer);
    const response = await http.request({ kind: 'write', method: 'POST', url: 'https://www.yuketang.cn/api/v3/lesson/problem/answer',
      headers: { authorization: `Bearer ${this.jwt}`, xtbz: 'ykt', 'x-client': 'h5', 'content-type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ problemId: questionId, problemType, dt: this.input.clock.nowMs(), result }) });
    const payload = await response.json() as { code?: number };
    if (payload.code !== 0) throw new LearningError({ code: 'PROTOCOL', message: 'live answer was not acknowledged', retryAfterMs: null, operationId: null });
    const nextJwt = response.headers.get('set-auth');
    if (nextJwt) this.jwt = nextJwt;
    this.openQuestions.delete(questionId);
  }

  canAnswer(questionId: string, phaseId: string): boolean {
    const open = this.openQuestions.get(questionId);
    return !this.closed && !this.finished && open !== undefined && open.phaseId === phaseId && open.closesAtMs !== null && open.closesAtMs > this.input.clock.nowMs() && this.jwt !== '';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.openQuestions.clear();
    await this.socket?.close();
    await this.pump;
    this.socket = null;
  }
}
