import { z } from 'zod';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { printResult, withCliRuntime } from '../context.js';
import { getProfile } from '../profiles.js';
import { readPreferences, savePreferences } from '../preferences.js';
import { CliError, getOutput } from '../output.js';
import { createPrompts, fillMissing, confirmAction } from '../prompts.js';
import { isWizard } from '../wizard.js';
const keySchema = z.enum(['default-profile', 'download-dir']);
const fields = [{ name: 'key', message: '选择偏好', options: [{ value: 'default-profile', label: '默认账号' }, { value: 'download-dir', label: '默认下载目录' }] }, { name: 'value', message: '填写偏好值' }];
export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('管理明确保存的本地偏好');
  config.command('show').description('查看已保存的偏好').action(async () => {
    await withCliRuntime(program, false, async runtime => {
      const preferences = await readPreferences(runtime.state);
      printResult(program, preferences, `默认账号 ID：${preferences.defaultProfileId ?? '未设置'}\n下载目录：${preferences.downloadDir ?? '数据目录下的 exports'}`);
    });
  });
  const set = config.command('set [key] [value]').description('明确保存一项偏好');
  set.action(async (key?: string, value?: string) => {
    const input = await fillMissing(z.object({ key: keySchema, value: z.string().min(1) }), { ...(key === undefined ? {} : { key }), ...(value === undefined ? {} : { value }) }, fields, createPrompts(getOutput(program).mode));
    await withCliRuntime(program, true, async runtime => {
      let patch;
      if (input.key === 'default-profile') { const profile = await getProfile(runtime.state, input.value); if (!profile) throw new CliError('INVALID_INPUT', '找不到此账号。', 2, ['value']); patch = { defaultProfileId: profile.scope.profileId }; }
      else patch = { downloadDir: resolve(input.value) };
      if (isWizard(program)) await confirmAction(program, `保存 ${input.key} = ${input.value}`, false);
      const result = await savePreferences(runtime.state, patch);
      set.processedArgs = [input.key, input.key === 'download-dir' ? result.downloadDir : input.value];
      printResult(program, result, `已保存 ${input.key}。`);
    });
  });
  const unset = config.command('unset [key]').description('清除一项已保存的偏好');
  unset.action(async (key?: string) => {
    const input = await fillMissing(z.object({ key: keySchema }), key === undefined ? {} : { key }, fields, createPrompts(getOutput(program).mode));
    await withCliRuntime(program, true, async runtime => {
      if (isWizard(program)) await confirmAction(program, `清除 ${input.key}`, false);
      const result = await savePreferences(runtime.state, input.key === 'default-profile' ? { defaultProfileId: null } : { downloadDir: null });
      unset.processedArgs = [input.key];
      printResult(program, result, `已清除 ${input.key}。`);
    });
  });
}
