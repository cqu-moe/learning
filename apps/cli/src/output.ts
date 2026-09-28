import { z } from 'zod';
import { JsonSchema, QuestionSchema, LearningError } from '@learning/sdk/public';
import type { Command } from 'commander';
import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

export const OutputModeSchema = z.object({ format: z.enum(['pretty', 'plain', 'json', 'jsonl']), interactive: z.boolean(), quiet: z.boolean(), color: z.boolean(), debug: z.boolean() });
export type OutputMode = z.infer<typeof OutputModeSchema>;
const ErrorSchema = z.object({ code: z.string(), message: z.string(), hint: z.array(z.string()), fields: z.array(z.string()), operationId: z.string().nullable(), retryAfterMs: z.number().nullable() });
const WarningSchema = z.object({ code: z.string(), message: z.string() });
export const CliResultSchema = z.object({ schemaVersion: z.literal(1), command: z.string(), ok: z.boolean(), status: z.enum(['success', 'preview', 'partial', 'needs-input', 'uncertain', 'canceled', 'error']), exitCode: z.number().int().min(0).max(5), data: JsonSchema.nullable(), error: ErrorSchema.nullable(), warnings: z.array(WarningSchema) });
export type CliResult = z.infer<typeof CliResultSchema>;
const base = { schemaVersion: z.literal(1), sequence: z.number().int().positive(), command: z.string(), time: z.iso.datetime() };
export const CliEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('start'), data: z.null() }),
  z.object({ ...base, type: z.literal('result'), data: CliResultSchema }),
  z.object({ ...base, type: z.literal('warning'), data: WarningSchema }),
  z.object({ ...base, type: z.literal('progress'), data: z.object({ jobId: z.string(), resourceKey: z.string().nullable(), status: z.string(), completed: z.number().nonnegative(), total: z.number().nonnegative().nullable(), serverFraction: z.number().min(0).max(1).nullable(), estimatedSeconds: z.number().nonnegative().nullable(), sourceSequence: z.number().nonnegative().nullable() }) }),
  z.object({ ...base, type: z.literal('auth'), data: z.object({ stage: z.string(), generation: z.number().nullable(), expiresAtMs: z.number().nullable(), qrPath: z.string().nullable() }) }),
  z.object({ ...base, type: z.literal('question'), data: z.object({ jobId: z.string(), phaseId: z.string(), question: QuestionSchema, closesAtMs: z.number().nullable(), sourceSequence: z.number() }) }),
  z.object({ ...base, type: z.literal('gap'), data: z.object({ jobId: z.string(), message: z.string(), sourceSequence: z.number() }) }),
]);
export type CliEvent = z.infer<typeof CliEventSchema>;
export type EventInput = CliEvent extends infer E ? E extends CliEvent ? Pick<E, 'type' | 'data'> : never : never;
export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 2, public fields: string[] = [], public hint: string[] = []) { super(message); }
}
export function cleanText(value: string): string { return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }
export function resolveOutputMode(flags: Record<string, unknown>, terminal = { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY, term: process.env.TERM, ci: process.env.CI, noColor: process.env.NO_COLOR }): OutputMode {
  const tty = terminal.stdin && terminal.stdout && terminal.stderr;
  const ci = !!terminal.ci && !['0', 'false'].includes(terminal.ci.toLowerCase());
  const dynamic = tty && !ci && terminal.term !== 'dumb';
  const requested = flags.json === true ? 'json' : flags.outputFormat;
  const format = typeof requested === 'string' && ['pretty', 'plain', 'json', 'jsonl'].includes(requested) ? requested as OutputMode['format'] : dynamic ? 'pretty' : 'plain';
  return { format: format === 'pretty' && !dynamic ? 'plain' : format, interactive: tty && !ci && flags.interactive !== false && !['json', 'jsonl'].includes(format), quiet: flags.quiet === true, color: flags.color !== false && terminal.noColor === undefined && dynamic, debug: flags.debug === true };
}
export function errorInfo(error: unknown): { error: z.infer<typeof ErrorSchema>; exitCode: number } {
  const data = error instanceof LearningError ? error.data : null;
  const exitCode = error instanceof CliError ? error.exitCode : data === null ? 1 : ['INVALID_INPUT', 'PREVIEW_EXPIRED', 'PRECONDITION_CHANGED'].includes(data.code) ? 2 : data.code === 'UNCERTAIN' ? 5 : ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'INTERACTION_REQUIRED', 'UNSUPPORTED', 'MISSING_RUNTIME', 'CONFLICT', 'CANCELED'].includes(data.code) ? 3 : 1;
  const code = error instanceof CliError ? error.code : data?.code ?? 'INTERNAL';
  const hints: Record<string, string[]> = { INVALID_INPUT: ['运行对应命令 --help 查看参数。'], AUTH_REQUIRED: ['请先运行 learning login --profile <账号>。'], AUTH_EXPIRED: ['登录已过期，请重新登录。'], UNCERTAIN: ['先运行 learning operations reconcile <operationId> 核对结果，勿重复提交。'], CONFLICT: ['确认其他写入进程已退出后再继续；不要删除密钥或数据库。'], MISSING_RUNTIME: ['运行 learning doctor 检查本地依赖。'], CANCELED: ['操作已取消；已执行的写入不会回滚。'] };
  return { exitCode, error: { code, message: cleanText(error instanceof CliError ? error.message : data?.message ?? '发生本地错误，请使用 --debug 查看错误类别。'), hint: error instanceof CliError && error.hint.length ? error.hint : hints[code] ?? [], fields: error instanceof CliError ? error.fields : [], operationId: data?.operationId ?? null, retryAfterMs: data?.retryAfterMs ?? null } };
}
export function createOutput(mode: OutputMode, streams: { stdout: Writable; stderr: Writable } = process) {
  let command = 'learning';
  let sequence = 0;
  let data: unknown = null;
  let human = '';
  let status: CliResult['status'] | undefined;
  let finished = false;
  const warnings: Array<z.infer<typeof WarningSchema>> = [];
  const abort = new AbortController();
  const onError = () => abort.abort();
  streams.stdout.on('error', onError);
  streams.stderr.on('error', onError);
  const write = async (stream: Writable, text: string): Promise<void> => {
    if (abort.signal.aborted) return;
    await new Promise<void>((resolve, reject) => stream.write(text, error => { if (error) { abort.abort(); if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { reject(error); return; } } resolve(); }));
  };
  const machine = mode.format === 'json' || mode.format === 'jsonl';
  const line = async (input: EventInput) => {
    const event = CliEventSchema.parse({ ...input, schemaVersion: 1, sequence: ++sequence, command, time: new Date().toISOString() });
    await write(streams.stdout, JSON.stringify(event) + '\n');
  };
  const event = async (input: EventInput): Promise<void> => {
    if (mode.format !== 'jsonl') return;
    if (sequence === 0 && input.type !== 'start') await line({ type: 'start', data: null });
    await line(input);
  };
  return {
    mode, signal: abort.signal as AbortSignal,
    setCommand(value: string) { command = value; },
    set(value: unknown, text: string, nextStatus?: CliResult['status']) { data = value; human = cleanText(text); status = nextStatus; },
    event,
    async message(text: string) { if (!machine && !mode.quiet) await write(streams.stderr, cleanText(text) + '\n'); },
    async warning(code: string, message: string) { const warning = { code, message: cleanText(message) }; warnings.push(warning); await event({ type: 'warning', data: warning }); if (!machine) await write(streams.stderr, `警告 [${code}] ${warning.message}\n`); },
    async finish(error?: unknown) {
      if (finished) return;
      finished = true;
      const info = error === undefined ? null : errorInfo(error);
      const exitCode = info?.exitCode ?? Number(process.exitCode ?? 0);
      process.exitCode = exitCode;
      const result = CliResultSchema.parse({ schemaVersion: 1, command, ok: exitCode === 0, status: info?.error.code === 'CANCELED' ? 'canceled' : exitCode === 5 ? 'uncertain' : exitCode === 4 ? 'partial' : exitCode === 3 ? 'needs-input' : exitCode ? 'error' : status ?? 'success', exitCode, data: data ?? null, error: info?.error ?? (exitCode ? { code: exitCode === 5 ? 'UNCERTAIN' : exitCode === 4 ? 'PARTIAL' : 'INTERACTION_REQUIRED', message: '操作未完全完成，请查看结果和任务状态。', hint: [], fields: [], operationId: null, retryAfterMs: null } : null), warnings });
      if (mode.format === 'json') await write(streams.stdout, JSON.stringify(result) + '\n');
      else if (mode.format === 'jsonl') await event({ type: 'result', data: result });
      else { if (human) await write(streams.stdout, human + '\n'); if (info) await write(streams.stderr, `错误 [${info.error.code}] ${info.error.message}\n${info.error.hint.join('\n')}${info.error.hint.length ? '\n' : ''}`); }
      if (mode.debug && error !== undefined) await write(streams.stderr, JSON.stringify({ diagnostic: error instanceof Error ? error.name : typeof error, code: info?.error.code }) + '\n');
    },
    close() { streams.stdout.off('error', onError); streams.stderr.off('error', onError); },
  };
}
export type Output = ReturnType<typeof createOutput>;
const outputs = new WeakMap<Command, Output>();
export function bindOutput(program: Command, output: Output) { outputs.set(program, output); }
export function getOutput(program: Command): Output { while (program.parent) program = program.parent; const output = outputs.get(program); if (!output) throw new Error('CLI output is not initialized'); return output; }
