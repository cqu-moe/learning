import { CliError, getOutput } from '../output.js';
import type { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, executeAction } from '../context.js';
import { runJobForeground } from '../foreground.js';
import { createPrompts, confirmAction, requireConfirmation } from '../prompts.js';
import type { Output } from '../output.js';
import type { Answer, JobEvent } from '@learning/sdk/public';
import { trackWorkflowEvent } from '../telemetry.js';

export async function confirmCurrentAnswer(client: ReturnType<typeof createLearningClient>, jobId: string, event: Extract<JobEvent, { type: 'question' }>, output: Output): Promise<void> {
  await output.message(`当前题目 ${event.question.id}：${event.question.body.plainText}`, true);
  if (!output.mode.interactive || event.closesAtMs === null || event.closesAtMs <= Date.now()) return;
  if (['unknown', 'fill-blank', 'short-answer'].includes(event.question.kind) || ['partial', 'unavailable'].includes(event.question.body.decodeState) || event.question.options.some(option => ['partial','unavailable'].includes(option.body.decodeState))) {
    await output.warning('UNSUPPORTED', '此题未完整解码或题型未验证，跳过作答。'); return;
  }
  let executing = false;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.min(2147483647, event.closesAtMs - Date.now()));
  timer.unref();
  const signal = AbortSignal.any([deadline.signal, output.signal]);
  const prompts = createPrompts(output.mode);
  try {
    const choices = event.question.kind === 'judgement' ? [{ value: 'true', label: '正确' }, { value: 'false', label: '错误' }] : event.question.options.map(option => ({ value: option.key, label: `${option.key}. ${option.body.plainText}` }));
    const selected = await prompts.ask({ name: 'answer', message: '选择答案，或跳过本题', options: [{ value: '__skip__', label: '跳过本题' }, ...choices], multiple: event.question.kind === 'multi-choice' }, signal);
    if (selected === '__skip__' || Array.isArray(selected) && selected.includes('__skip__')) return;
    const answer: Answer = event.question.kind === 'judgement' ? { kind: 'judgement', value: selected === 'true' } : { kind: 'choice', keys: Array.isArray(selected) ? selected.map(String) : [String(selected)] };
    const preview = await client.actions.prepare({ kind: 'live.answer', liveJobId: jobId, questionId: event.question.id, phaseId: event.phaseId, answer });
    if (signal.aborted || Date.now() >= event.closesAtMs) return;
    if (!(await prompts.ask({ name: 'confirm', message: `提交当前题 ${event.question.id} 的答案 ${JSON.stringify(answer)}？`, confirm: true }, signal))) return;
    if (signal.aborted || Date.now() >= event.closesAtMs) return;
    executing = true;
    const receipt = await executeAction(output, client, preview.id);
    await output.message(`本题结果：${receipt.type === 'receipt' ? receipt.receipt.state : '已创建任务'}`);
  } catch (error) {
    if (!executing && deadline.signal.aborted && !output.signal.aborted && error instanceof CliError && error.code === 'CANCELED') { await output.message('本题已结束，未发送答案。'); return; }
    throw error;
  } finally { clearTimeout(timer); }
}

export function registerLiveCommand(program: Command): void {
  const live = program.command('live <lesson-url>')
    .description('签到并监听雨课堂直播，逐题独立确认')
    .option('--yes', '明确确认签到');
  live.action(async (url: string) => {
    requireConfirmation(program, live.opts<{ yes?: boolean }>().yes, false);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile.scope.platform !== 'ykt') throw new LearningError({ code: 'UNSUPPORTED', message: 'live watch is currently limited to Yuketang', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const lesson = await client.resources.resolveLesson(url);
        const preview = await client.actions.prepare({ kind: 'live.join', lesson, maxDurationSeconds: 6 * 60 * 60 });
        await confirmAction(program, `账号：${profile.name}，加入此课堂会产生签到记录。`, live.opts<{ yes?: boolean }>().yes);
        const execution = await executeAction(getOutput(program), client, preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'live checkin did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id, { onEvent: async (event) => {
          if (event.type === 'question') await confirmCurrentAnswer(client, execution.job.id, event, getOutput(program));
          else if (event.type === 'gap') await getOutput(program).warning('LIVE_GAP', event.message);
        } });
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial') process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        trackWorkflowEvent(getOutput(program), { event: 'live_session_completed', properties: { status: job.status } });
        printResult(program, job, `${job.id}: ${job.status}`);
      } finally { await client.close(); }
    });
  });
}
