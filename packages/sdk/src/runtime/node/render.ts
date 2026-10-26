import type { HeavyRenderer, ArtifactStore, Options } from '../types.js';
import type { RenderInput, RenderState } from '../../types/models.js';
import type { Scope } from '../../types/refs.js';
import { LearningError } from '../../types/errors.js';
import { composePdfFromImages } from '../../content/pdf.js';
import { safeFilename } from '../../services/exports.js';
import { isCancellation, reportError } from '../diagnostics.js';
import type { DiagnosticLog } from '../diagnostics.js';

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_PAGE_PIXELS = 40_000_000;
const MAX_PAGES = 500;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface Task { digest: string; state: RenderState; canceled: boolean; controller: AbortController; artifactId: string | null }

function problem(code: 'BUDGET' | 'INTEGRITY' | 'CANCELED' | 'CONFLICT' | 'MISSING_RUNTIME', message: string): LearningError {
  return new LearningError({ code, message, retryAfterMs: null, operationId: null });
}

async function readBounded(
  store: ArtifactStore,
  id: string,
  remaining: number,
  signal: AbortSignal,
  attempt: number,
  log: DiagnosticLog | undefined,
): Promise<Uint8Array> {
  const reader = (await store.open(id, { signal })).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw problem('CANCELED', 'render canceled');
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > remaining) throw problem('BUDGET', 'PDF input exceeds 256 MiB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch((cleanup: unknown) => {
      reportError(log, 'render.read.cleanup', cleanup, { attempt_id: attempt });
    });
  }
  return Buffer.concat(chunks, length);
}

function checkPng(image: Uint8Array): void {
  const bytes = Buffer.from(image);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw problem('INTEGRITY', 'PDF input is not a PNG image');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > MAX_PAGE_PIXELS) throw problem('BUDGET', 'PDF page exceeds 40 million pixels');
}

/** Bounded, local PDF renderer. Font and legacy browser paths fail explicitly until inputs exist. */
export class LocalHeavyRenderer implements HeavyRenderer {
  private readonly tasks = new Map<string, Task>();
  constructor(
    private readonly deps?: { artifacts: ArtifactStore; scope: Scope },
    private readonly log?: DiagnosticLog,
  ) {}

  async start(input: { taskId: string; attempt: number; request: RenderInput; deadlineAtMs: number }, options?: Options): Promise<void> {
    const key = `${input.taskId}:${input.attempt}`;
    const digest = JSON.stringify(input.request);
    const existing = this.tasks.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) throw problem('CONFLICT', 'render task input changed for the same attempt');
      return;
    }
    const task: Task = { digest, state: { status: 'running' }, canceled: false, controller: new AbortController(), artifactId: null };
    this.tasks.set(key, task);
    const onAbort = () => task.controller.abort();
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (input.deadlineAtMs <= Date.now()) throw problem('BUDGET', 'render deadline passed');
      if (input.request.type === 'font.decode') throw problem('MISSING_RUNTIME', 'reference font corpus and Canvas renderer are not configured');
      if (input.request.type === 'slides.legacy') throw problem('MISSING_RUNTIME', 'controlled legacy slide browser is not configured');
      if (this.deps === undefined) throw problem('MISSING_RUNTIME', 'PDF artifact store and profile scope are not configured');
      const ids = input.request.imageArtifactIds;
      if (ids.length === 0 || ids.length > MAX_PAGES) throw problem('BUDGET', 'PDF page count must be between 1 and 500');
      const images: Uint8Array[] = [];
      let total = 0;
      for (const id of ids) {
        const image = await readBounded(this.deps.artifacts, id, MAX_INPUT_BYTES - total, task.controller.signal, input.attempt, this.log);
        checkPng(image);
        total += image.byteLength;
        images.push(image);
        if (Date.now() >= input.deadlineAtMs) throw problem('BUDGET', 'render deadline passed');
      }
      if (task.canceled || task.controller.signal.aborted) throw problem('CANCELED', 'render canceled');
      const composed = await composePdfFromImages(images, input.request.title);
      if (Date.now() >= input.deadlineAtMs) throw problem('BUDGET', 'render deadline passed');
      const artifactId = `render:${input.taskId}:${input.attempt}:pdf`;
      task.artifactId = artifactId;
      const writer = await this.deps.artifacts.create({ id: artifactId, mimeType: 'application/pdf' });
      let written: { bytes: number; sha256: string };
      try {
        await writer.write(composed.pdfBytes);
        if (task.canceled || task.controller.signal.aborted) throw problem('CANCELED', 'render canceled');
        written = await writer.finish();
      } catch (error) {
        if (!isCancellation(error, task.controller.signal)) reportError(this.log, 'render.write', error, { attempt_id: input.attempt });
        await writer.abort();
        throw error;
      }
      if (task.canceled || task.controller.signal.aborted) { await this.deps.artifacts.remove(artifactId); return; }
      task.state = { status: 'succeeded', result: { type: 'pdf.compose', artifact: {
        id: artifactId,
        scope: this.deps.scope,
        filename: `${safeFilename(input.request.title) || 'document'}.pdf`,
        mimeType: 'application/pdf', bytes: written.bytes, sha256: written.sha256, createdAtMs: Date.now(),
      } } };
    } catch (error) {
      if (!isCancellation(error, task.controller.signal)) {
        reportError(this.log, `render.task.${input.request.type}`, error, {
          attempt_id: input.attempt,
        });
      }
      if (!task.canceled) task.state = { status: 'failed', error: error instanceof LearningError ? error.data : {
        code: 'INTEGRITY', message: error instanceof Error ? error.message : 'render failed', retryAfterMs: null, operationId: null,
      } };
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  async status(taskId: string, attempt: number): Promise<RenderState> {
    return this.tasks.get(`${taskId}:${attempt}`)?.state ?? { status: 'missing' };
  }

  async cancel(taskId: string, attempt: number): Promise<void> {
    const key = `${taskId}:${attempt}`;
    const task = this.tasks.get(key);
    if (task === undefined) return;
    task.canceled = true;
    task.controller.abort();
    this.tasks.delete(key);
    if (task.artifactId !== null && this.deps !== undefined) await this.deps.artifacts.remove(task.artifactId);
  }
}
