import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  HOMEWORK_DRAFT_FORMAT,
  exportHomeworkDraftYaml,
  parseHomeworkDraft,
} from '../src/services/homework-draft.js';
import { LearningError } from '../src/types/errors.js';
import { sha256Hex } from '../src/types/sha256.js';
import type { AnswerDraft, Assessment, AssessmentRef } from '../src/public.js';

const ref: AssessmentRef = {
  resource: {
    course: {
      scope: { userId: 'local', profileId: 'p1', platform: 'ykt' },
      key: 'course-key',
      native: { kind: 'ykt', classroomId: '1' },
    },
    key: 'resource-key',
    native: { kind: 'ykt', leafId: '2', leafInfoId: null },
  },
  kind: 'homework',
  assessmentId: '888001',
};

function makeAssessment(): Assessment {
  return {
    ref,
    title: '普通作业',
    state: 'in-progress',
    timed: null,
    fingerprint: 'assessment-fingerprint',
    questions: [
      {
        id: '11',
        kind: 'single-choice',
        rawType: '1',
        body: { markdown: '<p>单选题干</p>', plainText: '单选题干', decodeState: 'not-needed', sourceHash: 'h11' },
        options: [
          { key: 'A', body: { markdown: '甲', plainText: '甲', decodeState: 'not-needed', sourceHash: 'h11a' } },
          { key: 'B', body: { markdown: '乙', plainText: '乙', decodeState: 'not-needed', sourceHash: 'h11b' } },
        ],
        fingerprint: 'question-11',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: null,
        feedback: null,
      },
      {
        id: '12',
        kind: 'multi-choice',
        rawType: '2',
        body: { markdown: '<p>多选题干</p>', plainText: '多选题干', decodeState: 'not-needed', sourceHash: 'h12' },
        options: [
          { key: 'A', body: { markdown: '甲', plainText: '甲', decodeState: 'not-needed', sourceHash: 'h12a' } },
          { key: 'B', body: { markdown: '乙', plainText: '乙', decodeState: 'not-needed', sourceHash: 'h12b' } },
          { key: 'C', body: { markdown: '丙', plainText: '丙', decodeState: 'not-needed', sourceHash: 'h12c' } },
        ],
        fingerprint: 'question-12',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: null,
        feedback: null,
      },
      {
        id: '13',
        kind: 'judgement',
        rawType: '6',
        body: { markdown: '<p>判断题干</p>', plainText: '判断题干', decodeState: 'not-needed', sourceHash: 'h13' },
        options: [],
        fingerprint: 'question-13',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: null,
        feedback: null,
      },
      {
        id: '14',
        kind: 'fill-blank',
        rawType: '4',
        body: { markdown: '<p>填空题干</p>', plainText: '填空题干', decodeState: 'not-needed', sourceHash: 'h14' },
        options: [],
        fingerprint: 'question-14',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: null,
        feedback: null,
      },
      {
        id: '15',
        kind: 'short-answer',
        rawType: '3',
        body: { markdown: '<p>简答题干</p>', plainText: '简答题干', decodeState: 'not-needed', sourceHash: 'h15' },
        options: [],
        fingerprint: 'question-15',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: null,
        feedback: null,
      },
      {
        id: '16',
        kind: 'unknown',
        rawType: '99',
        body: { markdown: '<p>未支持题型</p>', plainText: '未支持题型', decodeState: 'not-needed', sourceHash: 'h16' },
        options: [],
        fingerprint: 'question-16',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: null,
        feedback: null,
      },
    ],
  };
}

function makeDraft(assessment: Assessment): AnswerDraft {
  return {
    schemaVersion: 1,
    id: 'draft-888001',
    ref: assessment.ref,
    fingerprint: assessment.fingerprint,
    entries: assessment.questions.map((question) => ({
      questionId: question.id,
      fingerprint: question.fingerprint,
      answer: { kind: 'unset' },
      evidence: null,
    })),
  };
}

function entryAt(draft: AnswerDraft, index: number): AnswerDraft['entries'][number] {
  const entry = draft.entries[index];
  if (entry === undefined) throw new Error(`missing draft entry ${index}`);
  return entry;
}

