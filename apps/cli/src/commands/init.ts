import { CliError } from '../output.js';
import { printResult } from '../context.js';
import { acquireDataDirLock, createCliRuntime, resolveDataDir } from '../runtime.js';
import type { Command } from 'commander';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('初始化本地数据目录和密钥')
    .action(() => {
      const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
      const lock = acquireDataDirLock(dataDir, process.pid);
      if (!lock.ok) {
        throw new CliError('INTERACTION_REQUIRED', `${lock.reason}`, 3);
      }
      try {
        const runtime = createCliRuntime(dataDir);
        runtime.state.close();
        printResult(program, { home: dataDir, initialized: true }, `已初始化：${dataDir}`);
      } finally {
        lock.release();
      }
    });
}
