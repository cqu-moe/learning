import YAML from 'yaml';
import { LearningError } from '../types/errors.js';
import { ExportInputSchema } from '../types/models.js';
import type { Assessment, ItemResult, Job, SlideDeck, MediaInfo, Transcript } from '../types/models.js';
import type { AssessmentRef, LessonRef, ResourceRef, Scope } from '../types/refs.js';
import type { Runtime } from '../runtime/types.js';
import { safeFilename } from './exports.js';
import type { JobRunner } from './jobs.js';
import { advanceMedia } from './media-export.js';

function serialize(assessment: Assessment, format: 'json' | 'yaml' | 'markdown'): string {
  if (format === 'json') return JSON.stringify(assessment, null, 2) + '\n';
  if (format === 'yaml') return YAML.stringify(assessment);
  return `# ${assessment.ref.assessmentId}\n\n\`\`\`json\n${JSON.stringify(assessment, null, 2)}\n\`\`\`\n`;
}

/** One read-only assessment per slice. The input is persisted with the job. */
export async function advanceExport(input: {
  runner: JobRunner;
  runtime: Runtime;
  job: Job;
  scope: Scope;
  getAssessment: (ref: AssessmentRef) => Promise<Assessment>;
  getSlides: (ref: LessonRef) => Promise<SlideDeck[]>;
  getSlideImage: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  getMedia: (ref: ResourceRef) => Promise<MediaInfo>;
  getTranscript: (ref: ResourceRef) => Promise<Transcript>;
  getAsset: (url: string, maxBytes: number) => Promise<{ mimeType: string; stream: ReadableStream<Uint8Array> }>;
}): Promise<Job> {
  const saved = ExportInputSchema.parse(await input.runner.input(input.job.id));
  if (saved.type === 'slides') return advanceSlides(input, saved);
  if (saved.type === 'media') return advanceMedia(input, saved);
  const keyOf = (ref: AssessmentRef) => `${ref.resource.key}:${ref.assessmentId}`;
  const next = saved.refs.find((ref) => !input.job.items.some((item) => item.key === keyOf(ref)));
  if (next === undefined) return input.runner.advance(input.job.id, async () => ({ completed: true }));
  return input.runner.advance(input.job.id, async () => {
    const assessment = await input.getAssessment(next);
    const content = serialize(assessment, saved.format);
    const artifactId = `${input.job.id}:${keyOf(next)}`;
    const mimeType = saved.format === 'json' ? 'application/json' : saved.format === 'yaml' ? 'application/yaml' : 'text/markdown';
    const writer = await input.runtime.artifacts.create({ id: artifactId, mimeType });
    let result: { bytes: number; sha256: string };
    try {
      await writer.write(new TextEncoder().encode(content));
      result = await writer.finish();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    const item: ItemResult = {
      key: keyOf(next),
      state: 'succeeded',
      message: null,
      artifacts: [{
        id: artifactId,
        scope: input.scope,
        filename: `${safeFilename(next.assessmentId)}-${safeFilename(next.resource.key).slice(0, 12)}.${saved.format === 'markdown' ? 'md' : saved.format === 'yaml' ? 'yaml' : 'json'}`,
        mimeType,
        bytes: result.bytes,
        sha256: result.sha256,
        createdAtMs: input.runtime.clock.nowMs(),
      }],
    };
    const items = [...input.job.items, item];
    return { completed: items.length === saved.refs.length, items };
  });
}

async function advanceSlides(input: {
  runner: JobRunner; runtime: Runtime; job: Job; scope: Scope;
  getSlides: (ref: LessonRef) => Promise<SlideDeck[]>;
  getSlideImage: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}, saved: Extract<ReturnType<typeof ExportInputSchema.parse>, { type: 'slides' }>): Promise<Job> {
  const next = saved.lessons.find((lesson) => !input.job.items.some((item) => item.key === lesson.lessonId));
  if (next === undefined) return input.runner.advance(input.job.id, async () => ({ completed: true }));
  return input.runner.advance(input.job.id, async () => {
    const decks = await input.getSlides(next);
    const pages = decks.flatMap((deck) => deck.pages.map((page) => ({ deck, page })));
    if (pages.length === 0) {
      const items: ItemResult[] = [...input.job.items, { key: next.lessonId, state: 'failed', message: 'no historical slide pages', artifacts: [] }];
      return { completed: items.length === saved.lessons.length, items };
    }
    if (pages.length > 500) throw new LearningError({ code: 'BUDGET', message: 'slide PDF exceeds 500 pages', retryAfterMs: null, operationId: input.job.id });
    const temporary: string[] = [];
    const artifacts: ItemResult['artifacts'] = [];
    try {
      for (const { deck, page } of pages) {
        const asset = await input.getSlideImage(page.assetId);
        if (asset.mimeType !== 'image/png') throw new LearningError({ code: 'UNSUPPORTED', message: 'slide image is not PNG', retryAfterMs: null, operationId: input.job.id });
        const id = `${input.job.id}:${next.lessonId}:${deck.presentationId}:${page.index}`;
        const writer = await input.runtime.artifacts.create({ id, mimeType: asset.mimeType });
        let result: { bytes: number; sha256: string };
        try { await writer.write(asset.bytes); result = await writer.finish(); }
        catch (error) { await writer.abort(); throw error; }
        const artifact = { id, scope: input.scope,
          filename: `${safeFilename(next.lessonId)}-${safeFilename(deck.presentationId)}-${page.index}.png`,
          mimeType: asset.mimeType, bytes: result.bytes, sha256: result.sha256, createdAtMs: input.runtime.clock.nowMs() };
        if (saved.format === 'images') artifacts.push(artifact);
        else temporary.push(id);
      }
      if (saved.format === 'pdf') {
        if (input.runtime.heavy === null) throw new LearningError({ code: 'MISSING_RUNTIME', message: 'local PDF renderer is not configured', retryAfterMs: null, operationId: input.job.id });
        const taskId = `${input.job.id}:${next.lessonId}`;
        await input.runtime.heavy.start({ taskId, attempt: 1,
          request: { type: 'pdf.compose', imageArtifactIds: temporary, title: `slides-${next.lessonId}` },
          deadlineAtMs: input.runtime.clock.nowMs() + 600_000 });
        const state = await input.runtime.heavy.status(taskId, 1);
        if (state.status !== 'succeeded' || state.result.type !== 'pdf.compose') {
          throw new LearningError(state.status === 'failed' ? state.error : { code: 'INTEGRITY', message: 'PDF render result unavailable', retryAfterMs: null, operationId: input.job.id });
        }
        artifacts.push(state.result.artifact);
      }
      const items: ItemResult[] = [...input.job.items, { key: next.lessonId, state: 'succeeded', message: null, artifacts }];
      return { completed: items.length === saved.lessons.length, items };
    } finally {
      if (saved.format === 'pdf') for (const id of temporary) await input.runtime.artifacts.remove(id);
    }
  });
}
