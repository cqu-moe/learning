import type { Answer, Assessment } from '../types/models.js';

/** Canonical string form used for matching; distinctions (A122) stay intact. */
export function normalizeAnswerValue(answer: Answer): string {
  switch (answer.kind) {
    case 'choice':
      return [...answer.keys].sort().join(',');
    case 'judgement':
      return String(answer.value);
    case 'fill-blank':
      return answer.blanks.map((blank) => `${blank.id}=${blank.text}`).join(';');
    case 'short-answer':
      return answer.text.trim();
    case 'unset':
      return '';
  }
}

function answerText(answer: Answer | null): string {
  if (answer === null) return '—';
  if (answer.kind === 'choice') return answer.keys.join(',');
  if (answer.kind === 'judgement') return answer.value ? '正确' : '错误';
  if (answer.kind === 'fill-blank') return answer.blanks.map((b) => b.text).join(' | ');
  if (answer.kind === 'short-answer') return answer.text;
  return '未作答';
}

export function renderAssessmentMarkdown(assessment: Assessment): string {
  const lines: string[] = [`# ${assessment.title}`, '', `状态: ${assessment.state}`, ''];
  assessment.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.body.plainText || question.body.markdown}`);
    for (const option of question.options) {
      lines.push(`   - ${option.key}. ${option.body.plainText || option.body.markdown}`);
    }
    lines.push(`   我的作答: ${answerText(question.myAnswer)}`);
    if (question.feedback !== null) {
      lines.push(`   官方答案: ${answerText(question.feedback.answer)}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}
