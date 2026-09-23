import { acquireDataDirLock, createCliRuntime, resolveDataDir } from '../runtime.js';
import type { Command } from 'commander';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize the local data directory and master key')
    .action(() => {
      const dataDir = resolveDataDir(program.opts<{ home?: string }>().home);
      const lock = acquireDataDirLock(dataDir, process.pid);
      if (!lock.ok) {
        process.stderr.write(`learning: ${lock.reason}\n`);
        process.exitCode = 3;
        return;
      }
      try {
        const runtime = createCliRuntime(dataDir);
        runtime.state.close();
        process.stdout.write(`initialized ${dataDir}\n`);
      } finally {
        lock.release();
      }
    });
}
