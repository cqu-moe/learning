import { getOutput, CliError } from './output.js';
import { inferTargetScope } from './context.js';
import { registerConfigCommands } from './commands/config.js';
import { Command } from 'commander';
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
import { registerTelemetryCommand } from './commands/telemetry.js';

export function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.name('learning').description('面向 Agent 的本地学习平台 CLI').version(pkg.version, '-V, --version', '显示版本');
  program.option('--home <dir>', '指定本地数据目录');
  program.option('--profile <name>', '选择本地账号');
  program.option('--json', '输出单个 JSON 结果（默认）');
  program.option('--output-format <format>', '输出格式：json 或 jsonl，默认 json', 'json');
  program.option('--debug', '在 stderr 输出脱敏诊断');
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
  registerTelemetryCommand(program);
  registerConfigCommands(program);
  const schema = program.command('schema [path...]').description('查看命令参数、选项与默认值的 JSON 契约');
  schema.action((path: string[]) => {
    let selected = program;
    for (const name of path) {
      const child = selected.commands.find(command => command.name() === name);
      if (!child) throw new CliError('INVALID_INPUT', `未知命令：${path.join(' ')}`, 2, ['path']);
      selected = child;
    }
    getOutput(program).set(describeCommand(selected));
  });
  const configure = (command: Command) => {
    command.helpOption('-h, --help', '显示帮助');
    command.helpCommand('help [command]', '显示指定命令帮助');
    command.configureHelp({ showGlobalOptions: true });
    command.addHelpText('after', '\n默认 JSON；--output-format jsonl 输出事件。缺少参数时返回错误，不读取终端输入。');
    if (command.commands.length) command.action(() => {
      if (command.args.length) throw new CliError('INVALID_INPUT', `未知命令：${command.args.join(' ')}`, 2, ['command']);
      getOutput(program).set(describeCommand(command));
    });
    command.commands.forEach(configure);
  };
  configure(program);
  program.hook('preAction', async (_root, command) => {
    await inferTargetScope(program, command.registeredArguments[0]?.name(), command.processedArgs[0], command.parent?.name() === 'discuss', command.parent?.name() === 'homework' && command.name() === 'apply');
  });
  return program;
}

function describeCommand(command: Command): unknown {
  const options = (owner: Command) => owner.options.map(option => ({
    flags: option.flags, description: option.description, required: option.mandatory,
    takesValue: option.required || option.optional, variadic: option.variadic,
    default: option.defaultValue ?? null, choices: option.argChoices ?? null,
  }));
  return {
    name: command.name(), description: command.description(),
    arguments: command.registeredArguments.map(argument => ({ name: argument.name(), description: argument.description, required: argument.required, variadic: argument.variadic, default: argument.defaultValue ?? null })),
    options: options(command),
    globalOptions: command.parent ? options(rootOf(command)) : [],
    commands: command.commands.map(child => ({ name: child.name(), description: child.description() })),
  };
}

function rootOf(command: Command): Command {
  while (command.parent) command = command.parent;
  return command;
}
