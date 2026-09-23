import type { Command } from 'commander';

export function registerDownloadCommands(program: Command): void {
  program
    .command('download')
    .description('export media/slides/assessments locally')
    .option('--dry-run', 'resolve without transferring')
    .action((options: { dryRun?: boolean }) => {
      process.stdout.write(JSON.stringify({ command: 'download', dryRun: options.dryRun === true }) + '\n');
    });
}
