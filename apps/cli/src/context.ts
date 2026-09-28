import { getOutput } from './output.js';
import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireDataDirLock, createCliRuntime, resolveDataDir } from './runtime.js';
import { createInterface } from 'node:readline/promises';
import { getProfile, listProfiles } from './profiles.js';
import type { LocalProfile } from './profiles.js';
import { LocalHeavyRenderer } from '@learning/sdk/render-node';

export type CliRuntime = ReturnType<typeof createCliRuntime>;

export async function withCliRuntime(
  program: Command,
  write: boolean,
  action: (runtime: CliRuntime, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
  if (!existsSync(resolve(dataDir, 'master.key')) || !existsSync(resolve(dataDir, 'state.db'))) {
    process.stderr.write('learning: local state is not initialized; run learning init first\n');
    process.exitCode = 3;
    return;
  }
  const lock = write ? acquireDataDirLock(dataDir, process.pid) : null;
  if (lock !== null && !lock.ok) {
    process.stderr.write(`learning: ${lock.reason}\n`);
    process.exitCode = 3;
    return;
  }
  try {
    const runtime = createCliRuntime(dataDir);
    try {
      await action(runtime, dataDir);
    } finally {
      runtime.state.close();
    }
  } finally {
    if (lock?.ok) lock.release();
  }
}

export function printResult(program: Command, value: unknown, human: string): void {
  getOutput(program).set(value, human);
}

export async function selectProfile(program: Command, runtime: CliRuntime): Promise<LocalProfile | null> {
  const attach = (profile: LocalProfile): LocalProfile => {
    runtime.heavy = new LocalHeavyRenderer({ artifacts: runtime.artifacts, scope: profile.scope });
    return profile;
  };
  const chosen = program.opts<{ profile?: string }>().profile;
  if (chosen !== undefined) {
    const profile = await getProfile(runtime.state, chosen);
    if (profile === null) {
      process.stderr.write(`learning: unknown profile ${chosen}\n`);
      process.exitCode = 2;
    }
    return profile === null ? null : attach(profile);
  }
  const profiles = await listProfiles(runtime.state);
  if (profiles.length === 0) {
    process.stderr.write('learning: no profile configured; run learning profile add first\n');
    process.exitCode = 3;
    return null;
  }
  if (profiles.length === 1) return attach(profiles[0]!);
  if (!process.stdin.isTTY) {
    process.stderr.write('learning: multiple profiles exist; pass --profile <name>\n');
    process.exitCode = 2;
    return null;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (const [index, profile] of profiles.entries()) process.stderr.write(`${index + 1}. ${profile.name} (${profile.scope.platform})\n`);
    const reply = await prompt.question('Profile number: ');
    const index = Number(reply) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= profiles.length) {
      process.stderr.write('learning: invalid profile selection\n');
      process.exitCode = 2;
      return null;
    }
    return attach(profiles[index]!);
  } finally {
    prompt.close();
  }
}
