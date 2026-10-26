import { LearningError } from '../types/errors.js';
import type { Json } from '../types/errors.js';
import type { Runtime, BlobWriter } from '../runtime/types.js';
import { decideRangeResume } from './exports.js';
import { reportError, safeEndpoint } from '../runtime/diagnostics.js';

export interface MediaAsset { status: number; headers: Headers; mimeType: string; stream: ReadableStream<Uint8Array> }
interface SavedCheckpoint { url: string; validator: string | null; bytes: number; checkpoint: Json }

function failure(message: string): LearningError {
  return new LearningError({ code: 'INTEGRITY', message, retryAfterMs: null, operationId: null });
}

function readCheckpoint(value: Json): SavedCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('download checkpoint is invalid');
  const row = value as Record<string, Json>;
  if (typeof row.url !== 'string' || (row.validator !== null && typeof row.validator !== 'string') || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.checkpoint === undefined) throw failure('download checkpoint is invalid');
  return { url: row.url, validator: row.validator, bytes: row.bytes, checkpoint: row.checkpoint };
}

function validatorOf(headers: Headers): string | null {
  return headers.get('etag') ?? headers.get('last-modified');
}

/** Resumes only when the server proves the exact expected byte range and validator. */
export async function downloadDirectMedia(input: {
  runtime: Runtime; jobId: string; resourceKey: string; artifactId: string; url: string;
  getAsset: (url: string, maxBytes: number, headers?: Record<string, string>) => Promise<MediaAsset>;
}): Promise<{ bytes: number; sha256: string }> {
  const key = `download:${input.jobId}:${input.resourceKey}`;
  const maxBytes = 4 * 1024 * 1024 * 1024;
  const current = await input.runtime.state.get(key);
  let saved = current === null ? null : readCheckpoint(current.value);
  const commit = async (value: SavedCheckpoint | null) => {
    const prior = await input.runtime.state.get(key);
    const ok = await input.runtime.state.commit({ expected: [{ key, revision: prior?.revision ?? null }], changes: [{ key, value: value as Json }] });
    if (!ok) throw failure('download checkpoint changed concurrently');
  };
  let asset: MediaAsset | null = null;
  let writer: BlobWriter | null = null;
  if (saved !== null && saved.url === input.url && saved.validator !== null) {
    asset = await input.getAsset(input.url, maxBytes - saved.bytes, { range: `bytes=${saved.bytes}-`, 'if-range': saved.validator });
    const rangeStart = /^bytes (\d+)-\d+\/\d+$/.exec(asset.headers.get('content-range') ?? '')?.[1];
    const decision = decideRangeResume({ status: asset.status, contentRangeStart: rangeStart === undefined ? -1 : Number(rangeStart), expectedOffset: saved.bytes, validatorMatches: validatorOf(asset.headers) === saved.validator });
    if (decision === 'append') {
      try { writer = await input.runtime.artifacts.resume({ id: input.artifactId, checkpoint: saved.checkpoint }); }
      catch (cause) {
        reportError(input.runtime.log, 'media.resume', cause, {
          job_id: input.jobId,
          resource_key: input.resourceKey,
          endpoint: safeEndpoint(input.url),
          recovered: true,
        });
        await asset.stream.cancel().catch(() => {});
        asset = null;
      }
    } else if (asset.status !== 200) { await asset.stream.cancel().catch(() => {}); asset = null; }
  }
  if (writer === null) {
    if (saved !== null) {
      await input.runtime.artifacts.remove(input.artifactId);
      await commit(null);
    }
    if (asset === null) asset = await input.getAsset(input.url, maxBytes);
    if (asset.status !== 200) { await asset.stream.cancel().catch(() => {}); throw failure(`fresh media request returned HTTP ${asset.status}`); }
    writer = await input.runtime.artifacts.create({ id: input.artifactId, mimeType: asset.mimeType || 'video/mp4' });
    saved = { url: input.url, validator: validatorOf(asset.headers), bytes: 0, checkpoint: await writer.checkpoint() };
    await commit(saved);
  }
  const reader = asset!.stream.getReader();
  let bytes = saved!.bytes;
  let sinceCheckpoint = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      sinceCheckpoint += value.byteLength;
      if (bytes > maxBytes) throw failure('media exceeds 4 GiB');
      await writer.write(value);
      if (sinceCheckpoint >= 8 * 1024 * 1024) {
        await commit({ url: input.url, validator: saved!.validator, bytes, checkpoint: await writer.checkpoint() });
        sinceCheckpoint = 0;
      }
    }
    const result = await writer.finish();
    await commit(null);
    return result;
  } catch (cause) {
    try { await commit({ url: input.url, validator: saved!.validator, bytes, checkpoint: await writer.checkpoint() }); }
    catch (checkpointError) {
      reportError(input.runtime.log, 'media.checkpoint', checkpointError, {
        job_id: input.jobId,
        resource_key: input.resourceKey,
        endpoint: safeEndpoint(input.url),
        recovered: true,
      });
    }
    await writer.abort().catch((cleanupError: unknown) => {
      reportError(input.runtime.log, 'media.artifact.cleanup', cleanupError, {
        job_id: input.jobId,
        resource_key: input.resourceKey,
        endpoint: safeEndpoint(input.url),
        recovered: true,
      });
    });
    throw cause;
  } finally { reader.releaseLock(); }
}
