import { CliError } from './output.js';
import type { StudyDisplay } from './output.js';
import { getJobOutputRoot } from './preferences.js';
import { listProfiles } from './profiles.js';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LearningClient } from '@learning/sdk';
import { LearningError } from '@learning/sdk';
import { trackJobCompleted, trackJobStarted } from './telemetry.js';
import { ActionInputSchema, CourseSchema } from '@learning/sdk/public';
import type { Job, JobEvent } from '@learning/sdk/public';
import type { CliRuntime } from './context.js';

export async function runJobForeground(client: LearningClient, runtime: CliRuntime, id: string, callbacks: { onEvent?: (event: JobEvent) => void | Promise<void>; onState?: (job: Job) => void | Promise<void>; signal?: AbortSignal; study?: StudyDisplay } = {}): Promise<Job> {
  let study = callbacks.study;
  const abort = new AbortController();
  const initialJob = await client.jobs.get(id);
  const observeJob = (job: Job, newAttempt = false): Job => {
    if (runtime.output !== undefined) {
      trackJobStarted(runtime.output, job, { newAttempt });
      trackJobCompleted(runtime.output, job, { canceled: abort.signal.aborted });
    }
    return job;
  };
  observeJob(initialJob, true);
  if (!study && initialJob.kind === 'study') {
    const stored = await runtime.state.get(`job-input:${id}`);
    if (stored !== null) {
      const input = ActionInputSchema.parse(stored.value);
      if (input.kind === 'study') {
        const course = input.resources[0]?.course;
        const cached = course ? await runtime.state.get(`cli:course:${course.key}`) : null;
        const profile = (await listProfiles(runtime.state)).find(profile => profile.scope.profileId === client.scope.profileId);
        study = { courseTitle: cached ? CourseSchema.parse(cached.value).title : '学习任务', profileName: profile?.name ?? '当前账号', speed: input.settings.speed, targetFraction: input.settings.targetFraction };
      }
    }
  }
  const onSignal = () => abort.abort();
  const signals = [callbacks.signal, runtime.output?.signal].filter((signal): signal is AbortSignal => signal !== undefined);
  for (const signal of signals) { signal.addEventListener('abort', onSignal, { once: true }); if (signal.aborted) onSignal(); }
  let afterSequence = 0;
  let lastState = '';
  let latestProgress: Extract<JobEvent, { type: 'progress' }> | null = null;
  let observedAtMs = runtime.clock.nowMs();
  const warnings = new Set<string>();
  const report = async (job: Job, event?: Extract<JobEvent, { type: 'progress' | 'state' }>) => {
    for (const warning of job.warnings) { const key = JSON.stringify(warning); if (!warnings.has(key)) { warnings.add(key); await runtime.output?.warning(warning.code, warning.message); } }
    if (event?.type === 'progress') {
      const cachedTitle = event.title ? null : await runtime.state.get(`cli:resource-title:${event.resourceKey}`);
      latestProgress = { ...event, title: event.title || (typeof cachedTitle?.value === 'string' ? cachedTitle.value : null) };
      observedAtMs = runtime.clock.nowMs();
    }
    if (latestProgress !== null && job.items.some(item => item.key === latestProgress?.resourceKey && ['succeeded', 'skipped'].includes(item.state))) latestProgress = null;
    const signature = JSON.stringify([job.id, job.status, job.completed, job.total, job.nextRunAtMs, latestProgress?.sequence]);
    if (event?.type !== 'progress' && signature === lastState) return;
    lastState = signature;
    observeJob(job);
    await callbacks.onState?.(job);
    const live = latestProgress;
    await runtime.output?.progress({ jobId: id, resourceKey: live?.resourceKey ?? null, status: job.status, completed: job.completed, total: job.total, serverFraction: live?.serverFraction ?? null, estimatedSeconds: live?.estimatedSeconds ?? null, title: live?.title ?? null, durationSeconds: live?.durationSeconds ?? null, serverSeconds: live?.serverSeconds ?? null, sourceSequence: event?.sequence ?? null }, study ? { ...study, nextRunAtMs: job.nextRunAtMs, observedAtMs } : undefined);
  };
  const flushEvents = async (job: Job) => {
    if (!runtime.output && !callbacks.onEvent) return;
    const events = await client.jobs.events(id, afterSequence);
    for (const event of events) {
      if (abort.signal.aborted) break;
      afterSequence = Math.max(afterSequence, event.sequence);
      if (event.type === 'state') await report(event.job, event);
      else if (event.type === 'progress') await report(job, event);
      else if (event.type === 'question') await runtime.output?.event({ type: 'question', data: { jobId: id, phaseId: event.phaseId, question: event.question, closesAtMs: event.closesAtMs, sourceSequence: event.sequence } });
      else await runtime.output?.event({ type: 'gap', data: { jobId: id, message: event.message, sourceSequence: event.sequence } });
      await callbacks.onEvent?.(event);
    }
  };
  const pause = async () => {
    runtime.output?.markCanceled();
    const job = await client.jobs.get(id);
    if (['queued', 'running', 'waiting'].includes(job.status)) await client.jobs.pause(id);
    process.exitCode = job.status === 'uncertain' ? 5 : 3;
    return observeJob(await client.jobs.get(id));
  };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    for (;;) {
      const job = observeJob(await client.jobs.get(id));
      if (abort.signal.aborted) return await pause();
      await flushEvents(job); await report(job);
      if (abort.signal.aborted) return await pause();
      if (!['queued', 'running', 'waiting'].includes(job.status)) return job;
      if (job.nextRunAtMs !== null && job.nextRunAtMs > runtime.clock.nowMs()) {
        try { await runtime.waitForWake(job.nextRunAtMs - runtime.clock.nowMs(), abort.signal); }
        catch (error) { if (!abort.signal.aborted) throw error; }
        continue;
      }
      await client.jobs.advance(id, { signal: abort.signal });
    }
  } catch (error) {
    if (error instanceof CliError && error.code === 'CANCELED' || abort.signal.aborted && (error instanceof DOMException && error.name === 'AbortError' || error instanceof LearningError && error.data.code === 'CANCELED')) return await pause();
    throw error;
  } finally {
    runtime.output?.pauseProgress();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    for (const signal of signals) signal.removeEventListener('abort', onSignal);
  }
}

