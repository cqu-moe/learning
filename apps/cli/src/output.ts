import { z } from 'zod';
import { JsonSchema, QuestionSchema, JobSchema, LearningError } from '@learning/sdk/public';
import type { Command } from 'commander';
import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

export const OutputModeSchema = z.object({ format: z.enum(['json', 'jsonl']), debug: z.boolean() });
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
  z.object({ ...base, type: z.literal('progress'), data: z.object({ jobId: z.string(), resourceKey: z.string().nullable(), status: z.string(), completed: z.number().nonnegative(), total: z.number().nonnegative().nullable(), serverFraction: z.number().min(0).max(1).nullable(), estimatedSeconds: z.number().nonnegative().nullable(), title: z.string().nullable(), durationSeconds: z.number().nonnegative().nullable(), serverSeconds: z.number().nonnegative().nullable(), sourceSequence: z.number().nonnegative().nullable() }) }),
  z.object({ ...base, type: z.literal('auth'), data: z.object({ stage: z.string(), generation: z.number().nullable(), expiresAtMs: z.number().nullable(), qrPath: z.string().nullable() }) }),
  z.object({ ...base, type: z.literal('question'), data: z.object({ jobId: z.string(), phaseId: z.string(), question: QuestionSchema, closesAtMs: z.number().nullable(), sourceSequence: z.number() }) }),
  z.object({ ...base, type: z.literal('gap'), data: z.object({ jobId: z.string(), message: z.string(), sourceSequence: z.number() }) }),
]);
export type CliEvent = z.infer<typeof CliEventSchema>;
type ProgressData = Extract<CliEvent, { type: 'progress' }>['data'];
export type EventInput = CliEvent extends infer E ? E extends CliEvent ? Pick<E, 'type' | 'data'> : never : never;
export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 2, public fields: string[] = [], public hint: string[] = [], public operationId: string | null = null, options?: ErrorOptions) { super(message, options); this.name = 'CliError'; }
}
export function cleanText(value: string): string { return [...stripVTControlCharacters(value)].filter(char => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join(''); }
export function resolveOutputMode(flags: Record<string, unknown>): OutputMode {
  return { format: flags.json !== true && flags.outputFormat === 'jsonl' ? 'jsonl' : 'json', debug: flags.debug === true };
}
export function errorInfo(error: unknown): { error: z.infer<typeof ErrorSchema>; exitCode: number } {
  if (error instanceof DOMException && error.name === 'AbortError') return errorInfo(new CliError('CANCELED', '操作已取消。', 3));
  if (error instanceof z.ZodError) return errorInfo(new CliError('INVALID_INPUT', '输入数据结构不符合要求。', 2, error.issues.filter(issue => issue.path.length > 0).map(issue => issue.path.map(String).join('.'))));
  if (error instanceof SyntaxError) return errorInfo(new CliError('INVALID_INPUT', '输入内容不是有效的 JSON。'));
  if (!(error instanceof CliError) && error instanceof Error && 'code' in error && ['ENOENT','ENOTDIR','EISDIR'].includes(String(error.code))) return errorInfo(new CliError('INVALID_INPUT', '本地文件路径不存在或类型不正确。'));
  const data = error instanceof LearningError ? error.data : null;
  const exitCode = error instanceof CliError ? error.exitCode : data === null ? 1 : ['INVALID_INPUT', 'PREVIEW_EXPIRED', 'PRECONDITION_CHANGED'].includes(data.code) ? 2 : data.code === 'UNCERTAIN' ? 5 : ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'INTERACTION_REQUIRED', 'UNSUPPORTED', 'MISSING_RUNTIME', 'CONFLICT', 'CANCELED'].includes(data.code) ? 3 : 1;
  const code = error instanceof CliError ? error.code : data?.code ?? 'INTERNAL';
  const hints: Record<string, string[]> = { INVALID_INPUT: ['运行对应命令 --help 查看参数。'], AUTH_REQUIRED: ['请先运行 learning login --profile <账号>。'], AUTH_EXPIRED: ['登录已过期，请运行 learning login --profile <账号> 重新登录。'], UNCERTAIN: [data?.operationId ? `先核对结果，勿重复提交：learning operations reconcile ${shellQuote(data.operationId)}` : '先核对不确定写入的操作记录，勿重复提交。'], CONFLICT: ['确认其他写入进程已退出后再继续；不要删除密钥或数据库。'], MISSING_RUNTIME: ['运行 learning doctor 检查本地依赖。'], CANCELED: ['操作已取消；已执行的写入不会回滚。'] };
  return { exitCode, error: { code, message: cleanText(error instanceof CliError ? error.message : data?.message ?? '发生本地错误，请使用 --debug 查看错误类别。'), hint: error instanceof CliError && error.hint.length ? error.hint : hints[code] ?? [], fields: error instanceof CliError ? error.fields : [], operationId: error instanceof CliError ? error.operationId : data?.operationId ?? null, retryAfterMs: data?.retryAfterMs ?? null } };
}
export function createOutput(mode: OutputMode, streams: { stdout: Writable; stderr: Writable } = process) {
  let command = 'learning';
  let sequence = 0;
  let data: unknown = null;
  let status: CliResult['status'] | undefined;
  let finished = false;
  let canceled = false;
  let home: string | undefined;
  const warnings: Array<z.infer<typeof WarningSchema>> = [];
  const pendingWarnings: Array<z.infer<typeof WarningSchema>> = [];
  const warningKeys = new Set<string>();
  const abort = new AbortController();
  const work = new AbortController();
  const cancel = () => { canceled = true; work.abort(); if (Number(process.exitCode ?? 0) !== 5) process.exitCode = 3; };
  const onError = () => { abort.abort(); cancel(); };
  streams.stdout.on('error', onError);
  streams.stderr.on('error', onError);
  const write = async (stream: Writable, text: string): Promise<void> => {
    if (abort.signal.aborted) return;
    await new Promise<void>((resolve, reject) => stream.write(text, error => {
      if (error) { abort.abort(); if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { reject(error); return; } }
      resolve();
    }));
  };
  const line = async (input: EventInput) => {
    const event = CliEventSchema.parse({ ...input, schemaVersion: 1, sequence: ++sequence, command, time: new Date().toISOString() });
    await write(streams.stdout, JSON.stringify(event) + '\n');
  };
  let eventQueue = Promise.resolve();
  const event = (input: EventInput): Promise<void> => {
    if (mode.format !== 'jsonl') return Promise.resolve();
    const next = eventQueue.then(async () => {
      if (sequence === 0 && input.type !== 'start') await line({ type: 'start', data: null });
      await line(input);
    });
    eventQueue = next.catch(() => {});
    return next;
  };
  const recordWarning = (code: string, message: string): void => {
    const warning = WarningSchema.parse({ code: cleanText(code), message: cleanText(message) });
    const key = JSON.stringify(warning);
    if (warningKeys.has(key)) return;
    warningKeys.add(key); warnings.push(warning); pendingWarnings.push(warning);
  };
  let warningFlush = Promise.resolve();
  const flushWarnings = (): Promise<void> => {
    const next = warningFlush.then(async () => {
      while (pendingWarnings.length > 0) await event({ type: 'warning', data: pendingWarnings.shift()! });
    });
    warningFlush = next.catch(() => {});
    return next;
  };
  return {
    mode, signal: work.signal as AbortSignal,
    recordWarning, flushWarnings,
    setHome(value: string) { home = value; },
    markCanceled: cancel,
    assertActive() { if (work.signal.aborted) throw new CliError('CANCELED', '操作已取消。', 3); },
    setCommand(value: string) { command = value; },
    set(value: unknown, nextStatus?: CliResult['status']) {
      data = value; status = nextStatus;
      if (value !== null && typeof value === 'object' && 'warnings' in value && Array.isArray(value.warnings)) for (const item of WarningSchema.array().parse(value.warnings)) recordWarning(item.code, item.message);
    },
    event,
    async progress(value: ProgressData) { await flushWarnings(); await event({ type: 'progress', data: value }); },
    async warning(code: string, message: string) { recordWarning(code, message); await flushWarnings(); },
    async finish(error?: unknown) {
      if (finished) return;
      finished = true;
      await flushWarnings();
      const info = error === undefined ? null : errorInfo(error);
      const exitCode = info?.exitCode ?? Number(process.exitCode ?? 0);
      process.exitCode = exitCode;
      const result = CliResultSchema.parse({ schemaVersion: 1, command, ok: exitCode === 0, status: exitCode === 5 ? 'uncertain' : exitCode === 4 ? 'partial' : info?.error.code === 'CANCELED' || canceled && info === null ? 'canceled' : exitCode === 3 ? 'needs-input' : exitCode ? 'error' : status ?? 'success', exitCode, data: data ?? null, error: info?.error ?? (exitCode ? { code: exitCode === 5 ? 'UNCERTAIN' : exitCode === 4 ? 'PARTIAL' : canceled ? 'CANCELED' : 'INTERACTION_REQUIRED', message: '操作未完全完成，请查看结果和任务状态。', hint: [], fields: [], operationId: null, retryAfterMs: null } : null), warnings });
      if (result.error !== null) {
        const payload = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
        const jobs = [data, payload?.job, ...(Array.isArray(payload?.jobs) ? payload.jobs : [])];
        for (const candidate of jobs) {
          const parsed = JobSchema.safeParse(candidate);
          if (!parsed.success || !(['paused','needs-input','uncertain'].includes(parsed.data.status) || parsed.data.kind === 'export' && parsed.data.status === 'succeeded')) continue;
          const prefix = home === undefined ? 'learning' : `learning --home ${shellQuote(home)}`;
          const hint = `${prefix} jobs ${parsed.data.status === 'uncertain' ? 'reconcile' : 'resume'} ${shellQuote(parsed.data.id)}`;
          if (!result.error.hint.includes(hint)) result.error.hint.push(hint);
        }
      }
      if (mode.format === 'json') await write(streams.stdout, JSON.stringify(result) + '\n');
      else await event({ type: 'result', data: result });
      if (mode.debug && error !== undefined) await write(streams.stderr, JSON.stringify({ diagnostic: error instanceof Error ? error.name : typeof error, code: info?.error.code }) + '\n');
    },
    close() { streams.stdout.off('error', onError); streams.stderr.off('error', onError); },
  };
}
export type Output = ReturnType<typeof createOutput>;
const outputs = new WeakMap<Command, Output>();
export function bindOutput(program: Command, output: Output) { outputs.set(program, output); }
export function getOutput(program: Command): Output { while (program.parent) program = program.parent; const output = outputs.get(program); if (!output) throw new Error('CLI output is not initialized'); return output; }

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
