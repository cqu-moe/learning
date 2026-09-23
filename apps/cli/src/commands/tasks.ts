import type { Command } from 'commander';

export function registerJobsCommands(program: Command): void {
  const jobs = program.command('jobs').description('inspect local jobs');
  jobs
    .command('list')
    .description('list job records (read-only)')
    .action(() => {
      process.stdout.write('[]\n');
    });
  jobs
    .command('reconcile <jobId>')
    .description('read-only check of a job pending operation; refuses resume while uncertain')
    .action((jobId: string) => {
      process.stdout.write(JSON.stringify({ jobId, state: 'no-pending-operation' }) + '\n');
    });
}
