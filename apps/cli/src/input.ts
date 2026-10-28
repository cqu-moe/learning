import type { Command } from 'commander';
import { CliError, getOutput } from './output.js';

export function requireConfirmation(program: Command, yes: boolean | undefined, dryRun = false): void {
  getOutput(program).assertActive();
  if (!yes && !dryRun) throw new CliError('CONFIRMATION_REQUIRED', '请检查 --dry-run 预览后添加 --yes。', 3, ['yes']);
}
