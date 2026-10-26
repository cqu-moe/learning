#!/usr/bin/env node
import { captureWarnings } from './warnings.js';
import { resolveDataDir } from './data-dir.js';
import type { Command } from 'commander';
import type { Output } from './output.js';

process.setSourceMapsEnabled?.(true);
const [{ finishTelemetry, startTelemetry, trackException, redactDiagnosticValues }, { createOutput: createDiagnosticOutput }] = await Promise.all([import('./telemetry.js'), import('./output.js')]);
let activeOutput: Output | undefined;
let diagnosticHome: string | undefined;
const inputValues: string[] = [];
// Monitoring keeps Node's fatal exit behavior; the synchronous outbox survives that exit.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  const output = activeOutput ?? createDiagnosticOutput({ format: 'json', interactive: false, quiet: true, color: false, debug: false });
  void startTelemetry(output, resolveDataDir(diagnosticHome), 'learning').catch(() => {});
  redactDiagnosticValues(output, inputValues);
  trackException(output, error, { stage: origin }, false);
});

const runtimeWarnings = captureWarnings();
const [{ CommanderError }, { createProgram }, { bindOutput, CliError, createOutput, resolveOutputMode }] = await Promise.all([import('commander'), import('./program.js'), import('./output.js')]);
const { returnsHome } = await import('./wizard.js');
const bootstrapProgram = createProgram();
const argv = process.argv.slice(2);
// Only bootstrap output flags for errors that occur before Commander reaches them.
const flags: Record<string, unknown> = {};
const allOptions = (p: Command): Command['options'] => [...p.options, ...p.commands.flatMap(allOptions)];
const options = allOptions(bootstrapProgram);
let inputCommand = bootstrapProgram;
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === '--') { inputValues.push(...argv.slice(i + 1)); break; }
  const name = token.split('=')[0]!;
  const option = options.find(o => o.long === name || o.short === name);
  if (!option) {
    const child = inputCommand.commands.find(command => command.name() === token || command.aliases().includes(token));
    if (child) inputCommand = child;
    else inputValues.push(token);
    continue;
  }
  const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : option.required ? argv[++i] : !option.negate;
  if (typeof value === 'string') inputValues.push(value);
  if (option.attributeName() === 'home' && typeof value === 'string') diagnosticHome = value;
  if (['json','outputFormat','interactive','quiet','color','debug'].includes(option.attributeName())) flags[option.attributeName()] = value;
}
try {
  while (true) {
    const program = createProgram();
    process.exitCode = 0;
    let canceled = false;
    let commandError: unknown;
    const mode = resolveOutputMode(flags);
    mode.guided = argv.length === 0 && mode.interactive;
    const output = createOutput(mode);
    activeOutput = output;
    bindOutput(program, output);
    runtimeWarnings.attach(output.recordWarning);
    await runtimeWarnings.drain();
    process.on('SIGINT', output.markCanceled);
    process.on('SIGTERM', output.markCanceled);
    if (!output.mode.color) { process.env.NO_COLOR = '1'; delete process.env.FORCE_COLOR; }
    let help = '';
    let currentCommand = 'learning';
    program.configureOutput({ writeOut: value => { help += value; }, writeErr: () => {} });
    const commandPath = (command: Command) => {
      const names: string[] = [];
      for (let p: Command | null = command; p?.parent; p = p.parent) names.unshift(p.name());
      return names.join(' ') || 'learning';
    };
    const trackCommand = (_root: Command, command: Command) => {
      const path = commandPath(command);
      currentCommand = path;
      output.setCommand(path);
      if (command.commands.length === 0 && path !== 'doctor' && !path.startsWith('telemetry ')) {
        return startTelemetry(output, resolveDataDir(program.opts<{ home?: string }>().home), path).then(() => redactDiagnosticValues(output, inputValues)).catch(() => {});
      }
    };
    program.hook('preAction', trackCommand);
    const trackSubcommands = (command: Command) => { command.hook('preSubcommand', (_root: Command, child: Command) => { currentCommand = commandPath(child); output.setCommand(currentCommand); }); command.commands.forEach(trackSubcommands); };
    trackSubcommands(program);
    try {
      if (flags.json && flags.outputFormat !== undefined && flags.outputFormat !== 'json') throw new CliError('INVALID_INPUT', '--json 与 --output-format 冲突。');
      if (flags.outputFormat !== undefined && !['pretty','plain','json','jsonl'].includes(String(flags.outputFormat))) throw new CliError('INVALID_INPUT', '输出格式必须为 pretty、plain、json 或 jsonl。');
      await program.parseAsync(argv, { from: 'user' });
      await runtimeWarnings.drain();
      await output.finish();
    } catch (error) {
      commandError = error;
      canceled = error instanceof CliError && error.code === 'CANCELED';
      await runtimeWarnings.drain();
      if (error instanceof CommanderError && error.exitCode === 0) {
        commandError = undefined;
        output.set({ text: help.trim() }, help.trim());
        await output.finish();
      } else {
        await startTelemetry(output, resolveDataDir(program.opts<{ home?: string }>().home), currentCommand).catch(() => {});
        redactDiagnosticValues(output, inputValues);
        if (error instanceof CommanderError) commandError = new CliError('INVALID_INPUT', error.message, 2, [], [], null, { cause: error });
        await output.finish(commandError);
      }
    } finally {
      await finishTelemetry(output, commandError).catch(() => {});
      process.off('SIGINT', output.markCanceled);
      process.off('SIGTERM', output.markCanceled);
      output.close();
      activeOutput = undefined;
    }
    if (!returnsHome(program) || output.signal.aborted || canceled) break;
  }
} finally { runtimeWarnings.close(); }
