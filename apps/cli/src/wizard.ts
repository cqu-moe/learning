import type { Command } from 'commander';
import { withCliRuntime } from './context.js';
import { createPrompts } from './prompts.js';
import type { Prompts } from './prompts.js';
import { CliError, getOutput, shellQuote } from './output.js';
const wizard = new WeakSet<Command>();
const home = new WeakSet<Command>();
export function returnsHome(program: Command): boolean { return home.has(program); }
export function isWizard(program: Command): boolean { while (program.parent) program = program.parent; return wizard.has(program); }
export async function chooseCommand(program: Command, prompts: Prompts): Promise<string[]> {
  const route: string[] = [];
  let current = program;
  while (current.commands.length) {
    const selected = String(await prompts.ask({ name: 'command', message: '请选择操作', options: [...current.commands.map(command => ({ value: command.name(), label: `${command.name()} — ${command.description()}` })), ...(!current.parent ? [{ value: '__exit', label: '退出' }] : [])] }));
    if (selected === '__exit') { home.delete(program); return []; }
    const next = current.commands.find(command => command.name() === selected);
    if (!next) throw new CliError('INVALID_INPUT', '所选命令不存在。');
    route.push(selected); current = next;
  }
  return route;
}
const menuLabels: Record<string, string> = {
  doctor: '检查运行环境', jobs: '任务记录', exam: '考试', download: '下载资源',
  profile: '账号管理', login: '登录账号', whoami: '检查登录状态', courses: '查看课程',
  outline: '查看课程目录', homework: '作业', slide: '下载课件', answers: '匹配答案',
  discuss: '讨论', live: '直播', operations: '核对操作结果', telemetry: '使用统计',
};
async function chooseHomeCommand(program: Command, prompts: Prompts): Promise<string[]> {
  let section: 'home' | 'more' = 'home';
  let group = program;
  for (;;) {
    const rootMenu = group === program && section === 'home';
    const commands = group === program ? program.commands.filter(command => !['init', 'run', 'config'].includes(command.name())) : group.commands;
    const options = rootMenu ? [
      { value: 'run', label: '开始学习' }, { value: 'config', label: '配置' },
      { value: '__more', label: '更多' }, { value: '__exit', label: '退出' },
    ] : [...commands.map(command => {
      let owner = command;
      while (owner.parent && owner.parent !== program) owner = owner.parent;
      const beta = !['run', 'profile', 'doctor', 'init', 'login'].includes(owner.name());
      const label = group === program ? menuLabels[command.name()] ?? command.description() : command.description();
      return { value: command.name(), label: label + (beta ? '（内测）' : '') };
    }), { value: '__back', label: '返回' }];
    const selected = String(await prompts.ask({ name: 'command', message: rootMenu ? '请选择操作' : group === program ? '更多功能' : group.name() === 'config' ? '配置' : menuLabels[group.name()] ?? group.description(), options }));
    if (selected === '__exit') { home.delete(program); return []; }
    if (selected === '__more') { section = 'more'; continue; }
    if (selected === '__back') {
      if (group === program) section = 'home';
      else { if (group.name() === 'config') section = 'home'; group = group.parent!; }
      continue;
    }
    const next = group.commands.find(command => command.name() === selected);
    if (!next) throw new CliError('INVALID_INPUT', '所选功能不存在。');
    if (next.commands.length) { group = next; continue; }
    const route: string[] = [];
    for (let command: Command | null = next; command?.parent; command = command.parent) route.unshift(command.name());
    return route;
  }
}
export function installWizard(program: Command): void {
  const install = (group: Command) => {
    if (!group.commands.length) return;
    group.action(async () => {
      const output = getOutput(program);
      if (!output.mode.interactive) throw new CliError('INVALID_INPUT', '请选择子命令。', 2, ['command'], [group.helpInformation()]);
      wizard.add(program);
      if (output.mode.guided) await withCliRuntime(program, false, async () => {});
      if (group === program) home.add(program);
      const route = await (output.mode.guided ? chooseHomeCommand(group, createPrompts(output.mode)) : chooseCommand(group, createPrompts(output.mode)));
      if (!route.length) return;
      let leaf = group;
      for (const name of route) leaf = leaf.commands.find(command => command.name() === name)!;
      await leaf.parseAsync([], { from: 'user' });
    });
    group.commands.forEach(install);
  };
  program.hook('postAction', async (_root, command) => {
    if (!isWizard(program) || command.commands.length || getOutput(program).mode.guided) return;
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
