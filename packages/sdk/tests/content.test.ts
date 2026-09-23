import { describe, expect, it } from 'vitest';
import { normalizeContent } from '../src/content/html.js';
import { renderAssessmentMarkdown, normalizeAnswerValue } from '../src/content/markdown.js';
import { sha256Hex } from '../src/types/sha256.js';
import type { Assessment } from '../src/public.js';

describe('normalizeContent (T12, A121/A122)', () => {
  it('strips scripts and handlers, keeps text, sub/sup become single latex scripts', () => {
    const text = normalizeContent('<p>x<sub>1</sub><sup>2</sup></p><script>bad()</script>');
    expect(text.markdown).toContain('x');
    expect(text.markdown).not.toContain('<script>');
    expect(text.markdown).not.toContain('bad()');
    expect(text.markdown).toMatch(/\$x_\{1\}\^\{2\}\$/);
  });

  it('drops javascript: links and onerror handlers but keeps safe anchors as text', () => {
    const text = normalizeContent('<a href="javascript:alert(1)">点我</a><img src="https://cdn/x.png" alt="图"><b onclick="x()">加粗</b>');
    expect(text.plainText).toContain('点我');
    expect(text.plainText).toContain('加粗');
    expect(text.markdown).not.toContain('javascript:');
    expect(text.markdown).not.toContain('onclick');
    expect(text.markdown).toContain('![图]');
  });

  it('merges adjacent same-type scripts into one legal latex token with boundary spaces kept', () => {
    const text = normalizeContent('X<sub>s</sub><sub>ol</sub> Y');
    expect(text.markdown).toContain('$X_{sol}$ Y');
  });

  it('preserves numbers and units exactly in plainText (A122)', () => {
    const text = normalizeContent('<p>-1.0 1.0/10 2e3 m/s²</p>');
    expect(text.plainText).toContain('-1.0');
    expect(text.plainText).toContain('1.0/10');
    expect(text.plainText).toContain('2e3');
    expect(text.plainText).toContain('m/s²');
  });

  it('keeps decodeState semantics for clean and locked bodies', () => {
    expect(normalizeContent('<p>plain</p>').decodeState).toBe('not-needed');
    expect(normalizeContent('<p><span class="textfonts">x</span></p>').decodeState).toBe('partial');
    expect(normalizeContent('').decodeState).toBe('not-needed');
    expect(normalizeContent('<p>a</p>').sourceHash).toBe(sha256Hex('<p>a</p>'));
  });
});

describe('assessment export (T12)', () => {
  const assessment: Assessment = {
    ref: { resource: { course: { scope: { userId: 'local', profileId: 'p1', platform: 'ykt' }, key: 'k', native: { kind: 'ykt', classroomId: '1' } }, key: 'r', native: { kind: 'ykt', leafId: '2', leafInfoId: null } }, kind: 'homework', assessmentId: 'ex1' },
    title: '作业一',
    state: 'submitted',
    timed: null,
    fingerprint: 'fp',
    questions: [
      {
        id: 'q1',
        kind: 'single-choice',
        rawType: '1',
        body: { markdown: '1+1=?', plainText: '1+1=?', decodeState: 'not-needed', sourceHash: 'h' },
        options: [
          { key: 'A', body: { markdown: '1', plainText: '1', decodeState: 'not-needed', sourceHash: 'h' } },
          { key: 'B', body: { markdown: '2', plainText: '2', decodeState: 'not-needed', sourceHash: 'h' } },
        ],
        fingerprint: 'q1',
        attemptsUsed: null,
        maxAttempts: null,
        myAnswer: { kind: 'choice', keys: ['A'] },
        feedback: { origin: 'platform-feedback', answer: { kind: 'choice', keys: ['B'] }, sourceId: 'official', alternatives: [] },
      },
    ],
  };

  it('renders markdown with stable order, both answer fields separated', () => {
    const md = renderAssessmentMarkdown(assessment);
    expect(md).toContain('# 作业一');
    expect(md).toContain('1+1=?');
    expect(md).toContain('我的作答: A');
    expect(md).toContain('官方答案: B');
  });

  it('normalizes answer values for matching without erasing distinctions', () => {
    expect(normalizeAnswerValue({ kind: 'choice', keys: ['B', 'A'] })).toBe('A,B');
    expect(normalizeAnswerValue({ kind: 'judgement', value: true })).toBe('true');
    expect(normalizeAnswerValue({ kind: 'short-answer', text: ' x ' })).toBe('x');
    expect(normalizeAnswerValue({ kind: 'fill-blank', blanks: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] })).toBe('1=a;2=b');
    expect(normalizeAnswerValue({ kind: 'unset' })).toBe('');
  });
});