/** Materialize verified, profile-owned blobs as user-readable files, without overwriting. */
export async function publishJobArtifacts(runtime: CliRuntime, job: Job, dataDir: string, outputRoot?: string): Promise<string[]> {
  if (runtime.output?.signal.aborted) return [];
  const outputDir = resolve(outputRoot ?? await getJobOutputRoot(runtime.state, job.id) ?? resolve(dataDir, 'exports'), job.id);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const item of job.items) for (const artifact of item.artifacts) {
    if (artifact.scope.profileId !== job.scope.profileId || artifact.scope.userId !== job.scope.userId || artifact.scope.platform !== job.scope.platform) {
      throw new Error('artifact scope differs from job scope');
    }
    if (!/^[^/\\]+$/.test(artifact.filename) || artifact.filename === '.' || artifact.filename === '..') throw new Error('unsafe artifact filename');
    if (runtime.output?.signal.aborted) return paths;
    const path = resolve(outputDir, artifact.filename);
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const data = await readFile(path);
      if (data.length !== artifact.bytes || createHash('sha256').update(data).digest('hex') !== artifact.sha256) throw new Error('existing export file differs from saved artifact', { cause: error });
      paths.push(path);
      continue;
    }
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const reader = (await runtime.artifacts.open(artifact.id)).getReader();
      try {
        for (;;) {
          if (runtime.output?.signal.aborted) { await reader.cancel(); throw new CliError('CANCELED', '已取消文件导出。', 3); }
          const { done, value } = await reader.read();
          if (done) break;
          let written = 0;
          while (written < value.byteLength) {
            const chunk = await handle.write(value, written, value.byteLength - written);
            if (chunk.bytesWritten <= 0) throw new Error('export file write made no progress');
            written += chunk.bytesWritten;
          }
          hash.update(value);
          bytes += value.byteLength;
        }
      } finally { reader.releaseLock(); }
      await handle.sync();
      if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new Error('saved artifact digest mismatch');
      paths.push(path);
    } catch (error) {
      await handle.close();
      await unlink(path);
      if (error instanceof CliError && error.code === 'CANCELED') return paths;
      throw error;
    }
    await handle.close();
  }
  return paths;
}
