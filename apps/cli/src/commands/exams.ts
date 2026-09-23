import type { Command } from 'commander';

export function registerExamCommands(program: Command): void {
  const exam = program.command('exam').description('exam draft operations');
  exam
    .command('submit <draft>')
    .description('finalize an exam draft (requires --yes --final)')
    .option('--yes', 'explicit confirmation')
    .option('--final', 'final submission (not just a save)')
    .action((draft: string, options: { yes?: boolean; final?: boolean }) => {
      if (!options.yes || !options.final) {
        process.stderr.write('learning: exam submit requires --yes --final\n');
        process.exitCode = 2;
        return;
      }
      process.stdout.write(JSON.stringify({ draft, state: 'requires-verified-platform-session' }) + '\n');
    });
}
