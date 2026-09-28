import { CliError } from '../output.js';
import type { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { runJobForeground } from '../foreground.js';
import { createInterface } from 'node:readline/promises';
import type { Answer, JobEvent } from '@learning/sdk/public';

async function confirmCurrentAnswer(client: ReturnType<typeof createLearningClient>, jobId: string, event: Extract<JobEvent, { type: 'question' }>): Promise<void> {
  process.stderr.write(`live question ${event.question.id} (${event.question.kind}); content unavailable in CLI\n`);
  if (!process.stdin.isTTY || event.closesAtMs === null) return;
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const raw = (await prompt.question('Answer choice keys (A,B) or true/false; Enter skips: ')).trim();
    if (raw === '') return;
    let answer: Answer;
    if (event.question.kind === 'single-choice' || event.question.kind === 'multi-choice') {
      const keys = raw.split(',').map((key) => key.trim().toUpperCase()).filter(Boolean);
      if (keys.length === 0 || keys.some((key) => !/^[A-Z0-9]+$/.test(key))) { process.stderr.write('learning: invalid choice keys; question skipped\n'); return; }
      answer = { kind: 'choice', keys };
    } else if (event.question.kind === 'judgement' && /^(true|false)$/i.test(raw)) answer = { kind: 'judgement', value: raw.toLowerCase() === 'true' };
    else { process.stderr.write('learning: this answer type is not verified; question skipped\n'); return; }
    const confirmed = (await prompt.question(`Submit answer to current question ${event.question.id}? Type yes: `)).trim();
    if (confirmed !== 'yes') return;
    const preview = await client.actions.prepare({ kind: 'live.answer', liveJobId: jobId, questionId: event.question.id, phaseId: event.phaseId, answer });
    const receipt = await client.actions.execute(preview.id);
    process.stderr.write(`live answer ${event.question.id}: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}\n`);
  } catch (error) {
    process.stderr.write(`learning: ${error instanceof Error ? error.message : 'live answer failed'}\n`);
  } finally { prompt.close(); }
}

export function registerLiveCommand(program: Command): void {
  const live = program.command('live <lesson-url>')
    .description('check in and watch a Yuketang live lesson in the current terminal')
    .option('--yes', 'explicitly confirm checkin');
  live.action(async (url: string) => {
    if (!live.opts<{ yes?: boolean }>().yes) { throw new CliError('INVALID_INPUT', String('learning: live checkin requires --yes\n').replace(/^learning: /, '').trim(), 2); }
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      if (profile.scope.platform !== 'ykt') throw new LearningError({ code: 'UNSUPPORTED', message: 'live watch is currently limited to Yuketang', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const lesson = await client.resources.resolveLesson(url);
        const preview = await client.actions.prepare({ kind: 'live.join', lesson, maxDurationSeconds: 6 * 60 * 60 });
        const execution = await client.actions.execute(preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'live checkin did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id, { onEvent: async (event) => {
          if (event.type === 'question') await confirmCurrentAnswer(client, execution.job.id, event);
          else if (event.type === 'gap') process.stderr.write(`live gap: ${event.message}\n`);
        } });
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial') process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        printResult(program, job, `${job.id}: ${job.status}`);
      } finally { await client.close(); }
    });
  });
}
