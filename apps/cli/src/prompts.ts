import * as clack from '@clack/prompts';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { CliError, cleanText, getOutput } from './output.js';
import type { OutputMode } from './output.js';
import type { Command } from 'commander';

export type Choice = { value: string; label: string; hint?: string };
export type PromptField = { name: string; message: string; options?: Choice[]; initialValue?: string; multiple?: boolean; confirm?: boolean; validate?: (value: unknown) => string | undefined };
export function createPrompts(mode: OutputMode) {
  const ask = async (field: PromptField, signal?: AbortSignal): Promise<unknown> => {
    if (!mode.interactive) throw new CliError('INVALID_INPUT', `缺少参数：${field.name}`, 2, [field.name]);
    const message = cleanText(field.message);
    const options = field.options?.map(item => ({ ...item, label: cleanText(item.label), ...(item.hint === undefined ? {} : { hint: cleanText(item.hint) }) }));
    if (mode.format === 'pretty') {
      const base = { message, input: process.stdin, output: process.stderr, ...(signal ? { signal } : {}) };
      let value: unknown;
      if (field.confirm) value = await clack.confirm({ ...base, initialValue: false });
      else if (options && field.multiple) value = await clack.multiselect({ ...base, options, required: true });
      else if (options) value = await clack.autocomplete({ ...base, options, ...(field.initialValue === undefined ? {} : { initialValue: field.initialValue }) });
      else value = await clack.text({ ...base, ...(field.initialValue === undefined ? {} : { defaultValue: field.initialValue, placeholder: field.initialValue }), validate: value => field.validate?.(value) });
      if (clack.isCancel(value) || signal?.aborted) throw new CliError('CANCELED', '操作已取消。', 3);
      return value;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const input = createInterface({ input: process.stdin, output: process.stderr });
    input.on('SIGINT', cancel);
    input.on('close', cancel);
    try {
      for (;;) {
        if (options) for (const [index, option] of options.entries()) process.stderr.write(`${index + 1}. ${option.label}${option.hint ? ` (${option.hint})` : ''}\n`);
        const reply = (await input.question(`${message}${field.confirm ? ' [y/N]' : field.initialValue ? ` [${cleanText(field.initialValue)}]` : ''}: `, { signal: controller.signal })).trim();
        let value: unknown = reply || field.initialValue || '';
        if (field.confirm) { if (!/^(y|yes|n|no|是|否)?$/i.test(reply)) { process.stderr.write('请输入 y 或 n。\n'); continue; } value = /^(y|yes|是)$/i.test(reply); }
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
  return { interactive: mode.interactive, ask };
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
  if (yes) return;
  if (!output.mode.interactive) throw new CliError('CONFIRMATION_REQUIRED', '此操作需要确认，请检查预览后添加 --yes。', 3);
  await output.message(summary);
  if (!(await createPrompts(output.mode).ask({ name: 'confirm', message: '确认执行以上操作？', confirm: true }))) throw new CliError('CANCELED', '已取消，未执行此操作。', 3);
}
