import type { Command } from 'commander';
import { createLearningClient } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';

export function registerOperationsCommands(program: Command): void {
  const operations = program.command('operations').description('核对保存的不确定写入');
  operations.command('reconcile <operationId>')
    .description('只读核对操作结果，不重复发送')
    .action(async (operationId: string) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
          const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const receipt = await client.actions.reconcile(operationId);
          if (receipt.state === 'uncertain') process.exitCode = 5;
          printResult(program, receipt, `${receipt.operationId}: ${receipt.state} — ${receipt.message}`);
        } finally { await client.close(); }
      });
    });
}
