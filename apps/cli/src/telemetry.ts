import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ensureDataDir } from './data-dir.js';
import { CliError, errorInfo, type Output } from './output.js';
import { ErrorCodeSchema, JobStatusSchema, LearningError, type Job, type Json } from '@learning/sdk/public';
import { ModelLabelSchema } from '@learning/sdk/node';
import pkg from '../package.json' with { type: 'json' };
import { buildException } from './exception.js';
import { DiagnosticOutbox } from './diagnostic-outbox.js';

const POSTHOG_HOST = 'https://p.cqu.moe';
const BACKGROUND_REQUEST_TIMEOUT_MS = 500;
const FINISH_TIMEOUT_MS = 750;
const FLUSH_DELAY_MS = 100;
const MAX_EVENTS = 16;
const MAX_BODY_BYTES = 64 * 1024;
const STATE_VERSION = 1;
const CommandErrorCodeSchema = ErrorCodeSchema.or(z.literal('CONFIRMATION_REQUIRED'));

const TelemetryStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  installationId: z.string().uuid(),
  noticeAcknowledgedAt: z.string().min(1),
  disabled: z.boolean().optional(),
}).strict().transform(state => ({
  version: state.version,
  installationId: state.installationId,
  noticeAcknowledgedAt: state.noticeAcknowledgedAt,
}));

type TelemetryState = z.infer<typeof TelemetryStateSchema>;
type TelemetryEnvironment = 'production' | 'development' | 'test';
type TelemetryPropertyValue = Json | undefined;
type TelemetryEvent = {
  uuid: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, TelemetryPropertyValue>;
};

interface TelemetryController {
  state: TelemetryState;
  command: string;
  commandOperationId: string;
  startedAtMs: number;
  environment: TelemetryEnvironment;
  enabled: boolean;
  token: string | null;
  endpoint: URL;
  events: TelemetryEvent[];
  jobAttempts: Map<string, { attemptId: string; startedAtMs: number; completed: boolean; platform: Job['scope']['platform'] }>;
  flushTail: Promise<void>;
  transportAbort: AbortController | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  outbox: DiagnosticOutbox | null;
  seenErrors: WeakMap<object, Set<string>>;
  attempted: Set<string>;
  retryAfter: number;
  redactions: Set<string>;
  diagnosticWarnings: Set<string>;
}

const controllers = new WeakMap<Output, TelemetryController>();
const statePath = (dataDir: string) => resolve(dataDir, 'telemetry.json');
const isTruthy = (value: string | undefined) => value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
const safeCode = (value: string) => /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'UNKNOWN';
const safeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value) ? value : 'INVALID';
const safeOperation = (value: string) => /^[a-z][a-z0-9 -]{0,63}$/.test(value) ? value : 'unknown';

function runtimeFacts() {
  const bun = (globalThis as { Bun?: { version?: unknown } }).Bun;
  return {
    runtime: bun === undefined ? 'node' : 'bun',
    runtime_version: bun === undefined ? process.version : String(bun.version),
    os: process.platform,
    arch: process.arch,
  };
}

// Keep runtime opt-out/CI switches dynamic when compiling the standalone binary.
function runtimeEnv(name: string): string | undefined {
  return Reflect.get(process.env, name) as string | undefined;
}

function environment(): TelemetryEnvironment | null {
  const explicit = runtimeEnv('LEARNING_TELEMETRY_ENVIRONMENT');
  if (explicit !== undefined) {
    if (explicit !== 'production' && explicit !== 'development' && explicit !== 'test') return null;
    return explicit;
  }
  if (runtimeEnv('NODE_ENV') === 'development') return 'development';
  return 'production';
}

function automaticallyDisabled(): boolean {
  return runtimeEnv('LEARNING_TELEMETRY_ENVIRONMENT') === 'test'
    || runtimeEnv('NODE_ENV') === 'test'
    || runtimeEnv('NODE_ENV') === 'development'
    || runtimeEnv('LEARNING_TELEMETRY_ENVIRONMENT') === 'development'
    || isTruthy(runtimeEnv('CI'))
    || isTruthy(runtimeEnv('VITEST'));
}

