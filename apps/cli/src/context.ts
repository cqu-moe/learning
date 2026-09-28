import { getOutput, CliError } from './output.js';
import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireDataDirLock, createCliRuntime, resolveDataDir } from './runtime.js';
import { createPrompts } from './prompts.js';
import { readPreferences } from './preferences.js';
import type { Scope } from '@learning/sdk/public';
import type { Output } from './output.js';
import { getProfile, listProfiles } from './profiles.js';
import type { LocalProfile } from './profiles.js';
import { LocalHeavyRenderer } from '@learning/sdk/render-node';

export type CliRuntime = ReturnType<typeof createCliRuntime> & { output?: Output };

export async function withCliRuntime(
  program: Command,
  write: boolean,
  action: (runtime: CliRuntime, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
  if (!existsSync(resolve(dataDir, 'master.key')) || !existsSync(resolve(dataDir, 'state.db'))) {
    throw new CliError('INTERACTION_REQUIRED', '本地尚未初始化，请运行 learning init。', 3);
  }
  const lock = write ? acquireDataDirLock(dataDir, process.pid) : null;
  if (lock !== null && !lock.ok) {
    throw new CliError('CONFLICT', lock.reason, 3);
  }
  try {
    const runtime: CliRuntime = Object.assign(createCliRuntime(dataDir), { output: getOutput(program) });
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

export async function selectProfile(program: Command, runtime: CliRuntime, scope?: Scope): Promise<LocalProfile> {
  const attach = (profile: LocalProfile): LocalProfile => {
    if (scope && (profile.scope.profileId !== scope.profileId || profile.scope.platform !== scope.platform || profile.scope.userId !== scope.userId)) throw new CliError('FORBIDDEN', '目标属于另一个账号。', 3);
    runtime.heavy = new LocalHeavyRenderer({ artifacts: runtime.artifacts, scope: profile.scope });
    return profile;
  };
  const chosen = program.opts<{ profile?: string }>().profile;
  if (chosen !== undefined) {
    const profile = await getProfile(runtime.state, chosen);
    if (!profile) throw new CliError('INVALID_INPUT', `找不到账号：${chosen}`, 2, ['profile']);
    return attach(profile);
  }
  const profiles = await listProfiles(runtime.state);
  if (!profiles.length) throw new CliError('INTERACTION_REQUIRED', '尚未配置账号，请运行 learning profile add。', 3);
  const preferred = scope?.profileId ?? (await readPreferences(runtime.state)).defaultProfileId;
  if (preferred !== null) {
    const profile = profiles.find(profile => profile.scope.profileId === preferred);
    if (!profile) throw new CliError('INVALID_INPUT', '目标或默认账号不可用，请明确指定 --profile 或清除默认账号。', 2, ['profile']);
    return attach(profile);
  }
  if (profiles.length === 1) return attach(profiles[0]!);
  const output = getOutput(program);
  if (!output.mode.interactive) throw new CliError('INVALID_INPUT', '存在多个账号，请传入 --profile <名称>。', 2, ['profile']);
  const name = await createPrompts(output.mode).ask({ name: 'profile', message: '选择账号', options: profiles.map(profile => ({ value: profile.name, label: `${profile.name} (${profile.scope.platform})` })) });
  return attach(profiles.find(profile => profile.name === name)!);
}
