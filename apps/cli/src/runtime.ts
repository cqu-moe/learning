import { loadOrCreateMasterKey, NodeArtifactStore, SqliteStateStore } from '@learning/sdk/node';
import { NodeFetchTransport } from '@learning/sdk/node';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalHeavyRenderer } from '@learning/sdk/render-node';

export function resolveDataDir(explicit?: string): string {
  const base = explicit ?? process.env.LEARNING_HOME ?? resolve(process.env.HOME ?? '.', '.learning');
  mkdirSync(base, { recursive: true });
  return base;
}

export function createCliRuntime(dataDir: string) {
  const masterKey = loadOrCreateMasterKey(dataDir);
  const clock = { nowMs: () => Date.now(), sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  }) };
  return {
    transport: new NodeFetchTransport(),
    state: new SqliteStateStore(resolve(dataDir, 'state.db')),
    artifacts: new NodeArtifactStore(resolve(dataDir, 'artifacts')),
    clock,
    masterKey,
    heavy: new LocalHeavyRenderer(),
    model: null,
    log: () => {},
    wake: async () => {},
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
