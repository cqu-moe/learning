import type { Command } from 'commander';

export function registerRunCommands(program: Command): void {
  program
    .command('run')
    .description('drive a study job in the foreground (Ctrl+C pauses persistently)')
    .option('--dry-run', 'show the plan without writes')
    .action((options: { dryRun?: boolean }) => {
      process.stdout.write(JSON.stringify({ command: 'run', dryRun: options.dryRun === true }) + '\n');
    });
}
