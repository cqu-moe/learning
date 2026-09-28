#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { bindOutput, CliError, createOutput, resolveOutputMode } from './output.js';
import type { Command } from 'commander';

const program = createProgram();
const argv = process.argv.slice(2);
// Only bootstrap output flags for errors that occur before Commander reaches them.
const flags: Record<string, unknown> = {};
const allOptions = (p: Command): Command['options'] => [...p.options, ...p.commands.flatMap(allOptions)];
const options = allOptions(program);
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === '--') break;
  const name = token.split('=')[0]!;
  const option = options.find(o => o.long === name || o.short === name);
  if (!option) continue;
  const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : option.required ? argv[++i] : !option.negate;
  if (['json','outputFormat','interactive','quiet','color','debug'].includes(option.attributeName())) flags[option.attributeName()] = value;
}
const output = createOutput(resolveOutputMode(flags));
bindOutput(program, output);
if (!output.mode.color) { process.env.NO_COLOR = '1'; delete process.env.FORCE_COLOR; }
let help = '';
program.configureOutput({ writeOut: value => { help += value; }, writeErr: () => {} });
program.hook('preAction', (_root, command) => {
  const names: string[] = [];
  for (let p: Command | null = command; p?.parent; p = p.parent) names.unshift(p.name());
  output.setCommand(names.join(' '));
});
try {
  if (flags.json && flags.outputFormat !== undefined && flags.outputFormat !== 'json') throw new CliError('INVALID_INPUT', '--json 与 --output-format 冲突。');
  if (flags.outputFormat !== undefined && !['pretty','plain','json','jsonl'].includes(String(flags.outputFormat))) throw new CliError('INVALID_INPUT', '输出格式必须为 pretty、plain、json 或 jsonl。');
  await program.parseAsync(argv, { from: 'user' });
  await output.finish();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    output.set({ text: help.trim() }, help.trim());
    await output.finish();
  } else await output.finish(error instanceof CommanderError ? new CliError('INVALID_INPUT', error.message) : error);
} finally { output.close(); }
