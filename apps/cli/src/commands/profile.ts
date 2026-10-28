import { z } from 'zod';
import { CliError } from '../output.js';
import { Option, type Command } from 'commander';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDataDir } from '../data-dir.js';
import { createLearningClient, PlatformSchema } from '@learning/sdk';
import { removeLocalProfileData } from '@learning/sdk/node';
import { withCliRuntime, printResult } from '../context.js';
import { requireConfirmation } from '../input.js';
import { addProfile, getProfile, listProfiles, removeProfile, validName } from '../profiles.js';

export function registerProfileCommands(program: Command): void {
  const profile = program.command('profile').description('管理本地账号和写入锁');
  const add = profile
    .command('add <name>')
    .description('添加本地平台账号')
    .addOption(new Option('--platform <platform>', '平台：ykt、xuetang 或 zhs').choices(['ykt', 'xuetang', 'zhs']).makeOptionMandatory());
  add.action(async (name: string) => {
    const { platform } = z.object({ name: z.string().refine(validName), platform: PlatformSchema }).parse({ name, ...add.opts() });
    await withCliRuntime(program, true, async (runtime) => {
      const created = await addProfile(runtime.state, name, platform);
      if (created === null) {
        throw new CliError('INVALID_INPUT', `profile ${name} already exists`, 2);
      }
      printResult(program, created);
    });
  });

  profile
    .command('list')
    .description('列出本地账号')
    .action(async () => {
      await withCliRuntime(program, false, async (runtime) => {
        const profiles = await listProfiles(runtime.state);
        printResult(program, { profiles });
      });
    });

  const remove = profile
    .command('remove <name>')
    .description('删除本地账号及其会话、任务和缓存')
    .option('--yes', '确认删除本地账号');
  remove.action(async (name: string) => {
    requireConfirmation(program, remove.opts<{ yes?: boolean }>().yes);
    await withCliRuntime(program, true, async (runtime) => {
      const existing = await getProfile(runtime.state, name);
      if (existing === null) {
        throw new CliError('INVALID_INPUT', `unknown profile ${name}`, 2);
      }
      const client = createLearningClient({ scope: existing.scope, runtime });
      try { await client.auth.disconnect(); } finally { await client.close(); }
      await removeLocalProfileData(runtime, existing.scope);
      await removeProfile(runtime.state, name);
      printResult(program, { removed: name });
    });
  });

  profile
    .command('unlock')
    .description('核实 PID 后移除失效锁')
    .action(() => {
      const dataDir = ensureDataDir(program.opts<{ home?: string }>().home);
      const lockPath = resolve(dataDir, 'learning.lock');
      if (!existsSync(lockPath)) {
        printResult(program, { unlocked: false });
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
          throw new CliError('INTERACTION_REQUIRED', `cannot prove writer process ${pid} has exited`, 3, [], [], null, { cause: error });
        }
      }
      if (readFileSync(lockPath, 'utf8') !== original) {
        throw new CliError('INTERACTION_REQUIRED', 'writer lock changed; retry inspection', 3);
      }
      unlinkSync(lockPath);
      printResult(program, { unlocked: true });
    });
}
