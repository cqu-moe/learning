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
  const jobs = program.command('jobs').description('inspect local jobs');
  jobs
    .command('list')
    .description('list job records (read-only)')
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
        process.stdout.write(JSON.stringify(jobs) + '\n');
      } finally {
        state.close();
      }
    });
  jobs
    .command('show <jobId>')
    .description('show a saved job (read-only)')
    .action(async (jobId: string) => {
      const state = openJobStore(program);
      if (state === null) return;
      try {
        const stored = await state.get(`job:${jobId}`);
        if (stored === null) { process.stderr.write(`learning: unknown job id ${jobId}\n`); process.exitCode = 2; return; }
        const job = JobSchema.parse(stored.value);
        printResult(program, job, `${job.id}\t${job.kind}\t${job.status}\t${job.completed}/${job.total ?? '?'}`);
      } finally { state.close(); }
    });
  jobs
    .command('cancel <jobId>')
    .description('cancel a saved job under its profile')
    .action(async (jobId: string) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const job = await client.jobs.cancel(jobId);
          printResult(program, job, `${job.id}: ${job.status}`);
        } finally { await client.close(); }
      });
    });
  const resume = jobs.command('resume <jobId>')
    .description('resume an interrupted export under its profile')
    .option('--yes', 'confirm a new live checkin when resuming a live job');
  resume
    .action(async (jobId: string) => {
      await withCliRuntime(program, true, async (runtime, dataDir) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const before = await client.jobs.get(jobId);
          if (before.kind !== 'export' && before.kind !== 'study' && before.kind !== 'live') { process.stderr.write('learning: this job type has no CLI resume handler\n'); process.exitCode = 3; return; }
          if (before.kind === 'live') {
            if (!resume.opts<{ yes?: boolean }>().yes) { process.stderr.write('learning: live resume requires --yes for a new checkin\n'); process.exitCode = 2; return; }
            await client.jobs.resume(jobId);
          } else if (before.status === 'paused') await client.jobs.resume(jobId);
          else if (!['queued', 'waiting', 'succeeded'].includes(before.status)) { process.stderr.write(`learning: ${before.status} job cannot resume without reconciliation\n`); process.exitCode = before.status === 'uncertain' || before.status === 'running' ? 5 : 3; return; }
          const job = await runJobForeground(client, runtime, jobId);
          const files = job.kind === 'export' ? await publishJobArtifacts(runtime, job, dataDir) : [];
          if (job.status === 'partial') process.exitCode = 4;
          else if (job.status === 'uncertain') process.exitCode = 5;
          else if (job.status !== 'succeeded') process.exitCode = 3;
          printResult(program, { job, files }, `${job.id}: ${job.status}; ${files.join(', ')}`);
        } finally { await client.close(); }
      });
    });
  jobs
    .command('reconcile <jobId>')
    .description('read-only check of a job pending operation; refuses resume while uncertain')
    .action(async (jobId: string) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          await client.jobs.get(jobId);
          const meta = await runtime.state.get(`job-meta:${jobId}`);
          const pending = meta?.value && typeof meta.value === 'object' && !Array.isArray(meta.value) ? meta.value.pendingOperationId : null;
          if (typeof pending !== 'string' || pending.length === 0) {
            process.stderr.write('learning: job has no pending operation to reconcile\n');
            process.exitCode = 3;
            return;
          }
          const receipt = await client.actions.reconcile(pending);
          const job = await client.jobs.get(jobId);
          if (receipt.state === 'uncertain') process.exitCode = 5;
          printResult(program, { receipt, job }, `${job.id}: ${receipt.state}; ${job.status}`);
        } finally { await client.close(); }
      });
    });
}
