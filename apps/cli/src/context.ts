import type { LearningClient, Execution, Result } from '@learning/sdk';
import { CourseSchema, ResourceRefSchema, JobSchema, parseLearningDraft, DiscussionDraftSchema } from '@learning/sdk';
import { SqliteStateStore } from '@learning/sdk/node';
import { lstat, readFile } from 'node:fs/promises';
import { getOutput, CliError } from './output.js';
import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireDataDirLock, createCliRuntime } from './runtime.js';
import { ensureDataDir, resolveDataDir } from './data-dir.js';
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
  getOutput(program).assertActive();
  const dataDir = ensureDataDir(program.opts<{ home?: string }>().home);
  if (!existsSync(resolve(dataDir, 'master.key')) || !existsSync(resolve(dataDir, 'state.db'))) {
    throw new CliError('INTERACTION_REQUIRED', '本地尚未初始化，请运行 learning init。', 3);
  }
  getOutput(program).setHome(dataDir);
  const lock = write ? acquireDataDirLock(dataDir, process.pid) : null;
  if (lock !== null && !lock.ok) {
    throw new CliError('CONFLICT', lock.reason, 3);
  }
  try {
    const runtime: CliRuntime = Object.assign(createCliRuntime(dataDir, getOutput(program)), { output: getOutput(program) });
    runtime.log = event => { if (event.level === 'warn') getOutput(program).recordWarning(typeof event.fields.code === 'string' ? event.fields.code : 'SDK_WARNING', event.message); };
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
  scope ??= targetScopes.get(program);
  const attach = (profile: LocalProfile): LocalProfile => {
    if (scope && (profile.scope.profileId !== scope.profileId || profile.scope.platform !== scope.platform || profile.scope.userId !== scope.userId)) throw new CliError('FORBIDDEN', '目标属于另一个账号。', 3);
    if (program.opts<{ profile?: string }>().profile === undefined) program.setOptionValueWithSource('profile', profile.name, 'inferred');
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

const targetScopes = new WeakMap<Command, Scope>();
export async function inferTargetScope(program: Command, argument: string | undefined, value: unknown, discussion = false): Promise<void> {
  if (typeof value !== 'string') return;
  if (argument === 'file' || argument === 'draft') {
    if (!existsSync(value)) throw new CliError('INVALID_INPUT', `草稿文件不存在：${value}`, 2, [argument]);
    const info = await lstat(value);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new CliError('INVALID_INPUT', '草稿必须是不超过 4 MiB 的普通文件。');
    const text = await readFile(value, 'utf8');
    const scope = discussion ? DiscussionDraftSchema.parse(JSON.parse(text)).ref.resource.course.scope : parseLearningDraft(text).ref.resource.course.scope;
    targetScopes.set(program, scope);
    return;
  }
  if (!['resource','course-or-resource','course-url-or-key','jobId'].includes(argument ?? '')) return;
  const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
  if (!existsSync(resolve(dataDir, 'state.db'))) return;
  ensureDataDir(dataDir);
  const state = new SqliteStateStore(resolve(dataDir, 'state.db'));
  try {
    if (argument === 'jobId') {
      const record = await state.get(`job:${value}`);
      if (!record) throw new CliError('INVALID_INPUT', `找不到任务：${value}`, 2, ['jobId']);
      targetScopes.set(program, JobSchema.parse(record.value).scope);
    } else if (['resource','course-or-resource','course-url-or-key'].includes(argument ?? '')) {
      const resource = await state.get(`cli:resource:${value}`);
      const course = resource ? null : await state.get(`cli:course:${value}`);
      if (resource) targetScopes.set(program, ResourceRefSchema.parse(resource.value).course.scope);
      else if (course) targetScopes.set(program, CourseSchema.parse(course.value).ref.scope);
      else if (!/^https?:\/\//i.test(value)) throw new CliError('INVALID_INPUT', `找不到课程或资源 key：${value}；可先用 courses 和 outline 查询。`, 2, [argument!]);
    }
  } finally { state.close(); }
}

export async function executeAction(output: Output, client: LearningClient, previewId: string): Promise<Execution> {
  output.assertActive();
  return client.actions.execute(previewId);
}

export function unwrapResult<T>(program: Command, result: Result<T>): T {
  for (const warning of result.warnings) getOutput(program).recordWarning(warning.code, warning.message);
  return result.value;
}
