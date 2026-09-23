import { createCompatibleModelClient, loadOrCreateMasterKey, NodeArtifactStore, SqliteStateStore } from '@learning/sdk/node';
import type { Runtime } from '@learning/sdk/node';
import { NodeFetchTransport } from '@learning/sdk/node';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalHeavyRenderer } from '@learning/sdk/render-node';

export function resolveDataDir(explicit?: string): string {
  const base = explicit ?? process.env.LEARNING_HOME ?? resolve(process.env.HOME ?? '.', '.learning');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  return base;
}

export function createCliRuntime(dataDir: string): Runtime & { state: SqliteStateStore; waitForWake: (ms: number, signal: AbortSignal) => Promise<void> } {
  const masterKey = loadOrCreateMasterKey(dataDir);
  const clock = { nowMs: () => Date.now(), sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolveSleep(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }) };
  const wakeListeners = new Set<() => void>();
  const modelBaseUrl = process.env.LEARNING_MODEL_BASE_URL;
  const modelName = process.env.LEARNING_MODEL_NAME;
  const modelKey = process.env.LEARNING_MODEL_API_KEY;
  const model = modelBaseUrl && modelName && modelKey ? createCompatibleModelClient({ baseUrl: modelBaseUrl, model: modelName, apiKey: modelKey }) : null;
  const waitForWake = (ms: number, signal: AbortSignal) => new Promise<void>((resolveWait, reject) => {
    let finished = false;
    const cleanup = () => { if (finished) return false; finished = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); wakeListeners.delete(onWake); return true; };
    const onWake = () => { if (cleanup()) resolveWait(); };
    const onAbort = () => { if (cleanup()) reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(onWake, ms);
    wakeListeners.add(onWake);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    transport: new NodeFetchTransport(),
    state: new SqliteStateStore(resolve(dataDir, 'state.db')),
    artifacts: new NodeArtifactStore(resolve(dataDir, 'artifacts')),
    clock,
    masterKey,
    heavy: new LocalHeavyRenderer(),
    model,
    log: () => {},
    wake: async () => { for (const listener of [...wakeListeners]) listener(); },
    waitForWake,
  };
}

export function acquireDataDirLock(dataDir: string, pid: number):
  | { ok: true; release: () => void }
  | { ok: false; reason: string } {
  const lockPath = resolve(dataDir, 'learning.lock');
  const token = `${pid}\n${randomUUID()}`;
  try {
    writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readFileSync(lockPath, 'utf8').trim().split('\n')[0] ?? 'unknown';
    return { ok: false, reason: `another writer holds the lock (pid ${existing}); stop it or use profile unlock after verifying it is stale` };
  }
  return {
    ok: true,
    release: () => {
      try {
        if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}
