import { spinner } from '@clack/prompts';
import Table from 'cli-table3';
import { z } from 'zod';
import { JsonSchema, QuestionSchema, JobSchema, LearningError } from '@learning/sdk/public';
import type { Command } from 'commander';
import type { Writable } from 'node:stream';
import { stripVTControlCharacters, styleText } from 'node:util';
import { createProgressDisplay } from './progress.js';

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
  z.object({ ...base, type: z.literal('progress'), data: z.object({ jobId: z.string(), resourceKey: z.string().nullable(), status: z.string(), completed: z.number().nonnegative(), total: z.number().nonnegative().nullable(), serverFraction: z.number().min(0).max(1).nullable(), estimatedSeconds: z.number().nonnegative().nullable(), title: z.string().nullable(), durationSeconds: z.number().nonnegative().nullable(), serverSeconds: z.number().nonnegative().nullable(), sourceSequence: z.number().nonnegative().nullable() }) }),
  z.object({ ...base, type: z.literal('auth'), data: z.object({ stage: z.string(), generation: z.number().nullable(), expiresAtMs: z.number().nullable(), qrPath: z.string().nullable() }) }),
  z.object({ ...base, type: z.literal('question'), data: z.object({ jobId: z.string(), phaseId: z.string(), question: QuestionSchema, closesAtMs: z.number().nullable(), sourceSequence: z.number() }) }),
  z.object({ ...base, type: z.literal('gap'), data: z.object({ jobId: z.string(), message: z.string(), sourceSequence: z.number() }) }),
]);
export type CliEvent = z.infer<typeof CliEventSchema>;
type ProgressData = Extract<CliEvent, { type: 'progress' }>['data'];
export interface StudyDisplay { courseTitle: string; profileName: string; speed: number; targetFraction: number; nextRunAtMs?: number | null; observedAtMs?: number }
export const jobStates: Record<string, string> = { queued: '准备中', running: '进行中', waiting: '学习中', paused: '已暂停', 'needs-input': '需要人工处理', uncertain: '写入结果待核对', succeeded: '已完成', partial: '部分完成', failed: '失败', canceled: '已取消' };
const activeJob = (status: string) => ['queued', 'running', 'waiting'].includes(status);
const singleLine = (text: string) => cleanText(text).replace(/\s+/g, ' ').trim();
function progressBar(fraction: number | null, width: number, now: number): string {
  const size = Math.max(4, Math.min(32, width - 10));
  if (fraction === null) {
    const position = Math.floor(now / 100) % size;
    return '─'.repeat(position) + '━' + '─'.repeat(size - position - 1);
  }
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * size);
  return '━'.repeat(filled) + '─'.repeat(size - filled) + ` ${(fraction * 100).toFixed(1)}%`;
}
function progressLines(value: ProgressData, study: StudyDisplay | undefined, startedAt: number, observedAt: number, width: number): string[] {
  const now = Date.now();
  const total = value.total;
  const lines = [study ? singleLine(study.courseTitle) : '任务进度'];
  if (study) lines.push(`${singleLine(study.profileName)} · ${study.speed}× · 目标 ${study.targetFraction * 100}%`);
  lines.push(`已完成 ${value.completed}/${total ?? '?'} 个资源`, progressBar(total === null || total === 0 ? null : value.completed / total, width, now));
  if (value.resourceKey !== null || value.title !== null) {
    lines.push(`当前 ${singleLine(value.title ?? '') || '学习资源'}`);
    const duration = value.durationSeconds;
    const until = study?.nextRunAtMs;
    const elapsed = study && activeJob(value.status) && until != null ? Math.max(0, (Math.min(now, until) - observedAt) / 1000) * study.speed : 0;
    const baseline = value.serverSeconds ?? (value.serverFraction !== null && duration !== null ? value.serverFraction * duration : null);
    const seconds = baseline === null || duration === null ? null : Math.min(duration * (study?.targetFraction ?? 1), baseline + elapsed);
    const fraction = seconds !== null && duration !== null && duration > 0 ? seconds / duration : value.serverFraction;
    lines.push(progressBar(fraction, width, now));
    if (duration !== null && duration > 0 && seconds !== null) {
      lines.push(`${elapsed > 0 || value.serverSeconds === null ? '本地估计' : '播放进度'} ${formatClock(seconds)}/${formatClock(duration)}`);
    } else if (duration !== null && duration > 0) lines.push(`视频时长 ${formatClock(duration)}`);
    lines.push(value.serverFraction === null ? '平台进度暂不可用' : `平台已确认 ${(value.serverFraction * 100).toFixed(1)}%`);
  }
  const state = value.status === 'waiting' && !study ? '等待继续' : jobStates[value.status] ?? value.status;
  lines.push(`${state} · 已用 ${formatClock(Math.max(0, now - startedAt) / 1000)}`);
  if (activeJob(value.status)) lines.push('Ctrl+C 暂停并保存');
  return lines;
}
export type EventInput = CliEvent extends infer E ? E extends CliEvent ? Pick<E, 'type' | 'data'> : never : never;
export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 2, public fields: string[] = [], public hint: string[] = [], public operationId: string | null = null) { super(message); }
}
export function cleanText(value: string): string { return [...stripVTControlCharacters(value)].filter(char => char === '\n' || char === '\t' || char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join(''); }
export function resolveOutputMode(flags: Record<string, unknown>, terminal = { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY, term: process.env.TERM, ci: process.env.CI, noColor: process.env.NO_COLOR }): OutputMode {
  const tty = terminal.stdin && terminal.stdout && terminal.stderr;
  const ci = !!terminal.ci && !['0', 'false'].includes(terminal.ci.toLowerCase());
  const dynamic = tty && !ci && terminal.term !== 'dumb';
  const requested = flags.json === true ? 'json' : flags.outputFormat;
  const format = typeof requested === 'string' && ['pretty', 'plain', 'json', 'jsonl'].includes(requested) ? requested as OutputMode['format'] : dynamic ? 'pretty' : 'plain';
  return { format: format === 'pretty' && !dynamic ? 'plain' : format, interactive: tty && !ci && flags.interactive !== false && !['json', 'jsonl'].includes(format), quiet: flags.quiet === true, color: flags.color !== false && terminal.noColor === undefined && dynamic, debug: flags.debug === true };
}
export function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h > 0 ? `${h}:` : ''}${h > 0 ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}
export function errorInfo(error: unknown): { error: z.infer<typeof ErrorSchema>; exitCode: number } {
  if (error instanceof z.ZodError) return errorInfo(new CliError('INVALID_INPUT', '输入数据结构不符合要求。', 2, error.issues.filter(issue => issue.path.length > 0).map(issue => issue.path.map(String).join('.'))));
  if (error instanceof SyntaxError) return errorInfo(new CliError('INVALID_INPUT', '输入内容不是有效的 JSON。'));
  if (!(error instanceof CliError) && error instanceof Error && 'code' in error && ['ENOENT','ENOTDIR','EISDIR'].includes(String(error.code))) return errorInfo(new CliError('INVALID_INPUT', '本地文件路径不存在或类型不正确。'));
  const data = error instanceof LearningError ? error.data : null;
  const exitCode = error instanceof CliError ? error.exitCode : data === null ? 1 : ['INVALID_INPUT', 'PREVIEW_EXPIRED', 'PRECONDITION_CHANGED'].includes(data.code) ? 2 : data.code === 'UNCERTAIN' ? 5 : ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'INTERACTION_REQUIRED', 'UNSUPPORTED', 'MISSING_RUNTIME', 'CONFLICT', 'CANCELED'].includes(data.code) ? 3 : 1;
  const code = error instanceof CliError ? error.code : data?.code ?? 'INTERNAL';
  const hints: Record<string, string[]> = { INVALID_INPUT: ['运行对应命令 --help 查看参数。'], AUTH_REQUIRED: ['请先运行 learning login --profile <账号>。'], AUTH_EXPIRED: ['登录已过期，请运行 learning login --profile <账号> 重新登录。'], UNCERTAIN: [data?.operationId ? `先核对结果，勿重复提交：learning operations reconcile ${shellQuote(data.operationId)}` : '先核对不确定写入的操作记录，勿重复提交。'], CONFLICT: ['确认其他写入进程已退出后再继续；不要删除密钥或数据库。'], MISSING_RUNTIME: ['运行 learning doctor 检查本地依赖。'], CANCELED: ['操作已取消；已执行的写入不会回滚。'] };
  return { exitCode, error: { code, message: cleanText(error instanceof CliError ? error.message : data?.message ?? '发生本地错误，请使用 --debug 查看错误类别。'), hint: error instanceof CliError && error.hint.length ? error.hint : hints[code] ?? [], fields: error instanceof CliError ? error.fields : [], operationId: error instanceof CliError ? error.operationId : data?.operationId ?? null, retryAfterMs: data?.retryAfterMs ?? null } };
}
const promptBoundaries = new WeakMap<OutputMode, { begin: () => Promise<void>; end: () => Promise<void> }>();
export async function beginPrompt(mode: OutputMode): Promise<void> { await promptBoundaries.get(mode)?.begin(); }
export async function endPrompt(mode: OutputMode): Promise<void> { await promptBoundaries.get(mode)?.end(); }
const progressPauses = new WeakMap<OutputMode, () => void>();
const commandSignals = new WeakMap<OutputMode, AbortSignal>();
export function commandSignal(mode: OutputMode): AbortSignal | undefined { return commandSignals.get(mode); }
export function pauseProgress(mode: OutputMode): void { progressPauses.get(mode)?.(); }
export function createOutput(mode: OutputMode, streams: { stdout: Writable; stderr: Writable } = process) {
  let command = 'learning';
  let sequence = 0;
  let data: unknown = null;
  let human = '';
  let status: CliResult['status'] | undefined;
  let finished = false;
  let canceled = false;
  let home: string | undefined;
  let indicator: ReturnType<typeof spinner> | null = null;
  let display: ReturnType<typeof createProgressDisplay> | null = null;
  let live: { value: ProgressData; study: StudyDisplay | undefined; startedAt: number; observedAt: number } | null = null;
  let lastProgressAt = 0;
  let lastPhase = '';
  let indicatorText = '';
  let promptDepth = 0;
  const pause = () => { const current = display; display = null; current?.clear(); indicator?.clear(); indicator = null; };
  const showProgress = () => {
    if (!live || promptDepth > 0 || finished || work.signal.aborted) return;
    if (display) display.draw();
    else display = createProgressDisplay(streams.stderr, width => live ? progressLines(live.value, live.study, live.startedAt, live.observedAt, width) : []);
  };
  progressPauses.set(mode, pause);
  const warnings: Array<z.infer<typeof WarningSchema>> = [];
  const pendingWarnings: Array<z.infer<typeof WarningSchema>> = [];
  const warningKeys = new Set<string>();
  const abort = new AbortController();
  const work = new AbortController();
  commandSignals.set(mode, work.signal);
  const cancel = () => { canceled = true; work.abort(); pause(); if (Number(process.exitCode ?? 0) !== 5) process.exitCode = 3; };
  const onError = () => { abort.abort(); cancel(); };
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
  const recordWarning = (code: string, message: string): void => {
    const warning = WarningSchema.parse({ code: cleanText(code), message: cleanText(message) });
    const key = JSON.stringify(warning);
    if (warningKeys.has(key)) return;
    warningKeys.add(key); warnings.push(warning); pendingWarnings.push(warning);
  };
  let warningFlush = Promise.resolve();
  const flushWarnings = (): Promise<void> => {
    const next = warningFlush.then(async () => {
      if (promptDepth > 0 || pendingWarnings.length === 0) return;
      const restore = indicator !== null ? indicatorText : null;
      const restoreProgress = display !== null;
      pause();
      while (pendingWarnings.length > 0) {
        const warning = pendingWarnings.shift()!;
        await event({ type: 'warning', data: warning });
        if (!machine) await write(streams.stderr, `警告 [${warning.code}] ${warning.message}\n`);
      }
      if (restore !== null && !finished && !work.signal.aborted) {
        indicator = spinner({ output: streams.stderr, onCancel: pause }); indicator.start(restore);
      }
      if (restoreProgress) showProgress();
    });
    // Return the rejection to this caller while keeping later flushes usable.
    warningFlush = next.catch(() => {});
    return next;
  };
  const startPrompt = async () => { await flushWarnings(); pause(); promptDepth++; };
  const stopPrompt = async () => { promptDepth--; await flushWarnings(); };
  promptBoundaries.set(mode, { begin: startPrompt, end: stopPrompt });
  return {
    mode, signal: work.signal as AbortSignal,
    recordWarning, flushWarnings, beginPrompt: startPrompt, endPrompt: stopPrompt,
    setHome(value: string) { home = value; },
    markCanceled: cancel,
    assertActive() { if (work.signal.aborted) throw new CliError('CANCELED', '操作已取消。', 3); },
    setCommand(value: string) { command = value; },
    set(value: unknown, text: string, nextStatus?: CliResult['status']) {
      data = value; human = cleanText(text); status = nextStatus;
      if (value !== null && typeof value === 'object' && 'warnings' in value && Array.isArray(value.warnings)) for (const item of WarningSchema.array().parse(value.warnings)) recordWarning(item.code, item.message);
    },
    event,
    pauseProgress: pause,
    activity(message: string) {
      if (mode.format !== 'pretty' || mode.quiet) return;
      if (display) pause();
      indicatorText = cleanText(message);
      if (!indicator) { indicator = spinner({ output: streams.stderr, onCancel: pause }); indicator.start(cleanText(message)); }
      else indicator.message(cleanText(message));
    },
    async progress(value: ProgressData, study?: StudyDisplay) {
      await flushWarnings();
      await event({ type: 'progress', data: value });
      if (machine || mode.quiet) return;
      if (mode.format === 'pretty' && activeJob(value.status)) {
        const startedAt = live !== null && live.value.jobId === value.jobId ? live.startedAt : Date.now();
        live = { value, study, startedAt, observedAt: study?.observedAtMs ?? Date.now() };
        if (indicator) { indicator.clear(); indicator = null; }
        showProgress();
        return;
      }
      const phase = `${value.jobId}:${value.status}:${value.resourceKey ?? ''}`;
      const interval = 5000;
      if (phase === lastPhase && Date.now() - lastProgressAt < interval) return;
      lastPhase = phase; lastProgressAt = Date.now();
      const label = value.title === null ? '' : ` · ${singleLine(value.title)}`;
      const clock = value.durationSeconds !== null && value.durationSeconds > 0 && value.serverSeconds !== null ? ` · ${formatClock(value.serverSeconds)}/${formatClock(value.durationSeconds)}` : '';
      const state = value.status === 'waiting' && !study ? '等待继续' : jobStates[value.status] ?? value.status;
      const text = `${study ? singleLine(study.courseTitle) + ' · ' : ''}${state} · ${value.completed}/${value.total ?? '?'} 个资源${label}${clock}${value.serverFraction === null ? '' : ` · 服务端 ${(value.serverFraction * 100).toFixed(1)}%`}`;
      pause(); await write(streams.stderr, cleanText(text) + '\n');
    },
    async message(text: string, essential = false) { await flushWarnings(); if (!machine && (!mode.quiet || essential)) { pause(); await write(streams.stderr, cleanText(text) + '\n'); } },
    async warning(code: string, message: string) { recordWarning(code, message); await flushWarnings(); },
    async finish(error?: unknown) {
      if (finished) return;
      finished = true;
      pause();
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
      else if (mode.format === 'jsonl') await event({ type: 'result', data: result });
      else { if (human) await write(streams.stdout, human + '\n'); if (info) await write(streams.stderr, `${mode.color ? styleText(['red','bold'], '错误', {stream: process.stderr}) : '错误'} [${info.error.code}] ${info.error.message}\n`); if (result.error?.hint.length) await write(streams.stderr, result.error.hint.join('\n') + '\n'); }
      if (mode.debug && error !== undefined) await write(streams.stderr, JSON.stringify({ diagnostic: error instanceof Error ? error.name : typeof error, code: info?.error.code }) + '\n');
    },
    close() { pause(); promptBoundaries.delete(mode); commandSignals.delete(mode); progressPauses.delete(mode); streams.stdout.off('error', onError); streams.stderr.off('error', onError); },
  };
}
export type Output = ReturnType<typeof createOutput>;
const outputs = new WeakMap<Command, Output>();
export function bindOutput(program: Command, output: Output) { outputs.set(program, output); }
export function getOutput(program: Command): Output { while (program.parent) program = program.parent; const output = outputs.get(program); if (!output) throw new Error('CLI output is not initialized'); return output; }

export function formatTable(headers: string[], rows: unknown[][], width = process.stdout.isTTY ? process.stdout.columns : 0): string {
  if (rows.length === 0) return '暂无记录。';
  const cells = rows.map(row => row.map(value => cleanText(String(value ?? '未知'))));
  if (width < 80) return cells.map(row => row.map((value, i) => `${headers[i]}：${value}`).join('\n')).join('\n\n');
  const table = new Table({ head: headers, colWidths: headers.map(() => Math.floor((width - headers.length - 1) / headers.length)), wordWrap: true, wrapOnWordBoundary: false, style: { head: [], border: [] } });
  table.push(...cells);
  return table.toString();
}

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
