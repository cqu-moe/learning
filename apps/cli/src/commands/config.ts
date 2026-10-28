import { z } from 'zod';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { printResult, withCliRuntime } from '../context.js';
import { getProfile } from '../profiles.js';
import { readPreferences, savePreferences } from '../preferences.js';
import { CliError } from '../output.js';
const keySchema = z.enum(['default-profile', 'download-dir']);
export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('管理明确保存的本地偏好');
  config.command('show').description('查看已保存的偏好').action(async () => {
    await withCliRuntime(program, false, async runtime => {
      const preferences = await readPreferences(runtime.state);
      printResult(program, preferences);
    });
  });
  const set = config.command('set <key> <value>').description('明确保存一项偏好');
  set.action(async (key: string, value: string) => {
    const input = z.object({ key: keySchema, value: z.string().min(1) }).parse({ key, value });
    await withCliRuntime(program, true, async runtime => {
      let patch;
      if (input.key === 'default-profile') { const profile = await getProfile(runtime.state, input.value); if (!profile) throw new CliError('INVALID_INPUT', '找不到此账号。', 2, ['value']); patch = { defaultProfileId: profile.scope.profileId }; }
      else patch = { downloadDir: resolve(input.value) };
      const result = await savePreferences(runtime.state, patch);
      printResult(program, result);
    });
  });
  const unset = config.command('unset <key>').description('清除一项已保存的偏好');
  unset.action(async (key: string) => {
    const input = z.object({ key: keySchema }).parse({ key });
    await withCliRuntime(program, true, async runtime => {
      const result = await savePreferences(runtime.state, input.key === 'default-profile' ? { defaultProfileId: null } : { downloadDir: null });
      printResult(program, result);
    });
  });
}
