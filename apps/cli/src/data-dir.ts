import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { securePrivateDirectory } from './private-directory.js';

/** Locate data without creating it; homedir also supports Windows and an unset HOME. */
export function resolveDataDir(explicit?: string): string {
  return resolve(explicit ?? process.env.LEARNING_HOME ?? resolve(homedir(), '.learning'));
}

export function ensureDataDir(explicit?: string): string {
  const dataDir = resolveDataDir(explicit);
  if (process.platform === 'win32') securePrivateDirectory(dataDir);
  else {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
  }
  return dataDir;
}
