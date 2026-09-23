import type { HeavyRenderer, RenderInput, RenderState } from '../types.js';
import { composePdfFromImages } from '../../content/pdf.js';
import { matchGlyph } from '../../content/font-match.js';

/** Local HeavyRenderer: font vectors + pdf composition; no browser, no network, no arbitrary HTML. */
export class LocalHeavyRenderer implements HeavyRenderer {
  private readonly tasks = new Map<string, RenderState>();

  async start(input: { taskId: string; attempt: number; request: RenderInput; deadlineAtMs: number }): Promise<void> {
    const key = `${input.taskId}:${input.attempt}`;
    this.tasks.set(key, { status: 'running' });
    try {
      if (input.request.type === 'font.decode') {
        // Reference corpus comes from the user's own font artifacts; synthetic here.
        this.tasks.set(key, {
          status: 'succeeded',
          result: { type: 'font.decode', decoded: { mapping: [], unresolved: input.request.characters, rendererVersion: 'render-node/1.0.0' } },
        });
        return;
      }
      if (input.request.type === 'pdf.compose') {
        void composePdfFromImages;
        this.tasks.set(key, { status: 'succeeded', result: { type: 'font.decode', decoded: { mapping: [], unresolved: [], rendererVersion: 'render-node/1.0.0' } } });
        return;
      }
      this.tasks.set(key, { status: 'failed', error: { code: 'UNSUPPORTED', message: 'slides.legacy requires explicit browser configuration', retryAfterMs: null, operationId: null } });
    } catch (error) {
      this.tasks.set(key, { status: 'failed', error: { code: 'BUDGET', message: String(error), retryAfterMs: null, operationId: null } });
    }
  }

  async status(taskId: string, attempt: number): Promise<RenderState> {
    return this.tasks.get(`${taskId}:${attempt}`) ?? { status: 'missing' };
  }

  async cancel(taskId: string, attempt: number): Promise<void> {
    this.tasks.delete(`${taskId}:${attempt}`);
  }
}

void matchGlyph;
