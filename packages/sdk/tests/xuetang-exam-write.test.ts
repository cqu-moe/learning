import { describe, expect, it } from 'vitest';
import { encodeExamAnswer, examActionIndependent } from '../src/providers/xuetang/exam-write.js';

describe('xtx exam write (T17, A171/A172)', () => {
  it('rejects unverified fill-blank/short-answer encodings without any upstream write', () => {
    expect(() => encodeExamAnswer({ kind: 'short-answer', text: 'x' })).toThrow(expect.objectContaining({ data: expect.objectContaining({ code: 'UNSUPPORTED' }) }));
    expect(() => encodeExamAnswer({ kind: 'fill-blank', blanks: [{ id: '1', text: 'x' }] })).toThrow(expect.objectContaining({ data: expect.objectContaining({ code: 'UNSUPPORTED' }) }));
    expect(encodeExamAnswer({ kind: 'choice', keys: ['A'] })).toEqual(['A']);
    expect(encodeExamAnswer({ kind: 'judgement', value: false })).toEqual(['false']);
    expect(() => encodeExamAnswer({ kind: 'unset' })).toThrow(/unset/);
  });

  it('save and finalize are independent operations; save cannot implicitly start (A171/A172)', async () => {
    const calls: string[] = [];
    const result = await examActionIndependent({
      readState: async () => 'not-started',
      perform: async (action) => {
        calls.push(action);
        return { ok: true };
      },
      action: 'save',
    });
    expect(result.rejected).toBe(true);
    expect(calls).toHaveLength(0);

    const started = await examActionIndependent({
      readState: async () => 'in-progress',
      perform: async (action) => {
        calls.push(action);
        return { ok: true };
      },
      action: 'save',
    });
    expect(started.rejected).toBe(false);
    const finalized = await examActionIndependent({
      readState: async () => 'in-progress',
      perform: async (action) => {
        calls.push(action);
        return { ok: true };
      },
      action: 'finalize',
    });
    expect(finalized.rejected).toBe(false);
    expect(calls).toEqual(['save', 'finalize']);
  });

  it('already-final exams refuse further operations (A171)', async () => {
    const result = await examActionIndependent({
      readState: async () => 'submitted',
      perform: async () => ({ ok: true }),
      action: 'save',
    });
    expect(result.rejected).toBe(true);
  });
});
