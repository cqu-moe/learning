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
import type { Platform, Scope } from '@learning/sdk/public';
import type { Output } from './output.js';
import { addProfile, getProfile, listProfiles, validName } from './profiles.js';
import type { LocalProfile } from './profiles.js';
import { LocalHeavyRenderer } from '@learning/sdk/render-node';
import { redactDiagnosticValues } from './telemetry.js';

export type CliRuntime = ReturnType<typeof createCliRuntime> & { output?: Output };

export async function withCliRuntime(
  program: Command,
  write: boolean,
  action: (runtime: CliRuntime, dataDir: string) => Promise<void>,
): Promise<void> {
  getOutput(program).assertActive();
  const dataDir = ensureDataDir(program.opts<{ home?: string }>().home);
  const hasKey = existsSync(resolve(dataDir, 'master.key'));
  const hasState = existsSync(resolve(dataDir, 'state.db'));
  const initialize = !hasKey || !hasState;
  if (initialize && !getOutput(program).mode.guided) throw new CliError('INTERACTION_REQUIRED', '本地尚未初始化，请运行 learning init。', 3);
  if (!hasKey && hasState) throw new CliError('STORAGE', '本地数据的密钥缺失，请恢复原来的 master.key 后重试。', 3);
  getOutput(program).setHome(dataDir);
  const lock = write || initialize ? acquireDataDirLock(dataDir, process.pid) : null;
  if (lock !== null && !lock.ok) {
    throw new CliError('CONFLICT', lock.reason, 3);
  }
  try {
    const runtime: CliRuntime = Object.assign(createCliRuntime(dataDir, getOutput(program)), { output: getOutput(program) });
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
    redactDiagnosticValues(getOutput(program), [profile.name, profile.scope.profileId]);
    if (scope && (profile.scope.profileId !== scope.profileId || profile.scope.platform !== scope.platform || profile.scope.userId !== scope.userId)) throw new CliError('FORBIDDEN', '目标属于另一个账号。', 3);
    if (program.opts<{ profile?: string }>().profile === undefined) program.setOptionValueWithSource('profile', profile.name, 'inferred');
    runtime.heavy = new LocalHeavyRenderer({ artifacts: runtime.artifacts, scope: profile.scope }, runtime.log);
    return profile;
  };
  const chosen = program.opts<{ profile?: string }>().profile;
  if (chosen !== undefined) redactDiagnosticValues(getOutput(program), [chosen]);
  if (chosen !== undefined) {
    const profile = await getProfile(runtime.state, chosen);
    if (!profile) throw new CliError('INVALID_INPUT', `找不到账号：${chosen}`, 2, ['profile']);
    return attach(profile);
  }
  const profiles = await listProfiles(runtime.state);
  const preferred = scope?.profileId ?? (await readPreferences(runtime.state)).defaultProfileId;
  if (getOutput(program).mode.guided && scope === undefined) {
    const prompts = createPrompts(getOutput(program).mode);
    const platforms: Record<Platform, string> = { ykt: '雨课堂', xuetang: '学堂在线', zhs: '智慧树' };
    const selected = profiles.length ? await prompts.ask({ name: 'profile', message: '选择账号', initialValue: profiles.find(profile => profile.scope.profileId === preferred)?.scope.profileId ?? profiles[0]!.scope.profileId, options: [
      ...profiles.map(profile => ({ value: profile.scope.profileId, label: `${profile.name} · ${platforms[profile.scope.platform]}` })),
      { value: '__add', label: '添加账号' },
    ] }) : '__add';
    if (selected !== '__add') {
      const profile = profiles.find(profile => profile.scope.profileId === selected);
      if (!profile) throw new CliError('INVALID_INPUT', '请选择有效账号。');
      return attach(profile);
    }
    const platform = String(await prompts.ask({ name: 'platform', message: '选择平台', options: Object.entries(platforms).map(([value, label]) => ({ value, label })) })) as Platform;
    if (!(platform in platforms)) throw new CliError('INVALID_INPUT', '请选择有效平台。');
    const name = String(await prompts.ask({ name: 'name', message: '账号名称', initialValue: platforms[platform], validate: value => typeof value !== 'string' || !validName(value) ? '请输入有效名称。' : profiles.some(profile => profile.name === value) ? '名称已存在，请换一个。' : undefined }));
    const created = await addProfile(runtime.state, name, platform);
    if (!created) throw new CliError('CONFLICT', '账号名称已存在，请重新添加。', 3);
    return attach(created);
  }
  if (!profiles.length) throw new CliError('INTERACTION_REQUIRED', '尚未配置账号，请运行 learning profile add。', 3);
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
