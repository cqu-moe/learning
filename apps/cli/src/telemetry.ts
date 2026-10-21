import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ensureDataDir } from './data-dir.js';
import { errorInfo, type Output } from './output.js';
import { JobStatusSchema, type Job } from '@learning/sdk/public';
import pkg from '../package.json' with { type: 'json' };

const POSTHOG_HOST = 'https://p.cqu.moe';
const BACKGROUND_REQUEST_TIMEOUT_MS = 500;
const FINISH_TIMEOUT_MS = 750;
const FLUSH_DELAY_MS = 100;
const MAX_EVENTS = 16;
const MAX_BODY_BYTES = 16 * 1024;
const STATE_VERSION = 1;

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
type TelemetryPropertyValue = string | number | boolean | null | string[] | undefined;
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
  jobAttempts: Map<string, { attemptId: string; startedAtMs: number; completed: boolean }>;
  flushTail: Promise<void>;
  transportAbort: AbortController | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
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

function writeFirstNotice(): void {
  try {
    process.stderr.write('learning 会发送匿名使用统计帮助改进 CLI，不采集账号、课程正文或 AI 对话内容。\n');
  } catch {
    // The notice is best-effort and must never affect command output or exit status.
  }
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
    trigger: 'user',
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
  if (controller.events.length >= MAX_EVENTS) return;
  controller.events.push({
    uuid: randomUUID(),
    event,
    distinct_id: `cli:${controller.state.installationId}`,
    timestamp: timestamp.toISOString(),
    properties,
  });
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

async function sendBatch(controller: TelemetryController, batch: TelemetryEvent[], deadline: number): Promise<void> {
  const payload = JSON.stringify({ api_key: controller.token, batch });
  if (Buffer.byteLength(payload, 'utf8') > MAX_BODY_BYTES) return;

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
  } catch {
    // Delivery is single-shot and best-effort, including background start events.
  } finally {
    clearTimeout(timer);
    if (controller.transportAbort === timeout) controller.transportAbort = null;
  }
}

async function flushQueued(controller: TelemetryController, deadline: number): Promise<void> {
  while (controller.enabled && controller.token !== null && controller.events.length > 0 && Date.now() < deadline) {
    await sendBatch(controller, takeBatch(controller), deadline);
  }
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
  }, FLUSH_DELAY_MS);
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
  };
  controllers.set(output, controller);
  if (loaded.created) writeFirstNotice();
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
  $ai_model: z.string().min(1).max(128),
  $ai_provider: z.literal('openai-compatible'),
  $ai_latency: z.number().nonnegative(),
  $ai_stream: z.literal(false),
  $ai_http_status: z.number().int().min(100).max(599).optional(),
  $ai_is_error: z.boolean(),
  $ai_error: z.enum(['network_error', 'http_error', 'response_too_large', 'response_read_error', 'invalid_json_response', 'invalid_response_structure', 'invalid_proposal_json']).optional(),
  $ai_input_tokens: countSchema.optional(),
  $ai_output_tokens: countSchema.optional(),
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
  const attempt = { attemptId: randomUUID(), startedAtMs: Date.now(), completed: false };
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
  controllers.delete(output);
  if (controller === undefined || !controller.enabled) return;

  const info = error === undefined ? null : errorInfo(error);
  const exitCode = Number(process.exitCode ?? 0);
  const properties: Record<string, TelemetryPropertyValue> = {
    ...baseProperties(controller, controller.command),
    operation_id: controller.commandOperationId,
    outcome: commandOutcome(exitCode, info?.error.code ?? null, output.signal.aborted),
    exit_code: exitCode,
    error_code: info === null ? null : safeCode(info.error.code),
    duration_ms: Math.max(0, Date.now() - controller.startedAtMs),
    duration_basis: 'cli_process',
  };
  queueEvent(controller, 'cli_command_completed', properties);
  cancelScheduledFlush(controller);
  if (controller.token === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flush(controller, FINISH_TIMEOUT_MS).catch(() => {}),
    new Promise<void>(resolve => { timer = setTimeout(resolve, FINISH_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  controller.enabled = false;
  controller.events.length = 0;
  controller.transportAbort?.abort();
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
