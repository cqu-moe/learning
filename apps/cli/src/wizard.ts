import type { Command } from 'commander';
import { createPrompts } from './prompts.js';
import type { Prompts } from './prompts.js';
import { CliError, getOutput } from './output.js';
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
  install(program);
}
