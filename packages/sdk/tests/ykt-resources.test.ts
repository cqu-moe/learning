import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { normalizeSubtitleList, parseSrt } from '../src/providers/ykt/resources.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, replay } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { MediaInfo, Scope, Transcript } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'p1', platform: 'ykt' };

function runtimeOf(transport: Runtime['transport']): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    artifacts: {
      create: async () => { throw new Error('unused'); },
      resume: async () => { throw new Error('unused'); },
      open: async () => { throw new Error('unused'); },
      remove: async () => {},
    },
    clock: new FakeClock(),
    masterKey: new Uint8Array(32).fill(5),
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

const classroom = { scope, key: 'k', native: { kind: 'ykt' as const, classroomId: '28930736' } };
const videoRef = { course: classroom, key: 'r', native: { kind: 'ykt' as const, leafId: '502', leafInfoId: '602' } };
const homeworkResource = { course: classroom, key: 'r', native: { kind: 'ykt' as const, leafId: '505', leafInfoId: '605' } };

describe('ykt resources (T07)', () => {
  it('history slides never checkin and never touch a renderer (A072)', async () => {
    const run = await replay('ykt/history-slides', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      const lessons = await client.resources.lessons(classroom);
      expect(lessons.items).toHaveLength(2);
      expect(lessons.items[0]?.title).toBe('第一课');
      const lesson = lessons.items[0]!;
      const result = await client.resources.slides({ scope, course: null, lessonId: lesson.ref.lessonId });
      expect(result.warnings).toEqual([]);
      return { decks: result.value, transport };
    });
    expect(run.decks).toHaveLength(2);
    expect(run.decks[0]?.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(run.transport.calls.some((call) => call.url.includes('/lesson/checkin'))).toBe(false);
  });

  it('media resolves ccid → playurl variants; subtitles parse three shapes (A071 base)', async () => {
    const media = await replay('ykt/media', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      return client.resources.media(videoRef) as Promise<MediaInfo>;
    });
    expect(media.variants.map((v) => v.quality).sort()).toEqual(['hd', 'sd']);
    const transcript = await replay('ykt/transcript', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      return client.resources.transcript(videoRef) as Promise<{ value: Transcript; warnings: unknown[] }>;
    });
    expect(transcript.value.state).toBe('available');
    expect(transcript.value.language).toBe('zh-CN');
    expect(transcript.value.segments[0]).toEqual({ text: '第一句', startMs: 0, endMs: 2000 });

    expect(normalizeSubtitleList(['https://x/zh.srt'])).toEqual([{ language: 'und', url: 'https://x/zh.srt' }]);
    expect(normalizeSubtitleList({ 'zh-CN': 'https://x/z.srt' })).toEqual([{ language: 'zh-CN', url: 'https://x/z.srt' }]);
    expect(normalizeSubtitleList(null)).toEqual([]);
  });

  it('subtitle fetch failure is an error, never reported as absent (A071)', async () => {
    await replay('ykt/transcript', async ({ transport }) => {
      transport.script([
        { status: 200, headers: {}, body: { data: { content_info: { media: { ccid: 'CC1' } } } } },
        { status: 500, headers: {} },
        { status: 500, headers: {} },
        { status: 500, headers: {} },
      ]);
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      await expect(client.resources.transcript(videoRef)).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
    });
  });

  it('exam read SSO joins shuffled paper/results by problem_id (A071)', async () => {
    const assessment = await replay('ykt/exam-read', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      const refs = await client.assessments.resolve({ course: classroom, key: 'r', native: { kind: 'ykt' as const, leafId: '510', leafInfoId: null } });
      expect(refs).toHaveLength(1);
      expect(refs[0]?.kind).toBe('exam');
      return client.assessments.get(refs[0]!);
    });
    expect(assessment.state).toBe('submitted');
    expect(assessment.questions).toHaveLength(2);
    expect(assessment.questions[0]?.myAnswer).toMatchObject({ kind: 'choice', keys: ['A'] });
    expect(assessment.questions[0]?.feedback?.answer).toMatchObject({ kind: 'choice', keys: ['B'] });
    expect(assessment.questions[1]?.myAnswer).toBeNull();
  });

  it('homework exercise read marks font-locked bodies unavailable, not fake plaintext (A072)', async () => {
    const assessment = await replay('ykt/exercise-read', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      const refs = await client.assessments.resolve(homeworkResource);
      return client.assessments.get(refs[0]!);
    });
    expect(assessment.questions).toHaveLength(1);
    expect(assessment.questions[0]?.body.decodeState).toBe('partial');
    expect(assessment.questions[0]?.body.plainText).toContain('【未解码】');
    expect(assessment.questions[0]?.body.plainText).not.toContain('<span');
  });

  it('parses srt edge cases deterministically', () => {
    const segments = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n第二行\n');
    expect(segments).toEqual([
      { text: '你好', startMs: 1000, endMs: 2500 },
      { text: '第二行', startMs: 3000, endMs: 4000 },
    ]);
  });
});
