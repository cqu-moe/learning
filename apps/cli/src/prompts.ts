import * as clack from '@clack/prompts';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { CliError, cleanText, getOutput, pauseProgress, commandSignal, errorInfo, beginPrompt, endPrompt } from './output.js';
import type { OutputMode } from './output.js';
import type { Command } from 'commander';

export type Choice = { value: string; label: string; hint?: string };
export type PromptField = { name: string; message: string; options?: Choice[]; initialValue?: string; multiple?: boolean; confirm?: boolean; validate?: (value: unknown) => string | undefined };
/** clack validates before applying defaultValue, so an untouched input must validate against the default. */
export function submittedText(value: unknown, initialValue?: string): unknown {
  return value === undefined || value === '' ? initialValue : value;
}
export function createPrompts(mode: OutputMode) {
  clack.updateSettings({ messages: { cancel: '已取消', error: '操作失败' } });
  const askValue = async (field: PromptField, signal?: AbortSignal): Promise<unknown> => {
    const parent = commandSignal(mode);
    signal = parent && signal ? AbortSignal.any([parent, signal]) : parent ?? signal;
    if (signal?.aborted) throw new CliError('CANCELED', '操作已取消。', 3);
    if (!mode.interactive) throw new CliError('INVALID_INPUT', `缺少参数：${field.name}`, 2, [field.name]);
    pauseProgress(mode);
    const message = cleanText(field.message);
    const options = field.options?.map(item => ({ ...item, label: cleanText(item.label), ...(item.hint === undefined ? {} : { hint: cleanText(item.hint) }) }));
    if (mode.format === 'pretty') {
      const base = { message, input: process.stdin, output: process.stderr, ...(signal ? { signal } : {}) };
      let value: unknown;
      if (field.confirm) value = await clack.confirm({ ...base, initialValue: false, active: '是', inactive: '否' });
      else if (options && field.multiple) value = await clack.multiselect({ ...base, options, required: true });
      else if (options && mode.guided && !['course', 'resource'].includes(field.name)) value = await clack.select({ ...base, options, ...(field.initialValue === undefined ? {} : { initialValue: field.initialValue }) });
      else if (options) value = await clack.autocomplete({ ...base, options, ...(field.initialValue === undefined ? {} : { initialValue: field.initialValue }) });
      else value = await clack.text({ ...base, ...(field.initialValue === undefined ? {} : { defaultValue: field.initialValue, placeholder: field.initialValue }), validate: value => field.validate?.(submittedText(value, field.initialValue)) });
      if (clack.isCancel(value) || signal?.aborted) throw new CliError('CANCELED', '操作已取消。', 3);
      return value;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const input = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    input.on('SIGINT', cancel);
    input.on('close', cancel);
    try {
      for (;;) {
        if (options) for (const [index, option] of options.entries()) process.stderr.write(`${index + 1}. ${option.label}${option.hint ? ` (${option.hint})` : ''}\n`);
        const initialLabel = mode.guided && options && field.initialValue !== undefined ? String(options.findIndex(option => option.value === field.initialValue) + 1) : field.initialValue;
        const reply = (await input.question(`${message}${field.confirm ? ' [y/N]' : initialLabel ? ` [${cleanText(initialLabel)}]` : ''}: `, { signal: controller.signal })).trim();
        let value: unknown = reply || field.initialValue || '';
        if (field.confirm) { if (!/^(y|yes|n|no|是|否)?$/i.test(reply)) { process.stderr.write('请输入 y 或 n。\n'); continue; } value = /^(y|yes|是)$/i.test(reply); }
        else if (options && reply === '' && field.initialValue !== undefined && options.some(option => option.value === field.initialValue)) value = field.multiple ? [field.initialValue] : field.initialValue;
        else if (options) {
          const indices = reply.split(',').map(value => Number(value) - 1);
          if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= options.length) || (!field.multiple && indices.length !== 1)) { process.stderr.write('请选择有效编号。\n'); continue; }
          value = field.multiple ? [...new Set(indices)].map(index => options[index]!.value) : options[indices[0]!]!.value;
        }
        const error = field.validate?.(value);
        if (error) { process.stderr.write(cleanText(error) + '\n'); continue; }
        return value;
      }
    } catch (error) { if (controller.signal.aborted) throw new CliError('CANCELED', '操作已取消。', 3); throw error; }
    finally { input.close(); signal?.removeEventListener('abort', cancel); }
  };
  const ask = async (field: PromptField, signal?: AbortSignal): Promise<unknown> => {
    await beginPrompt(mode);
    try { return await askValue(field, signal); }
    finally { await endPrompt(mode); }
  };
  return { interactive: mode.interactive, ...(mode.guided ? { guided: true } : {}), ask };
}
export type Prompts = ReturnType<typeof createPrompts>;
export async function fillMissing<T extends z.ZodRawShape>(schema: z.ZodObject<T>, supplied: Record<string, unknown>, fields: PromptField[], prompts: Pick<Prompts, 'interactive' | 'ask'>): Promise<z.infer<z.ZodObject<T>>> {
  const values = { ...supplied };
  const explicit = schema.partial().safeParse(values);
  if (!explicit.success) throw new CliError('INVALID_INPUT', '显式参数无效：' + explicit.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'), 2, explicit.error.issues.map(issue => String(issue.path[0])));
  const parsed = schema.safeParse(values);
  if (parsed.success) return parsed.data;
  const missing = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))];
  if (!prompts.interactive) throw new CliError('INVALID_INPUT', `缺少参数：${missing.join('、')}`, 2, missing);
  for (const key of missing) {
    const field = fields.find(field => field.name === key) ?? { name: key, message: key };
    const part = schema.shape[key]!;
    for (;;) {
      const value = await prompts.ask({ ...field, validate: value => z.safeParse(part, value).success ? undefined : '输入无效，请重新填写。' });
      const check = z.safeParse(part, value);
      if (check.success) { values[key] = check.data; break; }
    }
  }
  return schema.parse(values);
}
export async function confirmAction(program: Command, summary: string, yes: boolean | undefined): Promise<void> {
  const output = getOutput(program);
  output.assertActive();
  if (yes) return;
  if (!output.mode.interactive) throw new CliError('CONFIRMATION_REQUIRED', '此操作需要确认，请检查预览后添加 --yes。', 3);
  await output.message(summary, true);
  if (!(await createPrompts(output.mode).ask({ name: 'confirm', message: '确认执行以上操作？', confirm: true }))) throw new CliError('CANCELED', '已取消，未执行此操作。', 3);
}

