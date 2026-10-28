import { getProfile } from '../profiles.js';
import { requireConfirmation } from '../input.js';
import { CliError, getOutput, shellQuote } from '../output.js';
import type { Command } from 'commander';
import { JobSchema } from '@learning/sdk/public';
import { createLearningClient } from '@learning/sdk';
import { SqliteStateStore } from '@learning/sdk/node';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDataDir } from '../data-dir.js';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';
import { trackJobCompleted, trackJobStarted } from '../telemetry.js';

function openJobStore(program: Command): SqliteStateStore {
  const dataDir = ensureDataDir(program.opts<{ home?: string }>().home);
  const dbPath = resolve(dataDir, 'state.db');
  if (!existsSync(dbPath)) {
    throw new CliError('INTERACTION_REQUIRED', '本地尚未初始化。', 3, [], [`learning --home ${shellQuote(dataDir)} init`]);
  }
  return new SqliteStateStore(dbPath);
}

export function registerJobsCommands(program: Command): void {
  const jobs = program.command('jobs').description('查看和控制本地任务');
  jobs
    .command('list')
    .description('只读列出任务')
    .action(async () => {
      const state = openJobStore(program);
      try {
        const jobs = [];
        let cursor: string | null = null;
        do {
          const page = await state.list('job:', cursor, 100);
          for (const item of page.items) jobs.push(JobSchema.parse(item.record.value));
          cursor = page.nextCursor;
        } while (cursor !== null);
        printResult(program, { jobs });
      } finally {
        state.close();
      }
    });
  jobs
    .command('show <jobId>')
    .description('只读查看任务详情')
    .action(async (jobId: string) => {
      const state = openJobStore(program);
      try {
        const stored = await state.get(`job:${jobId}`);
        if (stored === null) { throw new CliError('INVALID_INPUT', `unknown job id ${jobId}`, 2); }
        const job = JobSchema.parse(stored.value);
        const name = program.opts<{ profile?: string }>().profile;
        if (name !== undefined) {
          const profile = await getProfile(state, name);
          if (!profile) throw new CliError('INVALID_INPUT', '找不到指定账号。', 2, ['profile']);
          if (profile.scope.profileId !== job.scope.profileId || profile.scope.platform !== job.scope.platform || profile.scope.userId !== job.scope.userId) throw new CliError('FORBIDDEN', '任务属于另一个账号。', 3, ['profile']);
        }
        printResult(program, job);
      } finally { state.close(); }
    });
  jobs
    .command('cancel <jobId>')
    .description('取消任务，不回滚已完成部分')
    .option('--yes', '确认取消任务')
    .action(async (jobId: string, options: { yes?: boolean }) => {
      requireConfirmation(program, options.yes);
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
          const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const current = await client.jobs.get(jobId);
          if (runtime.output !== undefined) trackJobStarted(runtime.output, current);
          const job = await client.jobs.cancel(jobId);
          if (runtime.output !== undefined) trackJobCompleted(runtime.output, job);
          printResult(program, job);
        } finally { await client.close(); }
      });
    });
  const resume = jobs.command('resume <jobId>')
    .description('恢复导出、学习或直播任务')
    .option('--yes', '确认恢复直播时重新签到');
  resume
    .action(async (jobId: string) => {
      await withCliRuntime(program, true, async (runtime, dataDir) => {
        const profile = await selectProfile(program, runtime);
          const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const before = await client.jobs.get(jobId);
          if (before.kind !== 'export' && before.kind !== 'study' && before.kind !== 'live') { throw new CliError('INTERACTION_REQUIRED', 'this job type has no CLI resume handler', 3); }
          if (before.kind === 'live') {
            requireConfirmation(program, resume.opts<{ yes?: boolean }>().yes, false);
            await client.jobs.resume(jobId, before.status === 'running' ? { recoverInterrupted: true } : undefined);
          } else if (before.kind === 'export' && before.status === 'running') await client.jobs.resume(jobId, { recoverInterrupted: true });
          else if (before.status === 'paused' || before.status === 'needs-input' && before.kind === 'study') await client.jobs.resume(jobId);
          else if (!['queued', 'waiting', 'succeeded'].includes(before.status)) {
            getOutput(program).set({ job: before });
            const meta = await runtime.state.get(`job-meta:${jobId}`);
            const pending = meta?.value && typeof meta.value === 'object' && !Array.isArray(meta.value) ? meta.value.pendingOperationId : null;
            const uncertain = before.status === 'uncertain' || before.status === 'running';
            throw new CliError(uncertain ? 'UNCERTAIN' : 'INTERACTION_REQUIRED', `任务状态为 ${before.status}，不能直接恢复。`, uncertain ? 5 : 3, ['jobId'], [], typeof pending === 'string' ? pending : null);
          }
          const job = await runJobForeground(client, runtime, jobId);
          getOutput(program).set({ job, files: [] });
          const files = job.kind === 'export' ? await publishJobArtifacts(runtime, job, dataDir) : [];
          if (job.status === 'partial' || job.status === 'succeeded' && job.warnings.some(warning => warning.code === 'SKIPPED_UNKNOWN_DURATION')) process.exitCode = 4;
          else if (job.status === 'uncertain') process.exitCode = 5;
          else if (job.status !== 'succeeded') process.exitCode = 3;
          printResult(program, { job, files });
        } finally { await client.close(); }
      });
    });
  jobs
    .command('reconcile <jobId>')
    .description('只读核对待确认写入，不重复发送')
    .action(async (jobId: string) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
          const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          await client.jobs.get(jobId);
          const meta = await runtime.state.get(`job-meta:${jobId}`);
          const pending = meta?.value && typeof meta.value === 'object' && !Array.isArray(meta.value) ? meta.value.pendingOperationId : null;
          if (typeof pending !== 'string' || pending.length === 0) {
            throw new CliError('INTERACTION_REQUIRED', 'job has no pending operation to reconcile', 3);
          }
          const receipt = await client.actions.reconcile(pending);
          const job = await client.jobs.get(jobId);
          if (receipt.state === 'uncertain') process.exitCode = 5;
          printResult(program, { receipt, job });
        } finally { await client.close(); }
      });
    });
}
