import { describe, expect, it } from 'vitest';
import { ActionStore, digestOf } from '../src/services/actions.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock } from './helpers/replay.js';
import type { ActionInput, Receipt } from '../src/public.js';

const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
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
  return new ActionStore(new MemoryStateStore(), new FakeClock());
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
    const store = new ActionStore(new MemoryStateStore(), clock);
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
    store.cancelAll();
    const again = await store.execute(preview.id);
    expect(again).toMatchObject({ state: 'confirmed' });
  });
});
