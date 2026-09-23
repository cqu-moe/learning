import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { validateExamHost } from '../src/providers/xuetang/exam-read.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, replay } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'x1', platform: 'xuetang' };

function runtimeOf(transport: Runtime['transport']): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    artifacts: { create: async () => { throw new Error('u'); }, resume: async () => { throw new Error('u'); }, open: async () => { throw new Error('u'); }, remove: async () => {} },
    clock: new FakeClock(),
    masterKey: new Uint8Array(32).fill(6),
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

const course = { scope, key: 'k', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '900' } };
const videoRef = { course, key: 'r', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: '8' } };
const examResource = { course, key: 'r', native: { kind: 'xuetang' as const, leafId: '30', leafInfoId: null } };

describe('xuetang resources (T09)', () => {
  it('media resolves playurl mp4 variants with duration', async () => {
    const media = await replay('xuetang/media', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      return client.resources.media(videoRef);
    });
    expect(media.variants.map((v) => v.quality)).toEqual(['hd', 'sd']);
    expect(media.variants[0]?.durationSeconds).toBe(120);
  });

  it('transcript uses the lecture-note endpoint with ms paragraphs', async () => {
    const transcript = await replay('xuetang/lecture-note', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      return client.resources.transcript(videoRef);
    });
    expect(transcript.value.state).toBe('available');
    expect(transcript.value.segments[0]).toEqual({ text: '本节讲述', startMs: 0, endMs: 4000 });
  });

  it('exam read: double-data gen_token → SSO → shuffled join; zero write calls (A091/A092)', async () => {
    const run = await replay('xuetang/exam-read', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      const refs = await client.assessments.resolve(examResource);
      expect(refs[0]?.kind).toBe('exam');
      const paper = await client.assessments.get(refs[0]!);
      return { paper, transport };
    });
    expect(run.paper.state).toBe('submitted');
    expect(run.paper.questions).toHaveLength(2);
    expect(run.paper.questions[0]?.myAnswer).toMatchObject({ kind: 'choice', keys: ['A'] });
    expect(run.paper.questions[1]?.kind).toBe('unknown');
    expect(run.transport.calls.some((call) => /start_paper|submit_paper/.test(call.url))).toBe(false);
  });

  it('rejects malicious exam_host before leaking the crypt (A091)', () => {
    expect(() => validateExamHost('https://evil.example.com')).toThrow(/host/);
    expect(validateExamHost('https://examination.xuetangx.com')).toBe('https://examination.xuetangx.com');
  });
});
