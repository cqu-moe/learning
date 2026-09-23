import { loadOrCreateMasterKey, SqliteStateStore } from '@learning/sdk/node';
import { NodeFetchTransport } from '@learning/sdk/node';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    artifacts: {
      create: async () => { throw new Error('artifact store wired in export flows'); },
      resume: async () => { throw new Error('artifact store wired in export flows'); },
      open: async () => { throw new Error('artifact store wired in export flows'); },
      remove: async () => {},
    },
    clock,
    masterKey,
    heavy: new LocalHeavyRenderer(),
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

export function acquireDataDirLock(dataDir: string, pid: number): { ok: boolean; reason?: string } {
  const lockPath = resolve(dataDir, 'learning.lock');
  if (existsSync(lockPath)) {
    const existing = Number(readFileSync(lockPath, 'utf8').trim());
    if (Number.isInteger(existing) && existing !== pid) {
      return { ok: false, reason: `another writer holds the lock (pid ${existing}); Ctrl+C it or run learning unlock after verifying it is stale` };
    }
  }
  writeFileSync(lockPath, String(pid));
  return { ok: true };
}
