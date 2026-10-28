import { describe, expect, it } from 'vitest';
import { inspectHomeworkHtml, normalizeContent } from '../src/content/html.js';
import { renderAssessmentMarkdown, normalizeAnswerValue } from '../src/content/markdown.js';
import { sha256Hex } from '../src/types/sha256.js';
import type { Assessment } from '../src/public.js';

describe('normalizeContent (T12, A121/A122)', () => {
  it('preserves TeX text delimiters and commands without doubling backslashes', () => {
    const text = normalizeContent(String.raw`<p>比值 $\frac{1}{2}$，\(x_1^2\)，\[\sqrt{x}\]</p>`);
    expect(text.markdown).toBe(String.raw`比值 $\frac{1}{2}$，$x_1^2$，$$\sqrt{x}$$`);
    expect(text.decodeState).toBe('not-needed');
  });

  it('marks unsupported MathML as incomplete while retaining readable symbols', () => {
    const text = normalizeContent('<math><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr></mtable></math>');
    expect(text.markdown).toContain('公式未完整转换');
    expect(text.plainText).toContain('1');
    expect(text.plainText).toContain('2');
    expect(text.decodeState).toBe('partial');
  });

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
    expect(text.plainText).toBe('Xsol Y');
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

  it('collects only encrypted text characters and image sources for homework preparation', () => {
    expect(
      inspectHomeworkHtml(
        '<p class="xuetangx-com-encrypted-font">AB<span class="other textfonts">乙</span>' +
          '<img src="https://cdn.test/a.png" alt="图"></p>' +
          '<span class="xuetangx-com-encrypted-font"><img src="assets/b.png"><script>notText()</script></span>' +
          '<p>丙</p><img src="https://cdn.test/c.png">',
      ),
    ).toEqual({
      characters: ['A', 'B', '乙'],
      images: ['https://cdn.test/a.png', 'assets/b.png', 'https://cdn.test/c.png'],
    });
  });

  it('decodes only encrypted characters and counts repeated mapped glyphs as complete', () => {
    const content = normalizeContent(
      '<p><span class="xuetangx-com-encrypted-font">温列</span><span class="textfonts">列</span>外列</p>',
      { decoded: new Map([['温', '火'], ['列', '行']]) },
    );
    expect(content.markdown).toContain('火行行外列');
    expect(content.plainText).toBe('火行行外列');
    expect(content.decodeState).toBe('complete');
  });

  it('keeps a visible placeholder and partial state for unmapped encrypted characters', () => {
    const content = normalizeContent('<p><span class="xuetangx-com-encrypted-font">温列</span>外列</p>', {
      decoded: new Map([['温', '火']]),
    });
    expect(content.plainText).toBe('火【未解码】外列');
    expect(content.markdown).toContain('火【未解码】');
    expect(content.decodeState).toBe('partial');
  });

  it('renders verified images as local markdown and marks missing images', () => {
    const content = normalizeContent(
      '<p><img src="https://cdn.test/a.png" alt="题图" title=\'题 "目"\'><img src="https://cdn.test/missing.png" alt="缺">' +
        '<img src="https://cdn.test/traversal.png" alt="越界"><img src="https://cdn.test/backslash.png" alt="反斜杠"></p>',
      {
        images: new Map([
          ['https://cdn.test/a.png', 'assets/a image.png'],
          ['https://cdn.test/traversal.png', 'assets/../secret.png'],
          ['https://cdn.test/backslash.png', 'assets\\x.png'],
        ]),
      },
    );
    expect(content.markdown).toContain('![题图](assets/a\\ image.png');
    expect(content.markdown).toContain('题 \\"目\\"');
    expect(content.markdown).toContain('![缺][缺图]');
    expect(content.markdown).toContain('![越界][缺图]');
    expect(content.markdown).toContain('![反斜杠][缺图]');
    expect(content.markdown).not.toContain('https://cdn.test/missing.png');
    expect(content.markdown).not.toContain('secret.png');
    expect(content.plainText).toContain('题图');
    expect(content.plainText).toContain('缺');
    expect(content.decodeState).toBe('partial');
  });

  it('keeps observed LaTeX fields and basic MathML as formulas', () => {
    const content = normalizeContent(
      '<p><span data-latex="x^2">x2</span><math><mi>x</mi><msup><mrow><mi>y</mi></mrow><mn>2</mn></msup></math></p>',
    );
    expect(content.markdown).toContain('$x^2$');
    expect(content.markdown).toContain('$x y^{2}$');
    expect(content.plainText).toContain('x^2');
    expect(content.plainText).toContain('x y^{2}');
    expect(
      normalizeContent('<math><semantics><mrow><mi>x</mi></mrow><annotation>latex</annotation></semantics></math>').markdown,
    ).toContain('$x$');
  });

  it('does not expose executable HTML from tags, literal text, or image metadata', () => {
    const content = normalizeContent(
      '<p onclick="bad()">&lt;script&gt;alert(1)&lt;/script&gt;<iframe src="https://evil"></iframe></p>' +
        '<img src="https://cdn.test/x.png" alt="alt](javascript:alert(1))" title="title\\" onmouseover="bad()">',
      { images: new Map([['https://cdn.test/x.png', 'assets/x.png) [evil](javascript:alert(1)']]) },
    );
    expect(content.markdown).not.toContain('<script>');
    expect(content.markdown).not.toMatch(/\bon(click|mouseover)\s*=/i);
    expect(content.markdown).toContain('[缺图]');
    expect(content.decodeState).toBe('partial');
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

  it('renders rich question and option bodies instead of flattening them, and marks incomplete questions', () => {
    const md = renderAssessmentMarkdown({
      ...assessment,
      questions: [
        {
          ...assessment.questions[0]!,
          body: {
            markdown: '题干 **含图** ![图](assets/a.png)',
            plainText: '题干 含图 图',
            decodeState: 'not-needed',
            sourceHash: 'h',
          },
          options: [
            { key: 'A', body: { markdown: '选项 ![甲](assets/a.png)', plainText: '选项 甲', decodeState: 'partial', sourceHash: 'h' } },
          ],
        },
      ],
    });
    expect(md).toContain('题干 **含图** ![图](assets/a.png)');
    expect(md).toContain('A. 选项 ![甲](assets/a.png)');
    expect(md).toContain('[不完整]');
    expect(md).not.toContain('题干 含图 图');
  });

  it('normalizes answer values for matching without erasing distinctions', () => {
    expect(normalizeAnswerValue({ kind: 'choice', keys: ['B', 'A'] })).toBe('A,B');
    expect(normalizeAnswerValue({ kind: 'judgement', value: true })).toBe('true');
    expect(normalizeAnswerValue({ kind: 'short-answer', text: ' x ' })).toBe('x');
    expect(normalizeAnswerValue({ kind: 'fill-blank', blanks: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }] })).toBe('1=a;2=b');
    expect(normalizeAnswerValue({ kind: 'unset' })).toBe('');
  });
});
