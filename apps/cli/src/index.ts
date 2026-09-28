#!/usr/bin/env node
import { captureWarnings } from './warnings.js';
import type { Command } from 'commander';

const runtimeWarnings = captureWarnings();
const [{ CommanderError }, { createProgram }, { bindOutput, CliError, createOutput, resolveOutputMode }] = await Promise.all([import('commander'), import('./program.js'), import('./output.js')]);
const { returnsHome } = await import('./wizard.js');
const bootstrapProgram = createProgram();
const argv = process.argv.slice(2);
// Only bootstrap output flags for errors that occur before Commander reaches them.
const flags: Record<string, unknown> = {};
const allOptions = (p: Command): Command['options'] => [...p.options, ...p.commands.flatMap(allOptions)];
const options = allOptions(bootstrapProgram);
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === '--') break;
  const name = token.split('=')[0]!;
  const option = options.find(o => o.long === name || o.short === name);
  if (!option) continue;
  const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : option.required ? argv[++i] : !option.negate;
  if (['json','outputFormat','interactive','quiet','color','debug'].includes(option.attributeName())) flags[option.attributeName()] = value;
}
try {
  while (true) {
    const program = createProgram();
    process.exitCode = 0;
    let canceled = false;
    const output = createOutput(resolveOutputMode(flags));
    bindOutput(program, output);
    runtimeWarnings.attach(output.recordWarning);
    await runtimeWarnings.drain();
    process.on('SIGINT', output.markCanceled);
    process.on('SIGTERM', output.markCanceled);
    if (!output.mode.color) { process.env.NO_COLOR = '1'; delete process.env.FORCE_COLOR; }
    let help = '';
    program.configureOutput({ writeOut: value => { help += value; }, writeErr: () => {} });
    const trackCommand = (_root: Command, command: Command) => {
      const names: string[] = [];
      for (let p: Command | null = command; p?.parent; p = p.parent) names.unshift(p.name());
      output.setCommand(names.join(' ') || 'learning');
    };
    program.hook('preAction', trackCommand);
    const trackSubcommands = (command: Command) => { command.hook('preSubcommand', trackCommand); command.commands.forEach(trackSubcommands); };
    trackSubcommands(program);
    try {
      if (flags.json && flags.outputFormat !== undefined && flags.outputFormat !== 'json') throw new CliError('INVALID_INPUT', '--json 与 --output-format 冲突。');
      if (flags.outputFormat !== undefined && !['pretty','plain','json','jsonl'].includes(String(flags.outputFormat))) throw new CliError('INVALID_INPUT', '输出格式必须为 pretty、plain、json 或 jsonl。');
      await program.parseAsync(argv, { from: 'user' });
      await runtimeWarnings.drain();
      await output.finish();
    } catch (error) {
      canceled = error instanceof CliError && error.code === 'CANCELED';
      await runtimeWarnings.drain();
      if (error instanceof CommanderError && error.exitCode === 0) {
        output.set({ text: help.trim() }, help.trim());
        await output.finish();
      } else await output.finish(error instanceof CommanderError ? new CliError('INVALID_INPUT', error.message) : error);
    } finally { process.off('SIGINT', output.markCanceled); process.off('SIGTERM', output.markCanceled); output.close(); }
    if (!returnsHome(program) || output.signal.aborted || canceled) break;
  }
} finally { runtimeWarnings.close(); }
