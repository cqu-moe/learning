import { describe, expect, it } from 'vitest';
import { importLegacyDraft, importFeedbackSet, MAX_DRAFT_BYTES, exportDraftYaml } from '../src/services/drafts.js';
import { matchDraft } from '../src/content/match.js';
import { proposeMatches } from '../src/services/model.js';
import { sha256Hex } from '../src/types/sha256.js';
import type { AnswerDraft, FeedbackSet, Question } from '../src/public.js';
import type { AssessmentRef, Scope } from '../src/public.js';

const ref: AssessmentRef = {
  resource: {
    course: { scope: { userId: 'local', profileId: 'p1', platform: 'ykt' }, key: 'k', native: { kind: 'ykt' as const, classroomId: '1' } },
    key: 'r',
    native: { kind: 'ykt' as const, leafId: '2', leafInfoId: null },
  },
  kind: 'homework' as const,
  assessmentId: '888001',
};
const scope: Scope = ref.resource.course.scope;

function question(id: string, body: string, options: Array<[string, string]>, fingerprintSeed: string): Question {
  return {
    id,
    kind: 'single-choice',
    rawType: '1',
    body: { markdown: body, plainText: body, decodeState: 'not-needed', sourceHash: 'h' },
    options: options.map(([key, text]) => ({ key, body: { markdown: text, plainText: text, decodeState: 'not-needed' as const, sourceHash: 'h' } })),
    fingerprint: sha256Hex(fingerprintSeed),
    attemptsUsed: null,
    maxAttempts: null,
    myAnswer: null,
    feedback: null,
  };
}

const draftYaml = [
  'exercise_id: 888001',
  'leaf_id: 505',
  'classroom_id: 1',
  'answers:',
  '  11: A',
  '  12: [A, B]',
  '  13: 正确',
  '  14: 答案文字',
].join('\n');

