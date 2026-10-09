import { readPreferences, savePreferences } from '../preferences.js';
import { z } from 'zod';
import { createPrompts, fillMissing, confirmAction } from '../prompts.js';
import { getOutput, CliError, formatTable } from '../output.js';
import type { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDataDir } from '../runtime.js';
import { CourseSchema, ResourceRefSchema, createLearningClient, JobSchema, PlatformSchema } from '@learning/sdk';
import { withCliRuntime, printResult } from '../context.js';
import { addProfile, getProfile, listProfiles, removeProfile, validName } from '../profiles.js';

export function registerProfileCommands(program: Command): void {
  const profile = program.command('profile').description('管理本地账号和写入锁');
  const add = profile
    .command('add [name]')
    .description('添加本地平台账号')
    .option('--platform <platform>', '平台：ykt、xuetang、zhs 或 chaoxing');
  add.action(async (inputName?: string) => {
    const { name, platform } = await fillMissing(z.object({ name: z.string().refine(validName), platform: PlatformSchema }), { ...(inputName === undefined ? {} : { name: inputName }), ...add.opts() }, [
      { name: 'name', message: '账号名称' },
      { name: 'platform', message: '选择平台', options: [{ value: 'ykt', label: '雨课堂' }, { value: 'xuetang', label: '学堂在线' }, { value: 'zhs', label: '智慧树' }, { value: 'chaoxing', label: '超星学习通' }] },
    ], createPrompts(getOutput(program).mode));
    add.processedArgs[0] = name;
    add.setOptionValueWithSource('platform', platform, add.getOptionValueSource('platform') ?? 'prompt');
    await withCliRuntime(program, true, async (runtime) => {
      const created = await addProfile(runtime.state, name, platform);
      if (created === null) {
        throw new CliError('INVALID_INPUT', `profile ${name} already exists`, 2);
      }
      printResult(program, created, `added ${created.name} (${created.scope.platform})`);
    });
  });

  profile
    .command('list')
    .description('列出本地账号')
    .action(async () => {
      await withCliRuntime(program, false, async (runtime) => {
        const profiles = await listProfiles(runtime.state);
        printResult(program, { profiles }, formatTable(['账号', '平台', 'ID'], profiles.map(item => [item.name, item.scope.platform, item.scope.profileId])));
      });
    });

  const remove = profile
    .command('remove [name]')
    .description('删除本地账号及其会话、任务和缓存')
    .option('--yes', '确认删除本地账号');
  remove.action(async (inputName?: string) => {
    if (inputName === undefined && !getOutput(program).mode.interactive) throw new CliError('INVALID_INPUT', '请指定要删除的账号。', 2, ['name']);
    await withCliRuntime(program, true, async (runtime) => {
      const name = inputName ?? String(await createPrompts(getOutput(program).mode).ask({ name: 'name', message: '选择要删除的账号', options: (await listProfiles(runtime.state)).map(item => ({ value: item.name, label: `${item.name} (${item.scope.platform})` })) }));
      remove.processedArgs[0] = name;
      const existing = await getProfile(runtime.state, name);
      if (existing === null) {
        throw new CliError('INVALID_INPUT', `unknown profile ${name}`, 2);
      }
      await confirmAction(program, `删除账号 ${name}，清除其会话、任务和缓存；已发生的平台操作不会回滚。`, remove.opts<{ yes?: boolean }>().yes);
      const client = createLearningClient({ scope: existing.scope, runtime });
      try { await client.auth.disconnect(); } finally { await client.close(); }
      const deletions = new Map<string, number>();
      const artifactIds = new Set<string>();
      const queue = async (key: string) => {
        const record = await runtime.state.get(key);
        if (record !== null) deletions.set(key, record.revision);
      };
      const all = async (prefix: string) => {
        const rows: Array<{ key: string; record: { revision: number; value: unknown } }> = [];
        let cursor: string | null = null;
        do {
          const page: Awaited<ReturnType<typeof runtime.state.list>> = await runtime.state.list(prefix, cursor, 100);
          rows.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== null);
        return rows;
      };
      for (const row of await all('job:')) {
        const job = JobSchema.parse(row.record.value);
        if (job.scope.profileId !== existing.scope.profileId) continue;
        deletions.set(row.key, row.record.revision);
        for (const suffix of ['job-meta:', 'job-input:', 'job-events:', 'cli:job-output:']) await queue(`${suffix}${job.id}`);
        for (const item of job.items) for (const artifact of item.artifacts) artifactIds.add(artifact.id);
      }
      for (const row of await all('cli:course:')) {
        const course = CourseSchema.parse(row.record.value);
        if (course.ref.scope.profileId === existing.scope.profileId) deletions.set(row.key, row.record.revision);
      }
      for (const row of await all('cli:resource:')) {
        const resource = ResourceRefSchema.parse(row.record.value);
        if (resource.course.scope.profileId !== existing.scope.profileId) continue;
        deletions.set(row.key, row.record.revision);
        await queue(`cli:resource-kind:${resource.key}`);
      }
      for (const row of await all('preview:')) {
        const value = row.record.value;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        const operation = value as Record<string, unknown>;
        const preview = operation.preview;
        if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) continue;
        const scope = (preview as Record<string, unknown>).scope;
        if (scope === null || typeof scope !== 'object' || Array.isArray(scope) || (scope as Record<string, unknown>).profileId !== existing.scope.profileId) continue;
        deletions.set(row.key, row.record.revision);
        if (typeof operation.operationId === 'string') await queue(`operation:${operation.operationId}`);
      }
      if (deletions.size > 0) {
        const ok = await runtime.state.commit({
          expected: [...deletions].map(([key, revision]) => ({ key, revision })),
          changes: [...deletions.keys()].map((key) => ({ key, value: null })),
        });
        if (!ok) throw new Error('profile records changed while removing them');
      }
      for (const id of artifactIds) await runtime.artifacts.remove(id);
      if ((await readPreferences(runtime.state)).defaultProfileId === existing.scope.profileId) await savePreferences(runtime.state, { defaultProfileId: null });
      await removeProfile(runtime.state, name);
      printResult(program, { removed: name }, `removed ${name}`);
    });
  });

  profile
    .command('unlock')
    .description('核实 PID 后移除失效锁')
    .action(() => {
      const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
      const lockPath = resolve(dataDir, 'learning.lock');
      if (!existsSync(lockPath)) {
        printResult(program, { unlocked: false }, '当前没有写入锁。');
        return;
      }
      const original = readFileSync(lockPath, 'utf8');
      const pidText = original.trim().split('\n')[0];
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new CliError('INTERACTION_REQUIRED', 'invalid writer lock; inspect it manually', 3);
      }
      try {
        process.kill(pid, 0);
        throw new CliError('INTERACTION_REQUIRED', `writer process ${pid} is still running`, 3);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new CliError('INTERACTION_REQUIRED', `cannot prove writer process ${pid} has exited`, 3);
        }
      }
      if (readFileSync(lockPath, 'utf8') !== original) {
        throw new CliError('INTERACTION_REQUIRED', 'writer lock changed; retry inspection', 3);
      }
      unlinkSync(lockPath);
      printResult(program, { unlocked: true }, '已移除确认失效的写入锁。');
    });
}
