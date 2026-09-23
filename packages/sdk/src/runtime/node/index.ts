// Node runtime entry (/node subpath): the only production runtime this phase.
export { SqliteStateStore } from './state.js';
export { NodeFetchTransport, NodeSocket } from './transport.js';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LearningError } from '../../types/errors.js';

const KEY_BYTES = 32;

/** Loads dataDir/master.key or creates it once with owner-only permissions (SPEC §8). */
export function loadOrCreateMasterKey(dataDir: string): Uint8Array {
  mkdirSync(dataDir, { recursive: true });
  const keyPath = resolve(dataDir, 'master.key');
  if (existsSync(keyPath)) {
    const key = new Uint8Array(readFileSync(keyPath));
    if (key.byteLength !== KEY_BYTES) {
      throw new LearningError({
        code: 'STORAGE',
        message: 'master.key must be 32 bytes',
        retryAfterMs: null,
        operationId: null,
      });
    }
    return key;
  }
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}
