import { getOutput } from '../output.js';
import type { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, executeAction } from '../context.js';
import { runJobForeground } from '../foreground.js';
import { requireConfirmation } from '../input.js';
import { trackWorkflowEvent } from '../telemetry.js';

export function registerLiveCommand(program: Command): void {
  const live = program.command('live <lesson-url>')
    .description('签到并输出雨课堂直播事件；不会自动作答')
    .option('--yes', '明确确认签到')
    .option('--dry-run', '只生成签到预览');
  live.action(async (url: string) => {
    const options = live.opts<{ yes?: boolean; dryRun?: boolean }>();
    requireConfirmation(program, options.yes, options.dryRun);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile.scope.platform !== 'ykt') throw new LearningError({ code: 'UNSUPPORTED', message: 'live watch is currently limited to Yuketang', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const lesson = await client.resources.resolveLesson(url);
        const preview = await client.actions.prepare({ kind: 'live.join', lesson, maxDurationSeconds: 6 * 60 * 60 });
        getOutput(program).set(preview, 'preview');
        if (options.dryRun) return;
        const execution = await executeAction(getOutput(program), client, preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'live checkin did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id);
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial') process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        trackWorkflowEvent(getOutput(program), { event: 'live_session_completed', properties: { status: job.status } });
        printResult(program, job);
      } finally { await client.close(); }
    });
  });
}
