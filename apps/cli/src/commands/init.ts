import { acquireDataDirLock, createCliRuntime, resolveDataDir } from '../runtime.js';
import type { Command } from 'commander';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the local data directory and master key')
    .option('--home <dir>', 'LEARNING_HOME override')
    .action((options: { home?: string }) => {
      const dataDir = resolveDataDir(options.home);
      const lock = acquireDataDirLock(dataDir, process.pid);
      if (!lock.ok) {
        process.stderr.write(`learning: ${lock.reason}\n`);
        process.exitCode = 3;
        return;
      }
      createCliRuntime(dataDir);
      process.stdout.write(`initialized ${dataDir}\n`);
    });
}