function telemetryToken(): string | null {
  const explicit = (runtimeEnv('LEARNING_TELEMETRY_TOKEN') ?? runtimeEnv('POSTHOG_PROJECT_TOKEN'))?.trim();
  if (explicit !== undefined) return /^phc_[A-Za-z0-9_-]{20,}$/.test(explicit) ? explicit : null;
  const token = process.env.LEARNING_BUNDLED_TELEMETRY_TOKEN?.trim();
  return token !== undefined && /^phc_[A-Za-z0-9_-]{20,}$/.test(token) ? token : null;
}

function telemetryEndpoint(): URL | null {
  const configured = runtimeEnv('LEARNING_TELEMETRY_HOST');
  if (configured === undefined) return new URL('/batch', POSTHOG_HOST);
  try {
    const url = new URL(configured);
    const localTestHost = url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
    if (!localTestHost || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
    return new URL('/batch', url);
  } catch {
    return null;
  }
}

function parseState(raw: string): TelemetryState | null {
  const parsed = TelemetryStateSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

function readState(path: string): TelemetryState | null {
  try {
    return parseState(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeInitialState(dataDir: string, state: TelemetryState): void {
  ensureDataDir(dataDir);
  const descriptor = openSync(statePath(dataDir), 'wx', 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(state)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function loadOrCreateState(dataDir: string): { state: TelemetryState; created: boolean } | null {
  const path = statePath(dataDir);
  if (existsSync(path)) {
    const state = readState(path);
    if (state !== null) chmodSync(path, 0o600);
    return state === null ? null : { state, created: false };
  }

  const state: TelemetryState = {
    version: STATE_VERSION,
    installationId: randomUUID(),
    noticeAcknowledgedAt: new Date().toISOString(),
  };
  try {
    writeInitialState(dataDir, state);
  } catch {
    return null;
  }
  return { state, created: true };
}

function writeFirstNotice(output: Output): void {
  output.recordWarning('TELEMETRY_NOTICE', 'learning 会发送匿名使用统计及脱敏错误诊断（含堆栈），不采集凭据、课程正文或 AI 对话内容。');
}

function diagnosticWarning(controller: TelemetryController, code: string, message: string): void {
  if (controller.diagnosticWarnings.has(code)) return;
  controller.diagnosticWarnings.add(code);
  try { process.stderr.write(JSON.stringify({ schemaVersion: 1, type: 'warning', data: { code, message } }) + '\n'); } catch { /* Keep the original result. */ }
}

function reportDropped(controller: TelemetryController): void {
  if ((controller.outbox?.droppedCount ?? 0) > 0) diagnosticWarning(controller, 'DIAGNOSTICS_DROPPED', `部分诊断暂存已因保留期限、容量限制或损坏而清理（当前 ${controller.outbox!.droppedCount} 条）。`);
}

function baseProperties(controller: TelemetryController, operation: string): Record<string, TelemetryPropertyValue> {
  return {
    $geoip_disable: true,
    $process_person_profile: false,
    telemetry_version: 2,
    product: 'learning',
    surface: 'cli',
    environment: controller.environment,
    release: pkg.version,
    cli_version: pkg.version,
    actor_type: 'installation',
    trigger: 'agent',
    operation: safeOperation(operation),
    is_test: controller.environment !== 'production' || isTruthy(runtimeEnv('LEARNING_TELEMETRY_IS_TEST')),
    ...runtimeFacts(),
  };
}

function queueEvent(
  controller: TelemetryController,
  event: string,
  properties: Record<string, TelemetryPropertyValue>,
  timestamp = new Date(),
): void {
  const queued = {
    uuid: randomUUID(),
    event,
    distinct_id: `cli:${controller.state.installationId}`,
    timestamp: timestamp.toISOString(),
    properties,
  };
  let persisted = false;
  if (event === '$exception') {
    try { if (controller.outbox !== null) { controller.outbox.add(queued); persisted = true; } }
    catch { diagnosticWarning(controller, 'DIAGNOSTICS_STORAGE', '诊断暂存失败，本次将尝试直接发送。'); }
    reportDropped(controller);
  }
  if (controller.events.length < MAX_EVENTS || event === '$exception' && !persisted && controller.events.length < 256) controller.events.push(queued);
  else if (event === '$exception' && !persisted) diagnosticWarning(controller, 'DIAGNOSTICS_DROPPED', '诊断暂存不可用且内存队列已满，一条错误诊断未能保留。');
  scheduleFlush(controller);
}

function batchBytes(events: TelemetryEvent[], token: string): number {
  return Buffer.byteLength(JSON.stringify({ api_key: token, batch: events }), 'utf8');
}

function takeBatch(controller: TelemetryController): TelemetryEvent[] {
  const batch = controller.events.splice(0, MAX_EVENTS);
  while (batch.length > 1 && batchBytes(batch, controller.token!) > MAX_BODY_BYTES) {
    controller.events.unshift(batch.pop()!);
  }
  return batch;
}

async function sendBatch(controller: TelemetryController, batch: TelemetryEvent[], deadline: number): Promise<boolean> {
  const payload = JSON.stringify({ api_key: controller.token, batch });
  if (Buffer.byteLength(payload, 'utf8') > MAX_BODY_BYTES) return false;

  const timeout = new AbortController();
  controller.transportAbort = timeout;
  const timer = setTimeout(() => timeout.abort(), Math.max(0, deadline - Date.now()));
  try {
    const response = await fetch(new Request(controller.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: timeout.signal,
    }));
    if (response.body !== null) await response.body.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (controller.transportAbort === timeout) controller.transportAbort = null;
  }
}

async function flushQueued(controller: TelemetryController, deadline: number): Promise<void> {
  while (controller.enabled && controller.token !== null && Date.now() < deadline && Date.now() >= controller.retryAfter) {
    try {
      const queued = new Set(controller.events.map(event => event.uuid));
      for (const event of controller.outbox?.pending(256) ?? []) {
        if (controller.events.length >= MAX_EVENTS) break;
        if (!queued.has(event.uuid) && !controller.attempted.has(event.uuid)) controller.events.push(event);
      }
      reportDropped(controller);
    } catch { diagnosticWarning(controller, 'DIAGNOSTICS_STORAGE', '无法读取诊断暂存，其他操作继续。'); }
    if (controller.events.length === 0) break;
    const batch = takeBatch(controller);
    for (const event of batch) if (event.event === '$exception') controller.attempted.add(event.uuid);
    if (!await sendBatch(controller, batch, deadline)) {
      for (const event of batch) controller.attempted.delete(event.uuid);
      controller.retryAfter = Date.now() + 60_000;
      scheduleFlush(controller);
      break;
    }
    for (const event of batch) if (event.event === '$exception') {
      try { controller.outbox?.acknowledge(event.uuid); controller.attempted.delete(event.uuid); }
      catch { diagnosticWarning(controller, 'DIAGNOSTICS_STORAGE', '诊断已发送，但暂存清理失败，后续可能按同一事件 ID 重传。'); }
    }
  }
  try {
    if (controller.events.length > 0 || controller.outbox?.pending(256).some(event => !controller.attempted.has(event.uuid))) scheduleFlush(controller);
  } catch { diagnosticWarning(controller, 'DIAGNOSTICS_STORAGE', '无法读取诊断暂存，其他操作继续。'); }
}

function flush(controller: TelemetryController, timeoutMs: number): Promise<void> {
  const operation = controller.flushTail.then(() => flushQueued(controller, Date.now() + timeoutMs));
  controller.flushTail = operation.catch(() => {});
  return operation;
}

function scheduleFlush(controller: TelemetryController): void {
  if (!controller.enabled || controller.token === null || controller.flushTimer !== null) return;
  // Short commands send start and outcome together; slow commands still expose
  // their start without waiting for completion or holding business output.
  controller.flushTimer = setTimeout(() => {
    controller.flushTimer = null;
    void flush(controller, BACKGROUND_REQUEST_TIMEOUT_MS).catch(() => {});
  }, Math.max(FLUSH_DELAY_MS, controller.retryAfter - Date.now()));
  controller.flushTimer.unref();
}

function cancelScheduledFlush(controller: TelemetryController): void {
  if (controller.flushTimer !== null) clearTimeout(controller.flushTimer);
  controller.flushTimer = null;
}

function commandOutcome(exitCode: number, errorCode: string | null, canceled: boolean): TelemetryPropertyValue {
  if (canceled || errorCode === 'CANCELED') return 'canceled';
  if (exitCode === 0) return 'success';
  if (exitCode === 4) return 'partial';
  if (exitCode === 5) return 'unverified';
  if (exitCode === 3) return 'needs_input';
  return 'failure';
}

export async function startTelemetry(output: Output, dataDir: string, command: string): Promise<void> {
  if (controllers.has(output) || automaticallyDisabled()) return;
  const resolvedEnvironment = environment();
  const token = telemetryToken();
  const endpoint = telemetryEndpoint();
  if (resolvedEnvironment === null || endpoint === null) return;

  const loaded = loadOrCreateState(dataDir);
  if (loaded === null) return;
  let outbox: DiagnosticOutbox | null = null;
  try { if (token !== null) outbox = new DiagnosticOutbox(dataDir, `${endpoint.href}:${token}`); }
  catch { output.recordWarning('DIAGNOSTICS_STORAGE', '无法建立诊断暂存，本次将尝试直接发送。'); }
  const controller: TelemetryController = {
    state: loaded.state,
    command,
    commandOperationId: randomUUID(),
    startedAtMs: Date.now(),
    environment: resolvedEnvironment,
    enabled: true,
    token,
    endpoint,
    events: [],
    jobAttempts: new Map(),
    flushTail: Promise.resolve(),
    transportAbort: null,
    flushTimer: null,
    outbox,
    seenErrors: new WeakMap(),
    attempted: new Set(),
    retryAfter: 0,
    redactions: new Set(),
    diagnosticWarnings: new Set(),
  };
  controllers.set(output, controller);
  if (loaded.created) writeFirstNotice(output);
  queueEvent(controller, 'cli_command_started', {
    ...baseProperties(controller, command),
    operation_id: controller.commandOperationId,
    duration_basis: 'cli_process',
  });
}

const countSchema = z.number().int().nonnegative();
const resultProperties = z.object({ result_type: z.enum(['receipt', 'job']) }).strict();
const draftProperties = z.object({ question_count: countSchema }).strict();
const workflowProperties = {
  learning_run_completed: z.object({ status: JobStatusSchema, scope: z.enum(['course', 'resource']), resource_count: countSchema, skipped_resource_count: countSchema, speed: z.number().positive(), target_fraction: z.number().min(0).max(1) }).strict(),
  download_completed: z.object({ job_statuses: z.array(JobStatusSchema), exported_file_count: countSchema, media_count: countSchema, assessment_count: countSchema }).strict(),
  homework_draft_created: draftProperties,
  homework_answers_submitted: z.object({ answer_count: countSchema }).strict(),
  exam_draft_created: draftProperties,
  exam_answers_saved: resultProperties,
  exam_started: resultProperties,
  exam_submitted: resultProperties,
  discussion_draft_created: z.object({ used_ai_suggestion: z.boolean() }).strict(),
  discussion_posted: resultProperties,
  login_completed: z.object({ method: z.enum(['cookie_import', 'qr']), variant: z.enum(['default', 'native']).optional() }).strict(),
  live_session_completed: z.object({ status: JobStatusSchema }).strict(),
};

export function trackWorkflowEvent(output: Output, capture: { event: keyof typeof workflowProperties; properties: unknown }): void {
  const controller = controllers.get(output);
  if (controller === undefined || !controller.enabled) return;
  const parsed = workflowProperties[capture.event]?.safeParse(capture.properties);
  if (!parsed?.success) return;
  queueEvent(controller, capture.event, {
    ...baseProperties(controller, controller.command),
    operation_id: controller.commandOperationId,
    ...parsed.data,
  });
}

const AiGenerationSchema = z.object({
  $ai_trace_id: z.uuid(),
  $ai_session_id: z.uuid().nullable(),
  $ai_span_id: z.uuid(),
  $ai_span_name: z.enum(['model_answers_proposal', 'model_discussion_proposal']),
  $ai_model: ModelLabelSchema.catch('custom'),
  $ai_provider: z.literal('openai-compatible'),
  $ai_latency: z.number().nonnegative(),
  $ai_stream: z.literal(false),
  $ai_http_status: z.number().int().min(100).max(599).optional(),
  $ai_is_error: z.boolean(),
  $ai_error: z.enum(['network_error', 'http_error', 'response_too_large', 'response_read_error', 'invalid_json_response', 'invalid_response_structure', 'invalid_proposal_json', 'canceled']).optional(),
  $ai_input_tokens: countSchema.optional().catch(undefined),
  $ai_output_tokens: countSchema.optional().catch(undefined),
});

export function trackAiGeneration(output: Output, properties: unknown): void {
  const controller = controllers.get(output);
  if (controller === undefined || !controller.enabled) return;
  const parsed = AiGenerationSchema.safeParse(properties);
  if (!parsed.success) return;
  queueEvent(controller, '$ai_generation', {
    ...baseProperties(controller, controller.command),
    operation_id: controller.commandOperationId,
    ...parsed.data,
  });
}

export function trackJobStarted(output: Output, job: Job, options: { newAttempt?: boolean } = {}): void {
  const controller = controllers.get(output);
  if (controller === undefined || !controller.enabled) return;
  const existing = controller.jobAttempts.get(job.id);
  if (existing !== undefined && (!existing.completed || !options.newAttempt)) return;
  const attempt = { attemptId: randomUUID(), startedAtMs: Date.now(), completed: false, platform: job.scope.platform };
  controller.jobAttempts.set(job.id, attempt);
  queueEvent(controller, 'learning_job_started', {
    ...baseProperties(controller, job.kind),
    operation_id: safeId(job.id),
    attempt_id: attempt.attemptId,
    platform: job.scope.platform,
    job_kind: job.kind,
    job_id: safeId(job.id),
    total_count: job.total,
    duration_basis: 'foreground_attempt',
  });
}

function jobOutcome(job: Job, canceled: boolean): TelemetryPropertyValue | null {
  if (job.status === 'succeeded') {
    return job.warnings.some(warning => warning.code === 'SKIPPED_UNKNOWN_DURATION') ? 'partial' : 'success';
  }
  if (job.status === 'partial') return 'partial';
  if (job.status === 'needs-input') return 'needs_input';
  if (job.status === 'uncertain') return 'unverified';
  if (job.status === 'failed') return 'failure';
  if (job.status === 'canceled') return 'canceled';
  if (job.status === 'paused' && canceled) return 'canceled';
  return null;
}

export function trackJobCompleted(output: Output, job: Job, options: { canceled?: boolean } = {}): void {
  const controller = controllers.get(output);
  if (controller === undefined || !controller.enabled) return;
  const attempt = controller.jobAttempts.get(job.id);
  if (attempt === undefined || attempt.completed) return;
  const outcome = jobOutcome(job, options.canceled === true);
  if (outcome === null) return;

  attempt.completed = true;
  const properties: Record<string, TelemetryPropertyValue> = {
    ...baseProperties(controller, job.kind),
    operation_id: safeId(job.id),
    attempt_id: attempt.attemptId,
    platform: job.scope.platform,
    job_kind: job.kind,
    job_id: safeId(job.id),
    outcome,
    total_count: job.total,
    completed_count: job.completed,
    succeeded_count: job.items.filter(item => item.state === 'succeeded').length,
    failed_count: job.items.filter(item => item.state === 'failed').length,
    skipped_count: job.items.filter(item => item.state === 'skipped').length,
    needs_input_count: job.items.filter(item => item.state === 'needs-input').length,
    uncertain_count: job.items.filter(item => item.state === 'uncertain').length,
    artifact_count: job.items.reduce((count, item) => count + item.artifacts.length, 0),
    warning_codes: [...new Set(job.warnings.map(warning => safeCode(warning.code)))].slice(0, 8),
    duration_basis: 'foreground_attempt',
  };
  properties.duration_ms = Math.max(0, Date.now() - attempt.startedAtMs);
  queueEvent(controller, 'learning_job_completed', properties);
}

export async function finishTelemetry(output: Output, error?: unknown): Promise<void> {
  const controller = controllers.get(output);
  if (controller === undefined || !controller.enabled) return;

  const info = error === undefined ? null : errorInfo(error);
  const errorCode = info === null ? null : CommandErrorCodeSchema.safeParse(info.error.code).data ?? 'INTERNAL';
  const exitCode = Number(process.exitCode ?? 0);
  const properties: Record<string, TelemetryPropertyValue> = {
    ...baseProperties(controller, controller.command),
    operation_id: controller.commandOperationId,
    outcome: commandOutcome(exitCode, info?.error.code ?? null, output.signal.aborted),
    exit_code: exitCode,
    error_code: errorCode,
    duration_ms: Math.max(0, Date.now() - controller.startedAtMs),
    duration_basis: 'cli_process',
  };
  if (controller.outbox?.droppedCount) properties.diagnostic_dropped_count = controller.outbox.droppedCount;
  queueEvent(controller, 'cli_command_completed', properties);
  if (error !== undefined) trackException(output, error, { stage: 'command' });
  controllers.delete(output);
  cancelScheduledFlush(controller);
  if (controller.token === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flush(controller, FINISH_TIMEOUT_MS).catch(() => {}),
    new Promise<void>(resolve => { timer = setTimeout(resolve, FINISH_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  cancelScheduledFlush(controller);
  controller.enabled = false;
  controller.events.length = 0;
  controller.transportAbort?.abort();
}

export function trackException(output: Output, error: unknown, context: Record<string, string | number | boolean | null> = {}, handled = true): void {
  const controller = controllers.get(output);
  if (controller === undefined || !controller.enabled) return;
  try {
    const info = errorInfo(error);
    const explicitlyCanceled = error instanceof CliError && error.code === 'CANCELED' || error instanceof LearningError && error.data.code === 'CANCELED';
    if (explicitlyCanceled || handled && output.signal.aborted && error instanceof Error && error.name === 'AbortError') return;
    const chain: object[] = [];
    const occurrence = !handled ? 'unhandled' : context.attempt_id === undefined ? undefined : String(context.attempt_id);
    let current = error;
    while (current !== null && typeof current === 'object' && !chain.includes(current) && chain.length < 16) {
      const seen = controller.seenErrors.get(current);
      if (seen !== undefined && (occurrence === undefined || seen.has(occurrence))) return;
      chain.push(current);
      current = current instanceof Error ? current.cause : undefined;
    }
    for (const item of chain) {
      const seen = controller.seenErrors.get(item) ?? new Set<string>();
      seen.add(occurrence ?? 'handled');
      controller.seenErrors.set(item, seen);
    }
    const secrets = [...controller.redactions, ...Object.entries(process.env).filter(([key, value]) => value && /(?:key|token|password|secret|cookie)/i.test(key)).map(([, value]) => value!)];
    const activeJobs = [...controller.jobAttempts].filter(([id, attempt]) => context.job_id === id || context.job_id === undefined && !attempt.completed);
    const activeJob = activeJobs.length === 1 ? activeJobs[0] : undefined;
    const errorCode = CommandErrorCodeSchema.safeParse(context.code).data ?? (info.error.code === 'CANCELED' ? 'INTERNAL' : CommandErrorCodeSchema.safeParse(info.error.code).data) ?? 'INTERNAL';
    const diagnosticContext: Record<string, string | number | boolean | null> = { ...context, code: errorCode };
    if (typeof context.resource_key === 'string') diagnosticContext.resource_key_hash = createHash('sha256').update(context.resource_key).digest('hex').slice(0, 24);
    delete diagnosticContext.resource_key;
    queueEvent(controller, '$exception', {
      ...baseProperties(controller, controller.command),
      operation_id: controller.commandOperationId,
      ...(activeJob === undefined ? {} : { job_id: safeId(activeJob[0]), attempt_id: activeJob[1].attemptId, platform: activeJob[1].platform }),
      error_code: errorCode,
      $exception_level: 'error',
      ...buildException(error, { handled, context: diagnosticContext, secrets }),
    });
  } catch {
    // Diagnostic failures must not change the original command or recurse into themselves.
    diagnosticWarning(controller, 'DIAGNOSTICS_CAPTURE', '无法记录一条错误诊断，原操作结果保留。');
  }
}

export function redactDiagnosticValues(output: Output, values: readonly string[]): void {
  const controller = controllers.get(output);
  if (controller !== undefined) for (const value of values) if (value) controller.redactions.add(value);
}

export function telemetryStatus(dataDir: string): {
  enabled: boolean;
  reason: 'automatic' | 'configuration' | 'active';
  tokenConfigured: boolean;
} {
  const state = readState(statePath(dataDir));
  const tokenConfigured = telemetryToken() !== null;
  if (automaticallyDisabled()) return { enabled: false, reason: 'automatic', tokenConfigured };
  if (!tokenConfigured || (state === null && existsSync(statePath(dataDir))) || environment() === null || telemetryEndpoint() === null) return { enabled: false, reason: 'configuration', tokenConfigured };
  return { enabled: true, reason: 'active', tokenConfigured };
}
