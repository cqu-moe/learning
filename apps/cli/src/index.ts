#!/usr/bin/env node
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerJobsCommands } from './commands/tasks.js';
import { registerExamCommands } from './commands/exams.js';
import { registerRunCommands } from './commands/run.js';
import { registerDownloadCommands } from './commands/download.js';

const program = new Command();
program.name('learning').description('local learning SDK CLI (Web deferred)').version(pkg.version);
program.option('--home <dir>', 'LEARNING_HOME override');
registerInitCommand(program);
registerDoctorCommand(program);
registerJobsCommands(program);
registerExamCommands(program);
registerRunCommands(program);
registerDownloadCommands(program);
program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`learning: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
