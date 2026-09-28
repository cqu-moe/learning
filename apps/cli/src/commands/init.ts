import { CliError } from '../output.js';
import { printResult } from '../context.js';
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
        throw new CliError('INTERACTION_REQUIRED', String(`learning: ${lock.reason}\n`).replace(/^learning: /, '').trim(), 3);
      }
      try {
        const runtime = createCliRuntime(dataDir);
        runtime.state.close();
        printResult(program, { home: dataDir, initialized: true }, `initialized ${dataDir}`);
      } finally {
        lock.release();
      }
    });
}
