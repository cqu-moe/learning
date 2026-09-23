import type { Command } from 'commander';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('report local runtime readiness')
    .action(() => {
      const lines = [
        ['node', process.version],
        ['browser', 'not configured (slides.legacy needs explicit install; never auto-installed)'],
        ['model', 'not configured (optional)'],
      ] as const;
      for (const [key, value] of lines) process.stdout.write(`${key}: ${value}\n`);
    });
}
