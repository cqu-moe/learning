import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createCliRuntime } from '../src/runtime.js';

describe('foreground wake signal', () => {
  it('wakes a waiting scheduler early and cleans up an aborted wait', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-wake-'));
    const runtime = createCliRuntime(dir);
    try {
      const started = Date.now();
      const waiting = runtime.waitForWake(5000, new AbortController().signal);
      await runtime.wake();
      await waiting;
      expect(Date.now() - started).toBeLessThan(500);
      const controller = new AbortController();
      const canceled = runtime.waitForWake(5000, controller.signal);
      controller.abort();
      await expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    } finally { runtime.state.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