export async function askDefaults(command: Command, fields: PromptField[], enabled: boolean): Promise<void> {
  if (!enabled) return;
  const prompts = createPrompts(getOutput(command).mode);
  for (const field of fields) {
    if (command.getOptionValueSource(field.name) === 'cli') continue;
    const current: unknown = command.opts()[field.name];
    const prompt = field.initialValue === undefined && typeof current === 'string' ? { ...field, initialValue: current } : field;
    command.setOptionValueWithSource(field.name, await prompts.ask(prompt), 'prompt');
  }
}

export function installInputCompletion(program: Command): void {
  const visit = (command: Command) => {
    command.commands.forEach(visit);
    if (command.commands.length) return;
    const requiredArguments = command.registeredArguments.filter(argument => argument.required);
    const requiredOptions = command.options.filter(option => option.mandatory);
    for (const argument of requiredArguments) argument.required = false;
    for (const option of requiredOptions) option.makeOptionMandatory(false);
    command.hook('preAction', async () => {
      const { inferTargetScope } = await import('./context.js');
      await inferTargetScope(program, command.registeredArguments[0]?.name(), command.processedArgs[0], command.parent?.name() === 'discuss');
      const output = getOutput(program);
      const prompts = createPrompts(output.mode);
      const shape: Record<string, z.ZodType> = {};
      const supplied: Record<string, unknown> = {};
      const fields: PromptField[] = [];
      for (const argument of requiredArguments) {
        const name = argument.name();
        shape[name] = name === 'lesson-url' ? z.url() : z.string().min(1);
        const value = command.processedArgs[command.registeredArguments.indexOf(argument)];
        if (value !== undefined) supplied[name] = value;
        fields.push({ name, message: ({ resource: '选择资源', file: '草稿文件路径', draft: '草稿文件路径', jobId: '任务 ID', operationId: '待核对的操作 ID', 'lesson-url': '课次 URL' } as Record<string, string>)[name] ?? name });
      }
      for (const option of requiredOptions) {
        const name = option.attributeName();
        shape[name] = option.variadic ? z.array(z.string().min(1)).min(1) : z.string().min(1);
        if (command.opts()[name] !== undefined) supplied[name] = command.opts()[name];
        fields.push({ name, message: name === 'output' ? '新输出文件路径（不会覆盖已有文件）' : '反馈来源文件路径' });
      }
      const ask: Prompts['ask'] = async (field, signal) => {
        if (field.name === 'file' || field.name === 'draft') {
          for (;;) {
            const value = await prompts.ask(field, signal);
            try { await inferTargetScope(program, field.name, value, command.parent?.name() === 'discuss'); return value; }
            catch (error) { const info = errorInfo(error); if (info.exitCode !== 2) throw error; await output.message(`${info.error.message} 请重新输入。`, true); }
          }
        }
        if (field.name === 'resource') {
          const { withCliRuntime, selectProfile } = await import('./context.js');
          const { createLearningClient } = await import('@learning/sdk');
          const { chooseResource } = await import('./commands/catalog.js');
          let selected: string | undefined;
          await withCliRuntime(program, true, async runtime => {
            const profile = await selectProfile(program, runtime);
            program.setOptionValueWithSource('profile', profile.name, 'prompt');
            const client = createLearningClient({ scope: profile.scope, runtime });
            try { selected = (await chooseResource(client, runtime, prompts, command.parent?.name() === 'exam' ? ['exam'] : command.parent?.name() === 'discuss' ? ['discussion'] : ['homework','video'])).key; }
            finally { await client.close(); }
          });
          return selected;
        }
        if (field.name === 'jobId') {
          const { withCliRuntime } = await import('./context.js');
          const { getProfile } = await import('./profiles.js');
          const { selectJob } = await import('./commands/tasks.js');
          let id: string | undefined;
          await withCliRuntime(program, false, async runtime => {
            const name = program.opts<{ profile?: string }>().profile;
            const profile = name === undefined ? null : await getProfile(runtime.state, name);
            if (name !== undefined && !profile) throw new CliError('INVALID_INPUT', '找不到指定账号。');
            const statuses = command.name() === 'resume' ? ['paused','needs-input','queued','waiting'] as const : command.name() === 'reconcile' ? ['uncertain','paused','needs-input','failed'] as const : undefined;
            id = (await selectJob(runtime.state, prompts, statuses ? [...statuses] : undefined, profile?.scope.profileId)).id;
          });
          return id;
        }
        if (field.name === 'source') {
          const files: string[] = [];
          do { files.push(String(await prompts.ask({ name: 'source', message: '反馈来源文件路径', validate: value => typeof value === 'string' && value.length ? undefined : '请输入路径。' }, signal))); }
          while (await prompts.ask({ name: 'more', message: '继续添加来源文件？', confirm: true }, signal));
          return files;
        }
        return prompts.ask(field, signal);
      };
      const values = await fillMissing(z.object(shape), supplied, fields, { interactive: prompts.interactive, ask });
      for (const argument of requiredArguments) command.processedArgs[command.registeredArguments.indexOf(argument)] = values[argument.name()];
      for (const option of requiredOptions) if (command.getOptionValueSource(option.attributeName()) !== 'cli') command.setOptionValueWithSource(option.attributeName(), values[option.attributeName()], 'prompt');
      await inferTargetScope(program, command.registeredArguments[0]?.name(), command.processedArgs[0], command.parent?.name() === 'discuss');
    });
  };
  program.commands.forEach(visit);
}

export function requireConfirmation(program: Command, yes: boolean | undefined, dryRun: boolean | undefined): void {
  if (!yes && !dryRun && !getOutput(program).mode.interactive) throw new CliError('CONFIRMATION_REQUIRED', '此操作需要 --yes；请先使用 --dry-run 查看预览。', 3, ['yes']);
}
