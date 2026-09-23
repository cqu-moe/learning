import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, open as openFile, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { LearningError } from '../../types/errors.js';
import type { Json } from '../../types/errors.js';
import type { ArtifactStore, BlobWriter, Options } from '../types.js';

interface Checkpoint { id: string; bytes: number; sha256: string }

function invalid(message: string): LearningError {
  return new LearningError({ code: 'INTEGRITY', message, retryAfterMs: null, operationId: null });
}

function parseCheckpoint(value: Json, id: string): Checkpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('artifact checkpoint is invalid');
  const record = value as Record<string, Json>;
  if (record.id !== id || typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
    typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) throw invalid('artifact checkpoint does not match the partial file');
  return { id, bytes: record.bytes, sha256: record.sha256 };
}

export class NodeArtifactStore implements ArtifactStore {
  constructor(private readonly directory: string) {}

  private paths(id: string) {
    if (typeof id !== 'string' || id.length === 0) throw invalid('artifact id is empty');
    const digest = createHash('sha256').update(id).digest('hex');
    return { part: resolve(this.directory, `${digest}.part`), final: resolve(this.directory, `${digest}.blob`) };
  }

  private async ensureDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }

  async create(input: { id: string; mimeType: string }): Promise<BlobWriter> {
    void input.mimeType;
    await this.ensureDirectory();
    const paths = this.paths(input.id);
    try { await access(paths.final); throw invalid('artifact already published'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const handle = await openFile(paths.part, 'wx', 0o600);
    return this.writer(input.id, paths, handle, 0, createHash('sha256'));
  }

  async resume(input: { id: string; checkpoint: Json }): Promise<BlobWriter> {
    const checkpoint = parseCheckpoint(input.checkpoint, input.id);
    const paths = this.paths(input.id);
    const info = await stat(paths.part);
    if (info.size !== checkpoint.bytes) throw invalid('artifact partial length changed');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(paths.part)) hash.update(chunk);
    if (hash.copy().digest('hex') !== checkpoint.sha256) throw invalid('artifact partial content changed');
    const handle = await openFile(paths.part, 'r+');
    if ((await handle.stat()).size !== checkpoint.bytes) {
      await handle.close();
      throw invalid('artifact partial changed during resume');
    }
    return this.writer(input.id, paths, handle, checkpoint.bytes, hash);
  }

  private writer(id: string, paths: { part: string; final: string }, handle: FileHandle, initialBytes: number, hash: ReturnType<typeof createHash>): BlobWriter {
    let bytes = initialBytes;
    let closed = false;
    const ensureOpen = () => { if (closed) throw invalid('artifact writer is closed'); };
    return {
      write: async (chunk) => {
        ensureOpen();
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset, bytes + offset);
          if (result.bytesWritten <= 0) throw invalid('artifact write made no progress');
          offset += result.bytesWritten;
        }
        hash.update(chunk);
        bytes += chunk.byteLength;
      },
      checkpoint: async (): Promise<Json> => {
        ensureOpen();
        await handle.sync();
        return { id, bytes, sha256: hash.copy().digest('hex') };
      },
      finish: async () => {
        ensureOpen();
        await handle.sync();
        await handle.close();
        closed = true;
        await link(paths.part, paths.final); // exclusive, atomic publication; never replaces an existing artifact
        await unlink(paths.part);
        return { bytes, sha256: hash.digest('hex') };
      },
      abort: async () => {
        if (!closed) { closed = true; await handle.close(); }
      },
    };
  }

  async open(id: string, options?: Options): Promise<ReadableStream<Uint8Array>> {
    const paths = this.paths(id);
    await access(paths.final);
    const stream = createReadStream(paths.final);
    if (options?.signal) {
      if (options.signal.aborted) stream.destroy(new DOMException('Aborted', 'AbortError'));
      else options.signal.addEventListener('abort', () => stream.destroy(new DOMException('Aborted', 'AbortError')), { once: true });
    }
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  async remove(id: string): Promise<void> {
    const paths = this.paths(id);
    for (const path of [paths.part, paths.final]) {
      try { await unlink(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
