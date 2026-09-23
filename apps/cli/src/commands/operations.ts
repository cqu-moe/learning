import type { Command } from 'commander';
import { createLearningClient } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';

export function registerOperationsCommands(program: Command): void {
  const operations = program.command('operations').description('inspect a saved uncertain write');
  operations.command('reconcile <operationId>')
    .description('read-only reconciliation of one saved operation id; never resends it')
    .action(async (operationId: string) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const receipt = await client.actions.reconcile(operationId);
          if (receipt.state === 'uncertain') process.exitCode = 5;
          printResult(program, receipt, `${receipt.operationId}: ${receipt.state} — ${receipt.message}`);
        } finally { await client.close(); }
      });
    });
}
