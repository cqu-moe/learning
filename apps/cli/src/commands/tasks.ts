import { confirmAction, requireConfirmation } from '../prompts.js';
import type { Prompts } from '../prompts.js';
import type { Job, JobStatus } from '@learning/sdk/public';
import { CliError, formatTable } from '../output.js';
import type { Command } from 'commander';
import { JobSchema } from '@learning/sdk/public';
import { createLearningClient } from '@learning/sdk';
import { SqliteStateStore } from '@learning/sdk/node';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDataDir } from '../runtime.js';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';

function openJobStore(program: Command): SqliteStateStore | null {
  const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
  const dbPath = resolve(dataDir, 'state.db');
  if (!existsSync(dbPath)) {
    process.stderr.write('learning: local state is not initialized; run learning init first\n');
    process.exitCode = 3;
    return null;
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
      if (state === null) return;
      try {
        const jobs = [];
        let cursor: string | null = null;
        do {
          const page = await state.list('job:', cursor, 100);
          for (const item of page.items) jobs.push(JobSchema.parse(item.record.value));
          cursor = page.nextCursor;
        } while (cursor !== null);
        printResult(program, { jobs }, formatTable(['任务', '类型', '状态', '进度'], jobs.map(job => [job.id, job.kind, job.status, `${job.completed}/${job.total ?? '?'}`])));
      } finally {
        state.close();
      }
    });
  jobs
    .command('show <jobId>')
    .description('只读查看任务详情')
    .action(async (jobId: string) => {
      const state = openJobStore(program);
      if (state === null) return;
      try {
        const stored = await state.get(`job:${jobId}`);
        if (stored === null) { throw new CliError('INVALID_INPUT', `unknown job id ${jobId}`, 2); }
        const job = JobSchema.parse(stored.value);
        printResult(program, job, `${job.id} · ${job.kind} · ${job.status} · ${job.completed}/${job.total ?? '?'}\n${nextStep(program, job)}`);
      } finally { state.close(); }
    });
  jobs
    .command('cancel <jobId>')
    .description('取消任务，不回滚已完成部分')
    .option('--yes', '确认取消任务')
    .action(async (jobId: string, options: { yes?: boolean }) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
          const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const current = await client.jobs.get(jobId);
          await confirmAction(program, `取消任务 ${jobId}（${current.status}）；已完成部分不会回滚。`, options.yes);
          const job = await client.jobs.cancel(jobId);
          printResult(program, job, `${job.id}: ${job.status}`);
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
            await confirmAction(program, `恢复直播任务 ${jobId} 会重新签到。`, resume.opts<{ yes?: boolean }>().yes);
            await client.jobs.resume(jobId);
          } else if (before.status === 'paused' || before.status === 'needs-input' && before.kind === 'study') await client.jobs.resume(jobId);
          else if (!['queued', 'waiting', 'succeeded'].includes(before.status)) { process.stderr.write(`learning: ${before.status} job cannot resume without reconciliation\n`); process.exitCode = before.status === 'uncertain' || before.status === 'running' ? 5 : 3; return; }
          const job = await runJobForeground(client, runtime, jobId);
          const files = job.kind === 'export' ? await publishJobArtifacts(runtime, job, dataDir) : [];
          if (job.status === 'partial') process.exitCode = 4;
          else if (job.status === 'uncertain') process.exitCode = 5;
          else if (job.status !== 'succeeded') process.exitCode = 3;
          printResult(program, { job, files }, `${job.id}: ${job.status}\n${files.join('\n')}\n${nextStep(program, job)}`);
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
          printResult(program, { receipt, job }, `${job.id}: ${receipt.state}; ${job.status}`);
        } finally { await client.close(); }
      });
    });
}

export async function selectJob(state: SqliteStateStore, prompts: Prompts, allowedStatuses?: JobStatus[], profileId?: string): Promise<Job> {
  const jobs: Job[] = [];
  let cursor: string | null = null;
  do {
    const page = await state.list('job:', cursor, 100);
    for (const item of page.items) {
      const job = JobSchema.parse(item.record.value);
      if ((!allowedStatuses || allowedStatuses.includes(job.status)) && (!profileId || job.scope.profileId === profileId)) jobs.push(job);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  if (!jobs.length) throw new CliError('INTERACTION_REQUIRED', '没有符合此操作条件的任务。请用 jobs list 查看所有状态。', 3);
  const id = await prompts.ask({ name: 'jobId', message: '选择任务', options: jobs.map(job => ({ value: job.id, label: `${job.kind} · ${job.status} · ${job.id}` })) });
  const job = jobs.find(job => job.id === id);
  if (!job) throw new CliError('INVALID_INPUT', '未选择有效任务。');
  return job;
}
function nextStep(program: Command, job: Job): string {
  const home = program.opts<{ home?: string }>().home ?? process.env.LEARNING_HOME;
  const prefix = home === undefined ? 'learning' : `learning --home '${home.replaceAll("'", "'\\''")}'`;
  if (job.status === 'uncertain') return `先核对写入结果：${prefix} jobs reconcile '${job.id}'`;
  if (job.status === 'paused' || job.status === 'needs-input') return `处理提示后恢复：${prefix} jobs resume '${job.id}'`;
  return '';
}
