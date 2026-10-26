import { describe, expect, it } from 'vitest';
import { ActionStore, digestOf } from '../src/services/actions.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock } from './helpers/replay.js';
import type { ActionInput, Receipt } from '../src/public.js';
import { LearningError } from '../src/public.js';

const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
const masterKey = new Uint8Array(32).fill(7);
const draft = {
  schemaVersion: 1 as const,
  id: 'd1',
  ref: {
    resource: { course: { scope, key: 'k', native: { kind: 'ykt' as const, classroomId: '1' } }, key: 'r', native: { kind: 'ykt' as const, leafId: '2', leafInfoId: null } },
    kind: 'homework' as const,
    assessmentId: 'ex1',
  },
  fingerprint: 'fp1',
  entries: [{ questionId: 'q1', fingerprint: 'qf1', answer: { kind: 'choice' as const, keys: ['A'] }, evidence: null }],
};
const input: ActionInput = { kind: 'homework.apply', draft, questionIds: ['q1'] };

function makeStore() {
  return new ActionStore(new MemoryStateStore(), new FakeClock(), masterKey);
}

describe('action store (T14, A141/A142)', () => {
  it('prepare stores input+digest+generation; duplicate execute performs exactly one upstream write', async () => {
    const store = makeStore();
    let upstreamWrites = 0;
    const preview = await store.prepare(input, 3, async () => {
      upstreamWrites += 1;
      return { operationId: 'op1', state: 'confirmed', message: 'ok', result: { done: true } } satisfies Receipt;
    });
    expect(preview.digest).toBe(digestOf(input));
    await store.execute(preview.id);
    await store.execute(preview.id);
    expect(upstreamWrites).toBe(1);
  });

  it('expired previews are rejected', async () => {
    const clock = new FakeClock();
    const store = new ActionStore(new MemoryStateStore(), clock, masterKey);
    const preview = await store.prepare(input, 1, async () => ({ operationId: 'op2', state: 'confirmed', message: '', result: null }));
    clock.setNow(clock.nowMs() + 11 * 60 * 1000);
    await expect(store.execute(preview.id)).rejects.toMatchObject({ data: { code: 'PREVIEW_EXPIRED' } });
  });

  it('changed generation or changed input rejects execution', async () => {
    const store = makeStore();
    const preview = await store.prepare(input, 5, async () => ({ operationId: 'op3', state: 'confirmed', message: '', result: null }));
    await expect(store.execute(preview.id, { generation: 6 })).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    const preview2 = await store.prepare({ ...input, questionIds: ['q2'] }, 5, async () => ({ operationId: 'op4', state: 'confirmed', message: '', result: null }));
    await expect(store.execute(preview2.id, { digest: digestOf(input) })).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
  });

  it('a sending record that crashes before ack stays uncertain and is not replayed blindly (A142)', async () => {
    const store = makeStore();
    let attempts = 0;
    const preview = await store.prepare(input, 2, async () => {
      attempts += 1;
      throw new Error('connection reset after send');
    });
    await expect(store.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    const receipt = await store.reconcile(preview.id, async () => null);
    expect(receipt.state).toBe('uncertain');
    expect(attempts).toBe(1);
  });

  it('reports the original send failure before persisting an uncertain operation', async () => {
    const cause = new Error('connection reset after send');
    const events: unknown[] = [];
    const store = new ActionStore(new MemoryStateStore(), new FakeClock(), masterKey, event => events.push(event));
    const preview = await store.prepare(input, 2, async () => { throw cause; });

    const error = await store.execute(preview.id).catch((caught: unknown) => caught as Error);

    expect(error).toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect((error as Error).cause).toBe(cause);
    expect(events).toEqual([{
      level: 'error',
      message: 'Learning SDK operation failed',
      error: cause,
      fields: { stage: 'action.execute' },
    }]);
  });

  it('reports timeout-style AbortError but keeps caller-canceled sends quiet', async () => {
    const makeStore = (events: unknown[]) => new ActionStore(new MemoryStateStore(), new FakeClock(), masterKey, event => events.push(event));
    const timeoutEvents: unknown[] = [];
    const timeoutStore = makeStore(timeoutEvents);
    const timeout = new DOMException('send timed out', 'AbortError');
    const timeoutPreview = await timeoutStore.prepare(input, 2, async () => { throw timeout; });

    const timeoutError = await timeoutStore.execute(timeoutPreview.id)
      .catch((caught: unknown) => caught as Error);

    expect(timeoutError).toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect((timeoutError as Error).cause).toBe(timeout);
    expect(timeoutEvents).toEqual([{
      level: 'error',
      message: 'Learning SDK operation failed',
      error: timeout,
      fields: { stage: 'action.execute' },
    }]);

    const cancelEvents: unknown[] = [];
    const cancelStore = makeStore(cancelEvents);
    const canceled = new DOMException('send canceled', 'AbortError');
    const cancelPreview = await cancelStore.prepare(input, 2, async () => { throw canceled; });
    const signal = new AbortController();
    signal.abort();
    await expect(cancelStore.execute(cancelPreview.id, undefined, { signal: signal.signal })).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(cancelEvents).toEqual([]);
  });

  it('reconcile confirms only from authoritative upstream state', async () => {
    const store = makeStore();
    const preview = await store.prepare(input, 2, async () => {
      throw new Error('reset');
    });
    await expect(store.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    const receipt = await store.reconcile(preview.id, async () => ({ operationId: 'op5', state: 'confirmed', message: 'verified upstream', result: { ok: true } }));
    expect(receipt.state).toBe('confirmed');
  });

  it('cancel keeps completed results (A142)', async () => {
    const store = makeStore();
    const preview = await store.prepare(input, 1, async () => ({ operationId: 'op6', state: 'confirmed', message: '', result: null }));
    await store.execute(preview.id);
    await store.cancelAll();
    const again = await store.execute(preview.id);
    expect(again).toMatchObject({ state: 'confirmed' });
  });

  it('persists a confirmed receipt across instances and never repeats its write', async () => {
    const state = new MemoryStateStore();
    const clock = new FakeClock();
    const first = new ActionStore(state, clock, masterKey);
    let writes = 0;
    const preview = await first.prepare(input, 1, async () => { writes += 1; return { operationId: 'ignored', state: 'confirmed', message: 'saved', result: null }; });
    const receipt = await first.execute(preview.id);
    const reopened = new ActionStore(state, clock, masterKey);
    expect(await reopened.execute(preview.id)).toEqual(receipt);
    expect(writes).toBe(1);
  });

  it('never resends a persisted sending operation after process restart', async () => {
    const state = new MemoryStateStore();
    const clock = new FakeClock();
    const first = new ActionStore(state, clock, masterKey);
    const preview = await first.prepare(input, 1, async () => new Promise<Receipt>(() => {}));
    const pending = first.execute(preview.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reopened = new ActionStore(state, clock, masterKey);
    await expect(reopened.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    const receipt = await reopened.reconcile(preview.id, async () => null);
    expect(receipt.state).toBe('uncertain');
    void pending;
  });

  it('reconciles by operation id after restart but refuses an unsent preview', async () => {
    const state = new MemoryStateStore();
    const clock = new FakeClock();
    const first = new ActionStore(state, clock, masterKey);
    const preview = await first.prepare(input, 1, async () => { throw new Error('lost response'); });
    const index = await state.list('operation:', null, 10);
    const operationId = index.items[0]!.key.slice('operation:'.length);
    await expect(new ActionStore(state, clock, masterKey).reconcile(operationId, async () => null)).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    await expect(first.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect((await new ActionStore(state, clock, masterKey).reconcile(operationId, async () => ({ operationId, state: 'confirmed', message: 'checked', result: null }))).state).toBe('confirmed');
  });

  it('refuses a blocked preview before any executor can send', async () => {
    const store = makeStore();
    let writes = 0;
    const preview = await store.prepare(input, 1, async () => { writes += 1; return { operationId: 'ack', state: 'confirmed', message: 'ok', result: null }; }, { blockers: ['independent verification missing'] });
    expect(preview.blockers).toHaveLength(1);
    await expect(store.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNSUPPORTED' } });
    expect(writes).toBe(0);
  });

  it('runs a read-only preflight before recording sending', async () => {
    const store = makeStore();
    let writes = 0;
    const preview = await store.prepare(input, 1, async () => { writes += 1; return { operationId: 'ack', state: 'confirmed', message: 'ok', result: null }; },
      { preflight: async () => { throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'question closed', retryAfterMs: null, operationId: null }); } });
    await expect(store.execute(preview.id)).rejects.toMatchObject({ data: { code: 'PRECONDITION_CHANGED' } });
    expect((await store.inspect(preview.id)).phase).toBe('preview');
    expect(writes).toBe(0);
  });

  it('encrypts the answer draft inside the saved operation record', async () => {
    const state = new MemoryStateStore();
    const store = new ActionStore(state, new FakeClock(), masterKey);
    const preview = await store.prepare(input, 1, async () => ({ operationId: 'ack', state: 'confirmed', message: 'ok', result: null }));
    const raw = JSON.stringify((await state.get(`preview:${preview.id}`))?.value);
    expect(raw).not.toContain('questionId');
    expect(raw).not.toContain('ex1');
    expect(raw).not.toContain('"keys":["A"]');
    expect(raw).toContain('inputCiphertext');
  });

  it('migrates an old plaintext sending record without replaying its write', async () => {
    const state = new MemoryStateStore();
    const clock = new FakeClock();
    const first = new ActionStore(state, clock, masterKey);
    const preview = await first.prepare(input, 1, async () => ({ operationId: 'ack', state: 'confirmed', message: 'ok', result: null }));
    const operationId = (await first.inspect(preview.id)).operationId;
    const old = await state.get(`preview:${preview.id}`);
    expect(old).not.toBeNull();
    expect(await state.commit({ expected: [{ key: `preview:${preview.id}`, revision: old!.revision }], changes: [{ key: `preview:${preview.id}`, value: { preview, operationId, input, phase: 'sending', receipt: null } }] })).toBe(true);
    const reopened = new ActionStore(state, clock, masterKey);
    expect((await reopened.inspect(preview.id)).phase).toBe('sending');
    await expect(reopened.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(JSON.stringify((await state.get(`preview:${preview.id}`))?.value)).not.toContain('questionId');
  });
});
