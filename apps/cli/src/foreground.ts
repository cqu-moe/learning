import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LearningClient } from '@learning/sdk';
import type { Job, JobEvent } from '@learning/sdk/public';
import type { CliRuntime } from './context.js';

export async function runJobForeground(client: LearningClient, runtime: CliRuntime, id: string, onEvent?: (event: JobEvent) => void | Promise<void>): Promise<Job> {
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  let afterSequence = 0;
  const flushEvents = async () => {
    if (onEvent === undefined) return;
    const events = await client.jobs.events(id, afterSequence);
    for (const event of events) { await onEvent(event); afterSequence = Math.max(afterSequence, event.sequence); }
  };
  process.once('SIGINT', onSignal);
  try {
    for (;;) {
      const job = await client.jobs.get(id);
      await flushEvents();
      if (abort.signal.aborted) {
        if (['queued', 'running', 'waiting'].includes(job.status)) await client.jobs.pause(id);
        process.exitCode = 3;
        return client.jobs.get(id);
      }
      if (!['queued', 'running', 'waiting'].includes(job.status)) return job;
      if (job.nextRunAtMs !== null && job.nextRunAtMs > runtime.clock.nowMs()) {
        try { await runtime.waitForWake(job.nextRunAtMs - runtime.clock.nowMs(), abort.signal); }
        catch { continue; }
        continue;
      }
      await client.jobs.advance(id);
      await flushEvents();
    }
  } finally {
    process.off('SIGINT', onSignal);
  }
}

/** Materialize verified, profile-owned blobs as user-readable files, without overwriting. */
export async function publishJobArtifacts(runtime: CliRuntime, job: Job, dataDir: string): Promise<string[]> {
  const outputDir = resolve(dataDir, 'exports', job.id);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const item of job.items) for (const artifact of item.artifacts) {
    if (artifact.scope.profileId !== job.scope.profileId || artifact.scope.userId !== job.scope.userId || artifact.scope.platform !== job.scope.platform) {
      throw new Error('artifact scope differs from job scope');
    }
    if (!/^[^/\\]+$/.test(artifact.filename) || artifact.filename === '.' || artifact.filename === '..') throw new Error('unsafe artifact filename');
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
      throw error;
    }
    await handle.close();
  }
  return paths;
}
