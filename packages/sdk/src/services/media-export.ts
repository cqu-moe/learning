import { LearningError } from '../types/errors.js';
import type { ItemResult, Job, MediaInfo, Transcript, ExportInput } from '../types/models.js';
import type { ResourceRef, Scope } from '../types/refs.js';
import type { Runtime } from '../runtime/types.js';
import type { Json } from '../types/errors.js';
import type { JobRunner } from './jobs.js';
import { safeFilename } from './exports.js';
import { downloadDirectMedia } from './direct-media.js';
import type { MediaAsset } from './direct-media.js';
import { sha256Hex } from '../types/sha256.js';

type MediaInput = Extract<ExportInput, { type: 'media' }>;
type Asset = MediaAsset;

function error(code: 'BUDGET' | 'PROTOCOL' | 'UNSUPPORTED', message: string, id: string): LearningError {
  return new LearningError({ code, message, retryAfterMs: null, operationId: id });
}

async function playlistText(asset: Asset, id: string): Promise<string> {
  const reader = asset.stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw error('BUDGET', 'HLS playlist exceeds 1 MiB', id);
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(out);
}

function parsePlaylist(text: string, base: string, id: string): { nested: string | null; segments: string[]; extension: 'ts' | 'mp4' } {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw error('PROTOCOL', 'invalid HLS playlist', id);
  if (lines.some((line) => /^#EXT-X-(?:KEY|SESSION-KEY|BYTERANGE)/.test(line))) throw error('UNSUPPORTED', 'encrypted or byte-range HLS is not supported', id);
  const masterIndex = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'));
  if (masterIndex >= 0) {
    const entry = lines.slice(masterIndex + 1).find((line) => !line.startsWith('#'));
    if (entry === undefined) throw error('PROTOCOL', 'HLS master has no media playlist', id);
    return { nested: new URL(entry, base).toString(), segments: [], extension: 'ts' };
  }
  const mapLine = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
  const map = mapLine === undefined ? null : /URI="([^"]+)"/.exec(mapLine)?.[1] ?? null;
  if (mapLine !== undefined && map === null) throw error('PROTOCOL', 'HLS init segment URI missing', id);
  const segments = lines.filter((line) => !line.startsWith('#')).map((line) => new URL(line, base).toString());
  if (map !== null) segments.unshift(new URL(map, base).toString());
  if (segments.length === 0 || segments.length > 20_000) throw error('BUDGET', 'HLS segment count is invalid', id);
  return { nested: null, segments, extension: map === null ? 'ts' : 'mp4' };
}

interface HlsCheckpoint { digest: string; nextIndex: number; bytes: number; checkpoint: Json }

function parseHlsCheckpoint(value: Json): HlsCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw error('PROTOCOL', 'HLS checkpoint is invalid', 'hls');
  const row = value as Record<string, Json>;
  if (typeof row.digest !== 'string' || typeof row.nextIndex !== 'number' || !Number.isSafeInteger(row.nextIndex) || row.nextIndex < 0 ||
    typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.checkpoint === undefined) throw error('PROTOCOL', 'HLS checkpoint is invalid', 'hls');
  return { digest: row.digest, nextIndex: row.nextIndex, bytes: row.bytes, checkpoint: row.checkpoint };
}

async function downloadHls(input: { runtime: Runtime; jobId: string; resourceKey: string; artifactId: string; mimeType: string; urls: string[]; extension: 'ts' | 'mp4'; getAsset: (url: string, maxBytes: number, headers?: Record<string, string>) => Promise<Asset> }): Promise<{ bytes: number; sha256: string }> {
  const key = `hls:${input.jobId}:${input.resourceKey}`;
  const digest = sha256Hex(JSON.stringify([input.urls, input.extension]));
  const commit = async (value: HlsCheckpoint | null) => {
    const prior = await input.runtime.state.get(key);
    const ok = await input.runtime.state.commit({ expected: [{ key, revision: prior?.revision ?? null }], changes: [{ key, value: value as Json }] });
    if (!ok) throw error('PROTOCOL', 'HLS checkpoint changed concurrently', input.jobId);
  };
  const record = await input.runtime.state.get(key);
  const saved = record === null ? null : parseHlsCheckpoint(record.value);
  let writer;
  let nextIndex = 0;
  let total = 0;
  if (saved !== null && saved.digest === digest && saved.nextIndex <= input.urls.length) {
    try {
      writer = await input.runtime.artifacts.resume({ id: input.artifactId, checkpoint: saved.checkpoint, truncateUncommitted: true });
      nextIndex = saved.nextIndex;
      total = saved.bytes;
    } catch { /* corrupted or unavailable partial must restart from the first segment */ }
  }
  if (writer === undefined) {
    await input.runtime.artifacts.remove(input.artifactId);
    if (saved !== null) await commit(null);
    writer = await input.runtime.artifacts.create({ id: input.artifactId, mimeType: input.mimeType });
    await commit({ digest, nextIndex: 0, bytes: 0, checkpoint: await writer.checkpoint() });
  }
  try {
    for (let index = nextIndex; index < input.urls.length; index += 1) {
      const asset = await input.getAsset(input.urls[index]!, 64 * 1024 * 1024);
      if (asset.status !== 200) { await asset.stream.cancel().catch(() => {}); throw error('PROTOCOL', `HLS segment returned HTTP ${asset.status}`, input.jobId); }
      const reader = asset.stream.getReader();
      let segmentBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          segmentBytes += value.byteLength;
          total += value.byteLength;
          if (segmentBytes > 64 * 1024 * 1024 || total > 4 * 1024 * 1024 * 1024) throw error('BUDGET', 'HLS media exceeds size limit', input.jobId);
          await writer.write(value);
        }
      } finally { reader.releaseLock(); }
      await commit({ digest, nextIndex: index + 1, bytes: total, checkpoint: await writer.checkpoint() });
    }
    const result = await writer.finish();
    await commit(null);
    return result;
  } catch (cause) { await writer.abort(); throw cause; }
}