describe('Yuketang homework YAML draft', () => {
  it('keeps an empty homework draft valid without inventing an answer', () => {
    const assessment = { ...makeAssessment(), questions: [] };
    expect(parseHomeworkDraft(exportHomeworkDraftYaml(makeDraft(assessment), assessment)).entries).toEqual([]);
  });
  it('exports annotated YAML and parses edited answers for all supported kinds', () => {
    const assessment = makeAssessment();
    const draft = makeDraft(assessment);
    draft.entries[0] = {
      ...entryAt(draft, 0),
      answer: { kind: 'choice', keys: ['B'] },
      evidence: {
        origin: 'platform-feedback',
        answer: { kind: 'choice', keys: ['B'] },
        sourceId: 'official',
        alternatives: [],
      },
    };
    draft.entries[1] = {
      ...entryAt(draft, 1),
      answer: { kind: 'choice', keys: ['B'] },
      evidence: {
        origin: 'user',
        answer: { kind: 'choice', keys: ['B'] },
        sourceId: 'previous-user-edit',
        alternatives: [{ blankId: '1', texts: ['old'] }],
      },
    };

    const text = exportHomeworkDraftYaml(draft, assessment);
    expect(text.indexOf('answers:')).toBeLessThan(text.indexOf('metadata:'));
    expect(text).toContain(`format: ${HOMEWORK_DRAFT_FORMAT}`);
    expect(text).toContain('# 11. 单选题干');
    expect(text).toContain('#   A. 甲');
    expect(text).toContain('# example: [A, B]');
    expect(text).toContain('# 15. 简答题干');
    expect(text).toContain('# 16. 未支持题型');

    const edited = YAML.parse(text) as { answers: Record<string, unknown> };
    edited.answers['11'] = 'B';
    edited.answers['12'] = ['C', 'A'];
    edited.answers['13'] = '错误';
    edited.answers['14'] = ['第一空', '第二空'];
    edited.answers['15'] = null;
    edited.answers['16'] = null;
    const parsed = parseHomeworkDraft(YAML.stringify(edited));

    expect(parsed).toMatchObject({
      id: draft.id,
      ref,
      fingerprint: assessment.fingerprint,
      entries: [
        {
          questionId: '11',
          answer: { kind: 'choice', keys: ['B'] },
          evidence: draft.entries[0]?.evidence,
        },
        {
          questionId: '12',
          answer: { kind: 'choice', keys: ['A', 'C'] },
          evidence: { origin: 'user', sourceId: 'user', alternatives: [] },
        },
        {
          questionId: '13',
          answer: { kind: 'judgement', value: false },
          evidence: { origin: 'user', sourceId: 'user', alternatives: [] },
        },
        {
          questionId: '14',
          answer: { kind: 'fill-blank', blanks: [{ id: '1', text: '第一空' }, { id: '2', text: '第二空' }] },
          evidence: { origin: 'user', sourceId: 'user', alternatives: [] },
        },
        {
          questionId: '15',
          answer: { kind: 'unset' },
          evidence: null,
        },
        {
          questionId: '16',
          answer: { kind: 'unset' },
          evidence: null,
        },
      ],
    });
  });

  it('maps an edited null to unset and clears evidence', () => {
    const assessment = makeAssessment();
    const draft = makeDraft(assessment);
    draft.entries[0] = {
      ...entryAt(draft, 0),
      answer: { kind: 'choice', keys: ['A'] },
      evidence: { origin: 'user', answer: { kind: 'choice', keys: ['A'] }, sourceId: 'user', alternatives: [] },
    };
    const edited = YAML.parse(exportHomeworkDraftYaml(draft, assessment)) as { answers: Record<string, unknown> };
    edited.answers['11'] = null;

    const parsed = parseHomeworkDraft(YAML.stringify(edited));

    expect(parsed.entries[0]).toMatchObject({
      questionId: '11',
      answer: { kind: 'unset' },
      evidence: null,
    });
  });

  it('rejects a draft that does not match the assessment', () => {
    const assessment = makeAssessment();
    const draft = makeDraft(assessment);
    draft.entries[0] = { ...entryAt(draft, 0), fingerprint: sha256Hex('changed') };

    expect(() => exportHomeworkDraftYaml(draft, assessment)).toThrow(LearningError);
  });

  it('rejects missing metadata, unknown keys, invalid options, empty multi-choice, and non-null unsupported kinds', () => {
    const assessment = makeAssessment();
    const text = exportHomeworkDraftYaml(makeDraft(assessment), assessment);
    const valid = YAML.parse(text) as {
      format: string;
      metadata: { questions: Array<{ id: string; kind: string }> };
      answers: Record<string, unknown>;
    };

    expect(() => parseHomeworkDraft(YAML.stringify({ ...valid, format: 'other' }))).toThrow(LearningError);
    expect(() => parseHomeworkDraft(YAML.stringify({ ...valid, metadata: undefined }))).toThrow(LearningError);
    expect(() => parseHomeworkDraft(YAML.stringify({ ...valid, answers: { ...valid.answers, unknown: 'A' } }))).toThrow(LearningError);

    const illegal = structuredClone(valid);
    illegal.answers['11'] = 'C';
    expect(() => parseHomeworkDraft(YAML.stringify(illegal))).toThrow(LearningError);

    const empty = structuredClone(valid);
    empty.answers['12'] = [];
    expect(() => parseHomeworkDraft(YAML.stringify(empty))).toThrow(LearningError);

    const unsupported = structuredClone(valid);
    const firstQuestion = unsupported.metadata.questions[0];
    if (firstQuestion === undefined) throw new Error('missing question metadata');
    unsupported.metadata.questions[0] = { ...firstQuestion, kind: 'short-answer' };
    unsupported.answers['11'] = 'A';
    expect(() => parseHomeworkDraft(YAML.stringify(unsupported))).toThrow(LearningError);

    const whitespaceBlank = structuredClone(valid);
    whitespaceBlank.answers['14'] = [' '];
    expect(() => parseHomeworkDraft(YAML.stringify(whitespaceBlank))).toThrow(LearningError);
  });

  it('does not treat delimiter-containing answer values as unchanged', () => {
    const assessment = makeAssessment();
    const choiceQuestion = assessment.questions.find((question) => question.id === '12');
    if (choiceQuestion === undefined) throw new Error('missing multi-choice question');
    assessment.questions = [{
      ...choiceQuestion,
      options: [
        { key: 'A,B', body: { markdown: '合成键', plainText: '合成键', decodeState: 'not-needed', sourceHash: 'h12x' } },
        { key: 'A', body: { markdown: '甲', plainText: '甲', decodeState: 'not-needed', sourceHash: 'h12a' } },
        { key: 'B', body: { markdown: '乙', plainText: '乙', decodeState: 'not-needed', sourceHash: 'h12b' } },
      ],
    }];
    const draft = makeDraft(assessment);
    draft.entries[0] = {
      ...entryAt(draft, 0),
      answer: { kind: 'choice', keys: ['A,B'] },
      evidence: {
        origin: 'user',
        answer: { kind: 'choice', keys: ['A,B'] },
        sourceId: 'previous-delimiter-answer',
        alternatives: [],
      },
    };

    const edited = YAML.parse(exportHomeworkDraftYaml(draft, assessment)) as { answers: Record<string, unknown> };
    edited.answers['12'] = ['A', 'B'];
    const parsed = parseHomeworkDraft(YAML.stringify(edited));

    expect(parsed.entries[0]?.evidence).toMatchObject({ origin: 'user', sourceId: 'user' });
  });

  it('rejects duplicate question IDs and YAML alias bombs', () => {
    const assessment = makeAssessment();
    assessment.questions = assessment.questions.slice(0, 1);
    const draft = makeDraft(assessment);
    draft.entries = [
      ...draft.entries,
      { ...entryAt(draft, 0), evidence: null },
    ];
    expect(() => exportHomeworkDraftYaml(draft, assessment)).toThrow(LearningError);

    const fullAssessment = makeAssessment();
    const valid = YAML.parse(exportHomeworkDraftYaml(makeDraft(fullAssessment), fullAssessment)) as Record<string, unknown>;
    const aliasYaml = YAML.stringify(valid)
      .replace(/^metadata:$/m, 'metadata: &metadata')
      .replace(/^answers:/m, 'metadata_alias: *metadata\nanswers:');
    expect(() => parseHomeworkDraft(aliasYaml)).toThrow(/homework draft is not strict YAML/);
    const duplicateAnswerKey = YAML.stringify(valid).replace(/^ {2}"11": null$/m, '  "11": null\n  "11": A');
    expect(() => parseHomeworkDraft(duplicateAnswerKey)).toThrow(LearningError);
  });

  it('rejects input over 4MiB before YAML parsing', () => {
    expect(() => parseHomeworkDraft(`format: ${HOMEWORK_DRAFT_FORMAT}\n# ${'x'.repeat(4 * 1024 * 1024)}\n`)).toThrow(LearningError);
  });
});