describe('draft import (T13)', () => {
  it('parses the legacy ykt YAML shape into an AnswerDraft', async () => {
    const result = await importLegacyDraft(draftYaml, 'ykt', scope);
    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.ref.assessmentId).toBe('888001');
    const byId = new Map(result.value.entries.map((entry) => [entry.questionId, entry.answer]));
    expect(byId.get('11')).toMatchObject({ kind: 'choice', keys: ['A'] });
    expect(byId.get('12')).toMatchObject({ kind: 'choice', keys: ['A', 'B'] });
    expect(byId.get('13')).toMatchObject({ kind: 'judgement', value: true });
    expect(byId.get('14')).toMatchObject({ kind: 'short-answer', text: '答案文字' });
  });

  it('rejects oversize input and custom YAML tags (A132)', async () => {
    await expect(importLegacyDraft('x'.repeat(MAX_DRAFT_BYTES + 1), 'ykt', scope)).rejects.toMatchObject({ data: { code: 'INVALID_INPUT' } });
    await expect(importLegacyDraft('a: !bomb 1', 'ykt', scope)).rejects.toMatchObject({ data: { code: 'INVALID_INPUT' } });
    await expect(importLegacyDraft('{broken', 'learning', scope)).rejects.toMatchObject({ data: { code: 'INVALID_INPUT' } });
  });

  it('round-trips a learning draft and rejects a different profile', async () => {
    const draft: AnswerDraft = { schemaVersion: 1, id: 'd1', ref, fingerprint: 'fingerprint', entries: [{ questionId: '11', fingerprint: 'question-fp', answer: { kind: 'unset' }, evidence: null }] };
    const text = exportDraftYaml(draft);
    expect((await importLegacyDraft(text, 'learning', scope)).value).toEqual(draft);
    await expect(importLegacyDraft(text, 'learning', { ...scope, profileId: 'another' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  });

  it('imports a ykt feedback set with official answers', async () => {
    const raw = JSON.stringify({
      exercise_id: 888001,
      problems: [
        { problem_id: 11, content: { ProblemType: 1, Body: '<p>题干</p>', Options: [{ key: 'A', value: '<p>甲</p>' }, { key: 'C', value: '<p>丙</p>' }], Answers: ['C'] } },
      ],
    });
    const set = await importFeedbackSet(raw, ref);
    expect(set.questions[0]?.feedback?.answer).toMatchObject({ kind: 'choice', keys: ['C'] });
    expect(set.questions[0]?.fingerprint).toBe(sha256Hex(JSON.stringify(['11', 'single-choice', '题干', [['A', '甲'], ['C', '丙']]])));
  });
});

function makeDraft(questions: Question[], answers: Array<[string, 'A' | 'C']>): AnswerDraft {
  return {
    schemaVersion: 1,
    id: 'd1',
    ref,
    fingerprint: 'draft-fp',
    entries: questions.map((q, index) => ({
      questionId: q.id,
      fingerprint: q.fingerprint,
      answer: { kind: 'choice', keys: [answers[index]?.[1] ?? 'A'] },
      evidence: { origin: 'user', answer: { kind: 'choice', keys: [answers[index]?.[1] ?? 'A'] }, sourceId: 'user', alternatives: [] },
    })),
  };
}

describe('matching (T13, A131/A132)', () => {
  const q1 = question('11', '选对的', [['A', '甲'], ['C', '丙']], 'q1-seed');
  const q2 = question('12', '多选', [['A', 'x'], ['B', 'y'], ['C', 'z']], 'q2-seed');

  it('does not match incomplete options or feedback, even when fingerprints match', () => {
    const draft = makeDraft([q1], [['A', 'A']]);
    const incomplete = { ...q1, options: q1.options.map(option => ({ ...option, body: { ...option.body, decodeState: 'partial' as const } })) };
    const feedback: FeedbackSet = { schemaVersion: 1, id: 'feedback', ref, questions: [{ ...q1, feedback: { origin: 'platform-feedback', answer: { kind: 'choice', keys: ['A'] }, sourceId: 'official', alternatives: [] } }] };
    expect(matchDraft(draft, [feedback], [incomplete])[0]?.state).toBe('blocked');
    feedback.questions[0] = { ...incomplete, feedback: feedback.questions[0]!.feedback };
    expect(matchDraft(draft, [feedback], [q1])[0]?.answer).toBeNull();
  });

  it('matches exactly and remaps reordered options', () => {
    const draft = makeDraft([q1, q2], [['A', 'A'], ['C', 'C']]);
    const source: FeedbackSet = {
      schemaVersion: 1,
      id: 's1',
      ref,
      questions: [
        { ...q1, id: '901', fingerprint: sha256Hex('q1-seed'), feedback: { origin: 'platform-feedback', answer: { kind: 'choice', keys: ['C'] }, sourceId: 'official', alternatives: [] } },
        { ...question('902', '多选', [['C', 'z'], ['B', 'y'], ['A', 'x']], 'reordered'), feedback: { origin: 'platform-feedback' as const, answer: { kind: 'choice' as const, keys: ['C'] }, sourceId: 'official', alternatives: [] } },
      ],
    };
    const matches = matchDraft(draft, [source], [q1, q2]);
    expect(matches[0]).toMatchObject({ state: 'exact', answer: { kind: 'choice', keys: ['C'] } });
    expect(matches[1]?.state).toBe('suggested');
    expect(matches[1]?.answer).toMatchObject({ kind: 'choice', keys: ['C'] });
  });

  it('blocks cross exam/homework, undecoded bodies, and duplicate-option ambiguity', () => {
    const draft = makeDraft([q1], [['A', 'A']]);
    const foreign: FeedbackSet = { schemaVersion: 1, id: 's2', ref: { ...ref, kind: 'exam', assessmentId: '777001' }, questions: [{ ...q1, feedback: { origin: 'platform-feedback', answer: { kind: 'choice', keys: ['C'] }, sourceId: 'o', alternatives: [] } }] };
    expect(matchDraft(draft, [foreign], [q1])[0]?.state).toBe('blocked');

    const locked: Question = { ...q1, body: { markdown: 'x', plainText: 'x', decodeState: 'partial', sourceHash: 'h' } };
    const lockedDraft = makeDraft([locked], [['A', 'A']]);
    const lockedSet: FeedbackSet = { schemaVersion: 1, id: 's3', ref, questions: [{ ...locked, feedback: { origin: 'platform-feedback', answer: { kind: 'choice', keys: ['C'] }, sourceId: 'o', alternatives: [] } }] };
    expect(matchDraft(lockedDraft, [lockedSet], [locked])[0]?.state).toBe('blocked');

    const dupTarget = question('99', '选对的', [['A', '甲'], ['B', '甲']], 'dup');
    const dupSet: FeedbackSet = { schemaVersion: 1, id: 's4', ref, questions: [{ ...q1, id: '99', options: dupTarget.options, feedback: { origin: 'platform-feedback', answer: { kind: 'choice', keys: ['A'] }, sourceId: 'o', alternatives: [] } }] };
    expect(matchDraft(draft, [dupSet], [q1])[0]?.state).toBe('ambiguous');
  });
});

describe('model suggestions (T13, A132)', () => {
  it('does not send unselected or undecoded question content to the model', async () => {
    const clear = question('11', '可读题', [['A', '甲']], 'clear');
    const locked = { ...question('12', '不能发送的密文', [['A', '乱码']], 'locked'), body: { markdown: '密文', plainText: '不能发送的密文', decodeState: 'partial' as const, sourceHash: 'locked' } };
    const draft = makeDraft([clear, locked], [['A', 'A'], ['A', 'A']]);
    let content = '';
    const model = { propose: async (input: { content: unknown }) => { content = JSON.stringify(input.content); return { suggestions: [{ questionId: '11', keys: ['A'] }] }; } };
    const result = await proposeMatches(model, draft, [clear, locked]);
    expect(result[0]?.state).toBe('suggested');
    expect(result[1]?.state).toBe('blocked');
    expect(content).toContain('可读题');
    expect(content).not.toContain('不能发送的密文');
  });
  it('without a model client every proposal is blocked; with one, only question text is sent', async () => {
    const q1 = question('11', '题干', [['A', 'a'], ['B', 'b']], 'q1-seed');
    const draft = makeDraft([q1], [['A', 'A']]);
    const noModel = await proposeMatches(null, draft, [q1]);
    expect(noModel[0]?.state).toBe('blocked');

    let seenPayload: unknown = undefined;
    const fakeModel = {
      propose: async (input: { content: unknown }) => {
        seenPayload = input.content;
        return { suggestions: [{ questionId: '11', keys: ['B'] }] };
      },
    };
    const matches = await proposeMatches(fakeModel, draft, [q1]);
    expect(matches[0]).toMatchObject({ state: 'suggested', answer: { kind: 'choice', keys: ['B'] } });
    const payload = JSON.stringify(seenPayload);
    expect(payload).toContain('题干');
    expect(payload).not.toContain('sessionid');
    expect(payload).not.toContain('cookie');
  });
});