export async function advanceMedia(input: {
  runner: JobRunner; runtime: Runtime; job: Job; scope: Scope;
  getMedia: (ref: ResourceRef) => Promise<MediaInfo>;
  getTranscript: (ref: ResourceRef) => Promise<Transcript>;
  getAsset: (url: string, maxBytes: number, headers?: Record<string, string>) => Promise<Asset>;
}, saved: MediaInput): Promise<Job> {
  const next = saved.resources.find((ref) => !input.job.items.some((item) => item.key === ref.key));
  if (next === undefined) return input.runner.advance(input.job.id, async () => ({ completed: true }));
  return input.runner.advance(input.job.id, async () => {
    const media = await input.getMedia(next);
    const variant = saved.quality === 'best' ? media.variants.find((item) => item.quality === 'hd') ?? media.variants[0]
      : media.variants.find((item) => item.quality === saved.quality);
    if (variant === undefined) throw error('UNSUPPORTED', 'requested media quality is unavailable', input.job.id);
    const isHls = variant.mimeType === 'application/vnd.apple.mpegurl' || /\.m3u8(?:\?|$)/i.test(variant.id);
    let urls = [variant.id];
    let extension: 'mp4' | 'ts' = 'mp4';
    if (isHls) {
      let playlistUrl = variant.id;
      let resolved = false;
      for (let depth = 0; depth < 2; depth += 1) {
        const parsed = parsePlaylist(await playlistText(await input.getAsset(playlistUrl, 1024 * 1024), input.job.id), playlistUrl, input.job.id);
        if (parsed.nested !== null) { playlistUrl = parsed.nested; continue; }
        urls = parsed.segments;
        extension = parsed.extension;
        resolved = true;
        break;
      }
      if (!resolved) throw error('UNSUPPORTED', 'nested HLS master depth exceeded', input.job.id);
    }
    const artifactId = `${input.job.id}:${next.key}:media`;
    const mimeType = extension === 'ts' ? 'video/mp2t' : 'video/mp4';
    let result: { bytes: number; sha256: string };
    if (!isHls) result = await downloadDirectMedia({ runtime: input.runtime, jobId: input.job.id, resourceKey: next.key, artifactId, url: variant.id, getAsset: input.getAsset });
    else result = await downloadHls({ runtime: input.runtime, jobId: input.job.id, resourceKey: next.key, artifactId, mimeType, urls, extension, getAsset: input.getAsset });
    const artifacts: ItemResult['artifacts'] = [{ id: artifactId, scope: input.scope,
      filename: `${safeFilename(next.key)}.${extension}`, mimeType, bytes: result.bytes, sha256: result.sha256,
      createdAtMs: input.runtime.clock.nowMs() }];
    let transcriptWarning: string | null = null;
    if (saved.subtitles) {
      try {
        const transcript = await input.getTranscript(next);
        if (transcript.state === 'available') {
          const id = `${input.job.id}:${next.key}:transcript`;
          const writer = await input.runtime.artifacts.create({ id, mimeType: 'application/json' });
          try {
            await writer.write(new TextEncoder().encode(JSON.stringify(transcript, null, 2) + '\n'));
            const result = await writer.finish();
            artifacts.push({ id, scope: input.scope, filename: `${safeFilename(next.key)}.transcript.json`, mimeType: 'application/json', bytes: result.bytes, sha256: result.sha256, createdAtMs: input.runtime.clock.nowMs() });
          } catch (cause) { await writer.abort(); await input.runtime.artifacts.remove(id); throw cause; }
        }
      } catch {
        transcriptWarning = 'transcript unavailable; video kept';
        input.runtime.log({ level: 'warn', message: transcriptWarning, fields: { resourceKey: next.key } });
      }
    }
    const items: ItemResult[] = [...input.job.items, { key: next.key, state: 'succeeded', message: transcriptWarning, artifacts }];
    return { completed: items.length === saved.resources.length, items };
  });
}
