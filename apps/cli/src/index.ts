#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerJobsCommands } from './commands/tasks.js';
import { registerExamCommands } from './commands/exams.js';
import { registerRunCommands } from './commands/run.js';
import { registerDownloadCommands } from './commands/download.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerLoginCommands } from './commands/login.js';
import { registerCatalogCommands } from './commands/catalog.js';
import { registerHomeworkCommands } from './commands/homework.js';
import { registerSlideCommand } from './commands/slide.js';
import { registerAnswersCommands } from './commands/answers.js';
import { registerDiscussCommands } from './commands/discuss.js';
import { registerLiveCommand } from './commands/live.js';
import { registerOperationsCommands } from './commands/operations.js';
import { LearningError } from '@learning/sdk/public';

const program = new Command();
program.exitOverride();
program.name('learning').description('local learning SDK CLI (Web deferred)').version(pkg.version);
program.option('--home <dir>', 'LEARNING_HOME override');
program.option('--profile <name>', 'select a local platform profile');
program.option('--json', 'print one JSON result on stdout');
program.option('--debug', 'print diagnostics on stderr');
registerInitCommand(program);
registerDoctorCommand(program);
registerJobsCommands(program);
registerExamCommands(program);
registerRunCommands(program);
registerDownloadCommands(program);
registerProfileCommands(program);
registerLoginCommands(program);
registerCatalogCommands(program);
registerHomeworkCommands(program);
registerSlideCommand(program);
registerAnswersCommands(program);
registerDiscussCommands(program);
registerLiveCommand(program);
registerOperationsCommands(program);
program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
    return;
  }
  if (error instanceof LearningError) {
    process.stderr.write(`learning: ${error.data.message}${error.data.code === 'UNCERTAIN' && error.data.operationId !== null ? ` (operation ${error.data.operationId})` : ''}\n`);
    if (error.data.code === 'INVALID_INPUT' || error.data.code === 'PREVIEW_EXPIRED' || error.data.code === 'PRECONDITION_CHANGED') process.exitCode = 2;
    else if (error.data.code === 'UNCERTAIN') process.exitCode = 5;
    else if (['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'INTERACTION_REQUIRED', 'UNSUPPORTED', 'MISSING_RUNTIME', 'CONFLICT', 'CANCELED'].includes(error.data.code)) process.exitCode = 3;
    else process.exitCode = 1;
    return;
  }
  process.stderr.write(`learning: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
