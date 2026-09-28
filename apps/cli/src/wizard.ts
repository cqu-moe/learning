import type { Command } from 'commander';
import { createPrompts } from './prompts.js';
import type { Prompts } from './prompts.js';
import { CliError, getOutput, shellQuote } from './output.js';
const wizard = new WeakSet<Command>();
export function isWizard(program: Command): boolean { while (program.parent) program = program.parent; return wizard.has(program); }
export async function chooseCommand(program: Command, prompts: Prompts): Promise<string[]> {
  const route: string[] = [];
  let current = program;
  while (current.commands.length) {
    const selected = String(await prompts.ask({ name: 'command', message: '请选择操作', options: current.commands.map(command => ({ value: command.name(), label: `${command.name()} — ${command.description()}` })) }));
    const next = current.commands.find(command => command.name() === selected);
    if (!next) throw new CliError('INVALID_INPUT', '所选命令不存在。');
    route.push(selected); current = next;
  }
  return route;
}
export function installWizard(program: Command): void {
  const install = (group: Command) => {
    if (!group.commands.length) return;
    group.action(async () => {
      const output = getOutput(program);
      if (!output.mode.interactive) throw new CliError('INVALID_INPUT', '请选择子命令。', 2, ['command'], [group.helpInformation()]);
      wizard.add(program);
      const route = await chooseCommand(group, createPrompts(output.mode));
      let leaf = group;
      for (const name of route) leaf = leaf.commands.find(command => command.name() === name)!;
      await leaf.parseAsync([], { from: 'user' });
    });
    group.commands.forEach(install);
  };
  program.hook('postAction', async (_root, command) => {
    if (!isWizard(program) || command.commands.length) return;
    const names: string[] = [];
    for (let node: Command | null = command; node?.parent; node = node.parent) names.unshift(node.name());
    const flags: string[] = [];
    for (const source of [program, command]) for (const option of source.options) {
      const name = option.attributeName();
      if (['yes','final'].includes(name) || source.getOptionValueSource(name) === undefined || source.getOptionValueSource(name) === 'default') continue;
      const value: unknown = source.opts()[name];
      if (value === undefined || value === false && !option.negate) continue;
      flags.push(option.long ?? option.short!);
      if (option.required || option.optional) flags.push(...(Array.isArray(value) ? value.map(String) : [String(value)]));
    }
    const args = command.processedArgs.flatMap(value => Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]);
    await getOutput(program).message(`等价命令：learning ${[...names,...flags,...(args.length ? ['--',...args] : [])].map(shellQuote).join(' ')}`);
  });
  install(program);
}
