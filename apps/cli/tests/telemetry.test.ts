import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLearningClient } from '@learning/sdk';
import { SqliteStateStore } from '@learning/sdk/node';
import { JobRunner } from '../../../packages/sdk/src/services/jobs.js';
import { CliError, createOutput } from '../src/output.js';
import { createCliRuntime } from '../src/runtime.js';
import { runJobForeground } from '../src/foreground.js';
import { finishTelemetry, startTelemetry, trackWorkflowEvent, trackAiGeneration, trackException } from '../src/telemetry.js';
import pkg from '../package.json' with { type: 'json' };

const cliEntry = resolve(import.meta.dirname, '../dist/index.js');
const tempRoots: string[] = [];
const originalEnv = { ...process.env };
const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });

type TelemetryEvent = {
  uuid?: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
};
type TelemetryPayload = { api_key: string; batch: TelemetryEvent[] };
type CapturedRequest = { url: string; method: string; contentType: string; raw: string; body: TelemetryPayload };

let server: Server;
const requests: CapturedRequest[] = [];
let baseUrl = '';
let holdNextRequest = false;
let heldResponse: ServerResponse | null = null;
let responseStatus = 200;

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const raw = (request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString();
      let body: TelemetryPayload = { api_key: 'unknown', batch: [] };
      try {
        const parsed = JSON.parse(raw) as Partial<TelemetryPayload>;
        if (typeof parsed.api_key === 'string' && Array.isArray(parsed.batch)) body = parsed as TelemetryPayload;
      } catch { /* Record unexpected protocols too, so a second channel cannot evade assertions. */ }
      requests.push({ url: request.url ?? '', method: request.method ?? '', contentType: String(request.headers['content-type'] ?? ''), raw, body });
      if (holdNextRequest) {
        holdNextRequest = false;
        heldResponse = response;
        return;
      }
      response.writeHead(responseStatus, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolveListen, rejectListen) => server.once('error', rejectListen).listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      rejectListen(new Error('telemetry test server did not bind a port'));
      return;
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    resolveListen();
  }));
}

function releaseHeldRequest(): void {
  const response = heldResponse;
  heldResponse = null;
  if (response === null) return;
  try {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  } catch {
    // A telemetry opt-out may already have aborted this socket.
  }
}

async function waitForRequests(count: number): Promise<[CapturedRequest]> {
  const deadline = Date.now() + 2000;
  while (requests.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} telemetry requests, received ${requests.length}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  return [requests[count - 1]!];
}

function freshHome(prefix: string): string {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

function userEnv(home: string, options: { telemetry?: boolean; token?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    TERM: process.env.TERM,
    LEARNING_HOME: home,
    CI: '0',
    VITEST: '0',
    NODE_ENV: 'production',
    DO_NOT_TRACK: '0',
    LEARNING_TELEMETRY_DISABLED: '0',
    LEARNING_TELEMETRY_ENVIRONMENT: 'production',
  };
  if (options.telemetry !== false) {
    env.LEARNING_TELEMETRY_TOKEN = options.token ?? 'phc_public_fixture_token_1234567890abcdef';
    env.LEARNING_TELEMETRY_HOST = baseUrl;
  }
  return env;
}

async function waitForTokenPayloads(apiKey: string, count: number): Promise<CapturedRequest[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const payloads = requests.filter(candidate => candidate.body.api_key === apiKey);
    if (payloads.flatMap(payload => payload.body.batch).length >= count) return payloads;
    if (Date.now() > deadline) throw new Error(`expected ${count} telemetry requests, received ${payloads.length}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

async function waitForTokenEvents(apiKey: string, predicate: (events: TelemetryEvent[]) => boolean): Promise<TelemetryEvent[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const events = requests.filter(candidate => candidate.body.api_key === apiKey).flatMap(candidate => candidate.body.batch);
    if (predicate(events)) return events;
    if (Date.now() > deadline) throw new Error(`expected telemetry events, received ${events.length}: ${events.map(event => event.event).join(', ')}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

async function runUserCli(args: string[], home: string, env = userEnv(home)) {
  return runChild([cliEntry, ...args, '--home', home, '--json'], env);
}

async function runChild(args: string[], env: NodeJS.ProcessEnv) {
  // Keep the fixture server responsive while the real CLI sends and exits.
  const child = spawn(process.execPath, args, {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  return { status, stdout, stderr };
}

beforeAll(async () => {
  await startServer();
});

beforeEach(async () => {
  // Let a previous child process's final response handler finish before changing fixture controls.
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  requests.length = 0;
  holdNextRequest = false;
  responseStatus = 200;
  releaseHeldRequest();
});

afterAll(async () => {
  process.env = originalEnv;
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  for (const path of tempRoots) rmSync(path, { recursive: true, force: true });
});

describe('cli telemetry lifecycle', () => {
  it('is default-on, notices once in the structured result, and sends only allowlisted command facts', async () => {
    const home = freshHome('learning-telemetry-live-');
    const first = await runUserCli(['init'], home);
    expect(first.status).toBe(0);
    expect(existsSync(resolve(home, 'telemetry.json')), `test endpoint ${baseUrl}`).toBe(true);
    expect(first.stderr).toBe('');
    expect(JSON.parse(first.stdout).warnings.filter((warning: { code: string }) => warning.code === 'TELEMETRY_NOTICE')).toHaveLength(1);
    expect(first.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(first.stdout)).toMatchObject({ command: 'init', ok: true, exitCode: 0 });
    expect(statSync(resolve(home, 'telemetry.json')).mode & 0o777).toBe(0o600);

    const payloads = await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 2);
    for (const payload of payloads) {
      expect(payload.url).toBe('/batch');
      expect(payload.body.api_key).toBe('phc_public_fixture_token_1234567890abcdef');
    }
    expect(payloads.flatMap(payload => payload.body.batch.map(event => event.event))).toEqual(['cli_command_started', 'cli_command_completed']);
    expect(new Set(payloads.flatMap(payload => payload.body.batch.map(event => event.uuid))).size).toBe(2);
    for (const uuid of payloads.flatMap(payload => payload.body.batch.map(event => event.uuid))) {
      expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    }
    const events = payloads.flatMap(item => item.body.batch);
    const distinctIds = new Set(events.map(event => event.distinct_id));
    expect(distinctIds.size).toBe(1);
    expect([...distinctIds][0]).toMatch(/^cli:[0-9a-f-]{36}$/);
    expect(new Set(events.map(event => event.properties.operation_id)).size).toBe(1);

    const commonKeys = [
      '$geoip_disable', '$process_person_profile',
      'actor_type', 'arch', 'cli_version', 'duration_basis', 'environment', 'is_test', 'operation',
      'operation_id', 'os', 'product', 'release', 'runtime', 'runtime_version', 'surface',
      'telemetry_version', 'trigger',
    ];
    const completed = events.find(event => event.event === 'cli_command_completed')!.properties;
    expect(Object.keys(completed).sort()).toEqual([...commonKeys, 'duration_ms', 'error_code', 'exit_code', 'outcome'].sort());
    expect(completed).toMatchObject({
      telemetry_version: 2,
      product: 'learning',
      surface: 'cli',
      environment: 'production',
      release: pkg.version,
      actor_type: 'installation',
      trigger: 'agent',
      operation: 'init',
      operation_id: events.find(event => event.event === 'cli_command_started')!.properties.operation_id,
      outcome: 'success',
      exit_code: 0,
      error_code: null,
      is_test: false,
      duration_basis: 'cli_process',
    });
    expect(JSON.stringify(payloads)).not.toContain(home);

    const second = await runUserCli(['init'], home);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 4);
  });

  it('keeps a failing command result and exit code unchanged without uploading its argument', async () => {
    const home = freshHome('learning-telemetry-sensitive-');
    const token = 'phc_sensitive_fixture_token_1234567890abcdef';
    expect((await runUserCli(['init'], home, userEnv(home, { token }))).status).toBe(0);
    await waitForTokenPayloads(token, 2);
    const failed = await runUserCli(['jobs', 'show', 'SECRET_JOB_ARGUMENT'], home, userEnv(home, { token }));
    expect(failed.status).toBe(2);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, exitCode: 2, error: { code: 'INVALID_INPUT' } });
    const payloads = await waitForTokenPayloads(token, 4);
    const completed = payloads.flatMap(payload => payload.body.batch).find(event => event.event === 'cli_command_completed' && event.properties.operation === 'jobs show')!.properties;
    expect(completed).toMatchObject({ operation: 'jobs show', outcome: 'failure', exit_code: 2, error_code: 'INVALID_INPUT' });
    expect(JSON.stringify(payloads)).not.toContain('SECRET_JOB_ARGUMENT');
    expect(JSON.stringify(payloads)).not.toContain(home);
  });

  it('captures confirmation-required errors while preserving the needs-input outcome', async () => {
    const home = freshHome('learning-telemetry-confirmation-');
    const setup = { ...userEnv(home), CI: '1' };
    expect((await runUserCli(['init'], home, setup)).status).toBe(0);
    expect((await runUserCli(['profile', 'add', 'SECRET_PROFILE', '--platform', 'ykt'], home, setup)).status).toBe(0);

    const result = await runUserCli(['profile', 'remove', 'SECRET_PROFILE'], home);
    expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 3, error: { code: 'CONFIRMATION_REQUIRED' } });
    const events = requests.flatMap(request => request.body.batch);
    expect(events.map(event => event.event)).toEqual(['cli_command_started', 'cli_command_completed', '$exception']);
    expect(events[1]!.properties).toMatchObject({
      operation: 'profile remove', outcome: 'needs_input', exit_code: 3, error_code: 'CONFIRMATION_REQUIRED',
    });
    expect(events[2]!.properties.error_code).toBe('CONFIRMATION_REQUIRED');
    expect(JSON.stringify(requests)).not.toContain('SECRET_PROFILE');
    expect(JSON.stringify(requests)).not.toContain(home);
  });

  it('writes business output before a held telemetry request completes', async () => {
    const home = freshHome('learning-telemetry-observed-start-');
    const token = 'phc_start_observability_fixture_token_123456789';
    const env = userEnv(home, { token });
    holdNextRequest = true;
    const child = spawn(process.execPath, [cliEntry, 'init', '--home', home, '--json'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit));

    const [startPayload] = await waitForRequests(1);
    const stdoutDeadline = Date.now() + 2000;
    while (stdout.length === 0 && Date.now() < stdoutDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    expect(startPayload.body.api_key).toBe(token);
    expect(startPayload.body.batch[0]!.event).toBe('cli_command_started');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ command: 'init', ok: true, exitCode: 0 });
    expect(JSON.parse(stdout).warnings).toContainEqual(expect.objectContaining({ code: 'TELEMETRY_NOTICE' }));
    expect(stderr).toBe('');
    expect(child.exitCode).toBeNull();

    releaseHeldRequest();
    expect(await exited).toBe(0);
    const events = (await waitForTokenPayloads(token, 2)).flatMap(payload => payload.body.batch);
    expect(events.map(event => event.event)).toEqual(['cli_command_started', 'cli_command_completed']);
    expect(events[1]!.properties.operation_id).toBe(events[0]!.properties.operation_id);
    expect(new Set(events.map(event => event.uuid)).size).toBe(2);
  });

  it('coalesces a command that finishes before the background flush', async () => {
    const home = freshHome('learning-telemetry-coalesced-');
    const token = 'phc_coalesced_fixture_token_123456789abcdef';
    const previousEnv = process.env;
    process.env = userEnv(home, { token });
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      // No disk-backed init or subprocess startup between start and finish: those
      // can exceed the batching interval on a loaded runner.
      await startTelemetry(output, home, 'jobs list');
      await finishTelemetry(output);
      const payloads = await waitForTokenPayloads(token, 2);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.body.batch.map(event => event.event)).toEqual(['cli_command_started', 'cli_command_completed']);
    } finally {
      await finishTelemetry(output);
      output.close();
      process.env = previousEnv;
    }
  });

  it('still delivers the start of a long-running command before its outcome', async () => {
    const home = freshHome('learning-telemetry-long-command-');
    const token = 'phc_long_command_fixture_token_123456789';
    const previousEnv = process.env;
    process.env = userEnv(home, { token });
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      await startTelemetry(output, home, 'jobs resume');
      const payloads = await waitForTokenPayloads(token, 1);
      expect(payloads.flatMap(payload => payload.body.batch.map(event => event.event))).toEqual(['cli_command_started']);
      await finishTelemetry(output);
      const finished = await waitForTokenPayloads(token, 2);
      expect(finished.flatMap(payload => payload.body.batch.map(event => event.event))).toEqual(['cli_command_started', 'cli_command_completed']);
    } finally {
      await finishTelemetry(output);
      output.close();
      process.env = previousEnv;
    }
  });

  it('keeps command result and exit code unchanged when sending fails', async () => {
    const home = freshHome('learning-telemetry-network-');
    const env = userEnv(home);
    env.LEARNING_TELEMETRY_HOST = 'http://127.0.0.1:9';
    const before = requests.length;
    const failed = await runUserCli(['init'], home, env);
    expect(failed.status).toBe(0);
    expect(failed.stderr).toBe('');
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: true, exitCode: 0, warnings: expect.arrayContaining([expect.objectContaining({ code: 'TELEMETRY_NOTICE' })]) });
    expect(requests).toHaveLength(before);
  });

  it('works with no token configured and still creates only the local installation state', async () => {
    const home = freshHome('learning-telemetry-no-token-');
    const before = requests.length;
    const first = await runUserCli(['init'], home, userEnv(home, { telemetry: false }));
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');
    expect(existsSync(resolve(home, 'telemetry.json'))).toBe(true);
    expect((await runUserCli(['init'], home, userEnv(home, { telemetry: false }))).stderr).toBe('');
    expect(requests).toHaveLength(before);
  });

  it('keeps legacy installation identity but removes persistent and environment switches', async () => {
    const home = freshHome('learning-telemetry-legacy-');
    const installationId = 'e30c4117-1a12-4f2c-88fd-93d0b9ee9471';
    writeFileSync(resolve(home, 'telemetry.json'), JSON.stringify({ version: 1, installationId, noticeAcknowledgedAt: '2026-10-21', disabled: true }));
    const env = { ...userEnv(home), LEARNING_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
    expect((await runUserCli(['init'], home, env)).status).toBe(0);
    const events = (await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 2)).flatMap(payload => payload.body.batch);
    expect(events.every(event => event.distinct_id === `cli:${installationId}`)).toBe(true);
    for (const command of ['off', 'on']) {
      expect((await runUserCli(['telemetry', command], home, env)).status).toBe(2);
    }
    const help = await runUserCli(['telemetry', '--help'], home, env);
    expect(help.stdout).not.toContain('持久关闭');
    expect(help.stdout).not.toContain('持久开启');
    const status = await runUserCli(['telemetry', 'status'], home, env);
    expect(JSON.parse(status.stdout).data).toEqual({ enabled: true, reason: 'active', tokenConfigured: true });
  });

  it('batches workflow and content-free AI facts under the existing anonymous identity', async () => {
    const home = freshHome('learning-telemetry-workflows-');
    const previousEnv = process.env;
    const token = 'phc_workflow_fixture_token_1234567890abcdef';
    process.env = userEnv(home, { token });
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      await startTelemetry(output, home, 'discuss draft');
      trackWorkflowEvent(output, { event: 'discussion_draft_created', properties: { used_ai_suggestion: true } });
      const invalid = { event: 'homework_draft_created' as const, properties: { question_count: -1, title: 'SECRET_COURSE' } };
      trackWorkflowEvent(output, invalid);
      trackAiGeneration(output, {
        $ai_trace_id: 'c22fbe3a-fbe2-4a4e-a7ea-69aa08b3c67f',
        $ai_session_id: 'e30c4117-1a12-4f2c-88fd-93d0b9ee9471',
        $ai_span_id: 'a19b3772-5577-4c96-bd05-576f24490946',
        $ai_span_name: 'model_discussion_proposal', $ai_model: 'https://SECRET_ENDPOINT.test/model',
        $ai_provider: 'openai-compatible', $ai_latency: 0.5, $ai_stream: false,
        $ai_http_status: 200, $ai_is_error: true, $ai_error: 'canceled',
        $ai_input_tokens: -1, $ai_output_tokens: 7,
        $ai_input: 'SECRET_PROMPT', $ai_output_choices: 'SECRET_ANSWER',
        $ai_request_url: 'https://SECRET_ENDPOINT.test/v1',
      });
      await finishTelemetry(output);
      const events = await waitForTokenEvents(token, events => events.some(event => event.event === 'cli_command_completed'));
      expect(events.map(event => event.event)).toEqual(['cli_command_started', 'discussion_draft_created', '$ai_generation', 'cli_command_completed']);
      expect(new Set(events.map(event => event.distinct_id)).size).toBe(1);
      expect(events.every(event => event.properties.product === 'learning' && event.properties.surface === 'cli')).toBe(true);
      expect(events.find(event => event.event === '$ai_generation')!.properties).toMatchObject({ $ai_latency: 0.5, $ai_model: 'custom', $ai_is_error: true, $ai_error: 'canceled', $ai_output_tokens: 7 });
      expect(events.find(event => event.event === '$ai_generation')!.properties).not.toHaveProperty('$ai_input_tokens');
      expect(JSON.stringify(events)).not.toContain('SECRET_');
      expect(JSON.stringify(events)).not.toContain(home);
    } finally {
      process.env = previousEnv;
      output.close();
    }
  });

  it('is automatically disabled by CI and does not run for help or version', async () => {
    const before = requests.length;
    for (const overrides of [{ CI: '1' }, { VITEST: '1' }, { NODE_ENV: 'test' }, { NODE_ENV: 'development' }]) {
      const ciHome = freshHome('learning-telemetry-ci-');
      const disabled = await runUserCli(['init'], ciHome, { ...userEnv(ciHome), ...overrides });
      expect(disabled.status).toBe(0);
      expect(disabled.stderr).toBe('');
      expect(existsSync(resolve(ciHome, 'telemetry.json'))).toBe(false);
    }
    expect(requests).toHaveLength(before);

    const helpHome = freshHome('learning-telemetry-help-');
    for (const args of [['--help'], ['--version']]) {
      const result = await runUserCli(args, helpHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
    expect(existsSync(resolve(helpHome, 'telemetry.json'))).toBe(false);
    expect(requests).toHaveLength(before);
  });
});

describe('telemetry job outcomes', () => {
  it('reports partial, canceled, needs-input, and uncertain as distinct terminal facts', async () => {
    const home = freshHome('learning-telemetry-jobs-');
    const previousEnv = process.env;
    const jobToken = 'phc_job_outcomes_fixture_token_1234567890abcdef';
    process.env = { ...userEnv(home, { token: jobToken }) };
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    const runtime = Object.assign(createCliRuntime(home), { output });
    await startTelemetry(output, home, 'jobs resume');
    const runner = new JobRunner(runtime.state, runtime.clock);
    const scope = { userId: 'local', profileId: 'fixture', platform: 'ykt' as const };
    const warning = { code: 'SKIPPED_UNKNOWN_DURATION', message: 'SECRET_WARNING_MESSAGE', resourceKey: 'SECRET_RESOURCE_KEY' };

    try {
      const partial = await runner.create(scope, 'study', { total: 2 });
      await runner.advance(partial.id, async () => ({
        completed: true,
        items: [
          { key: 'SECRET_SUCCEEDED_KEY', state: 'succeeded' as const, message: null, artifacts: [] },
          { key: 'SECRET_FAILED_KEY', state: 'failed' as const, message: 'SECRET_FAILURE_MESSAGE', artifacts: [] },
        ],
      }));
      const client = createLearningClient({ scope, runtime });
      await runJobForeground(client, runtime, partial.id);

      const needsInput = await runner.create(scope, 'study', { total: 1 });
      await runner.advance(needsInput.id, async () => ({ completed: false, status: 'needs-input' as const }));
      await runJobForeground(client, runtime, needsInput.id);
      await runner.resume(needsInput.id);
      await runner.advance(needsInput.id, async () => ({
        completed: true,
        items: [{ key: 'SECRET_RESUMED_KEY', state: 'succeeded' as const, message: null, artifacts: [] }],
      }));
      await runJobForeground(client, runtime, needsInput.id);

      const uncertain = await runner.create(scope, 'study', { total: 1, warnings: [warning] });
      const stored = await runtime.state.get(`job:${uncertain.id}`);
      await runtime.state.commit({
        expected: [{ key: `job:${uncertain.id}`, revision: stored!.revision }],
        changes: [{ key: `job:${uncertain.id}`, value: { ...uncertain, status: 'uncertain', warnings: [warning] } }],
      });
      await runJobForeground(client, runtime, uncertain.id);

      const canceled = await runner.create(scope, 'study', { total: 1 });
      await runner.advance(canceled.id, async () => ({ completed: false, status: 'waiting' as const, nextRunAtMs: Date.now() + 60_000 }));
      const abort = new AbortController();
      abort.abort();
      await runJobForeground(client, runtime, canceled.id, { signal: abort.signal });

      process.exitCode = 4;
      await output.finish();
      await finishTelemetry(output);
      const allEvents = await waitForTokenEvents(jobToken, events =>
        events.filter(event => event.event === 'learning_job_started').length === 5
        && events.filter(event => event.event === 'learning_job_completed').length === 5
        && events.some(event => event.event === 'cli_command_completed'));
      const payloads = requests.filter(payload => payload.body.api_key === jobToken);
      const jobEvents = allEvents.filter(event => event.event.startsWith('learning_job_'));
      const completions = jobEvents
        .filter(event => event.event === 'learning_job_completed')
        .map(event => event.properties);
      expect(completions).toEqual([
        expect.objectContaining({ outcome: 'partial', job_kind: 'study', failed_count: 1, succeeded_count: 1 }),
        expect.objectContaining({ outcome: 'needs_input', job_kind: 'study' }),
        expect.objectContaining({ outcome: 'success', job_kind: 'study' }),
        expect.objectContaining({ outcome: 'unverified', job_kind: 'study', warning_codes: ['SKIPPED_UNKNOWN_DURATION'] }),
        expect.objectContaining({ outcome: 'canceled', job_kind: 'study' }),
      ]);
      expect(jobEvents.filter(event => event.event === 'learning_job_started')).toHaveLength(completions.length);
      expect(jobEvents.every(event => event.properties.duration_basis === 'foreground_attempt')).toBe(true);

      const firstNeedsInputFinish = completions.find(properties => properties.outcome === 'needs_input')!;
      const resumedFinish = completions.find(properties => properties.outcome === 'success')!;
      const resumedStart = jobEvents.find(event => event.event === 'learning_job_started'
        && event.properties.attempt_id === resumedFinish.attempt_id)!.properties;
      expect(resumedStart.operation_id).toBe(resumedFinish.operation_id);
      expect(resumedStart.operation_id).toBe(firstNeedsInputFinish.operation_id);
      expect(resumedStart.attempt_id).toBe(resumedFinish.attempt_id);
      expect(resumedStart.attempt_id).not.toBe(firstNeedsInputFinish.attempt_id);
      expect(JSON.stringify(payloads)).not.toContain('SECRET_');
      for (const payload of payloads) expect(payload.body.batch.length).toBeLessThanOrEqual(16);
      expect(new Set(jobEvents.map(event => event.uuid)).size).toBe(jobEvents.length);

      await client.close();
    } finally {
      process.env = previousEnv;
      process.exitCode = 0;
      runtime.state.close();
      output.close();
    }
  });

  it('maps a warning-driven successful resume to command exit 4 and a local cancel to canceled', async () => {
    const home = freshHome('learning-telemetry-resume-');
    expect((await runUserCli(['init'], home)).status).toBe(0);
    await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 2);
    const added = await runUserCli(['profile', 'add', 'fixture', '--platform', 'ykt'], home);
    expect(added.status).toBe(0);
    await waitForTokenEvents('phc_public_fixture_token_1234567890abcdef', events =>
      events.some(event => event.event === 'cli_command_completed' && events.some(other => other.event === 'cli_command_started' && other.properties.operation_id === event.properties.operation_id)));
    const profile = JSON.parse(added.stdout).data as { scope: { userId: string; profileId: string; platform: 'ykt' } };

    const warning = { code: 'SKIPPED_UNKNOWN_DURATION', message: 'SECRET_WARNING_MESSAGE', resourceKey: 'SECRET_RESOURCE_KEY' };
    const warningJob = {
      id: 'job-skipped-duration', scope: profile.scope, kind: 'export' as const, status: 'succeeded' as const,
      createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: null, completed: 1, total: 1,
      items: [{ key: 'SECRET_ITEM', state: 'succeeded' as const, message: null, artifacts: [] }], warnings: [warning],
    };
    const canceledJob = {
      id: 'job-local-cancel', scope: profile.scope, kind: 'export' as const, status: 'paused' as const,
      createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: null, completed: 0, total: 1, items: [], warnings: [],
    };
    const state = new SqliteStateStore(resolve(home, 'state.db'));
    try {
      expect(await state.commit({
        expected: [{ key: `job:${warningJob.id}`, revision: null }, { key: `job:${canceledJob.id}`, revision: null }],
        changes: [{ key: `job:${warningJob.id}`, value: warningJob }, { key: `job:${canceledJob.id}`, value: canceledJob }],
      })).toBe(true);
    } finally {
      state.close();
    }

    const resumed = await runUserCli(['jobs', 'resume', warningJob.id, '--profile', 'fixture'], home);
    expect(resumed.status, resumed.stderr).toBe(4);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: false, exitCode: 4 });
    const resumedEvents = await waitForTokenEvents('phc_public_fixture_token_1234567890abcdef', events =>
      events.filter(event => event.properties.job_id === warningJob.id).length === 2
      && events.some(event => event.event === 'cli_command_completed' && event.properties.outcome === 'partial'));
    const resumedJobEvents = resumedEvents.filter(event => event.properties.job_id === warningJob.id);
    expect(resumedJobEvents.map(event => event.properties.outcome)).toEqual([undefined, 'partial']);
    expect(resumedJobEvents[0]!.properties.operation_id).toBe(resumedJobEvents[1]!.properties.operation_id);
    expect(resumedJobEvents[0]!.properties.attempt_id).toBe(resumedJobEvents[1]!.properties.attempt_id);
    expect(resumedEvents.find(event => event.event === 'cli_command_completed' && event.properties.operation === 'jobs resume')!.properties).toMatchObject({
      outcome: 'partial', exit_code: 4, duration_basis: 'cli_process',
    });
    expect(JSON.stringify(resumedEvents)).not.toContain('SECRET_');

    const canceled = await runUserCli(['jobs', 'cancel', canceledJob.id, '--profile', 'fixture', '--yes'], home);
    expect(canceled.status, canceled.stderr).toBe(0);
    const cancelEvents = await waitForTokenEvents('phc_public_fixture_token_1234567890abcdef', events =>
      events.filter(event => event.properties.job_id === canceledJob.id).length === 2
      && events.some(event => event.event === 'cli_command_completed' && event.properties.operation === 'jobs cancel'));
    const cancelJobEvents = cancelEvents.filter(event => event.properties.job_id === canceledJob.id);
    expect(cancelJobEvents.map(event => event.properties.outcome)).toEqual([undefined, 'canceled']);
    expect(cancelJobEvents[0]!.properties.operation_id).toBe(cancelJobEvents[1]!.properties.operation_id);
    expect(cancelJobEvents[0]!.properties.attempt_id).toBe(cancelJobEvents[1]!.properties.attempt_id);
  });
});

async function prepareProfiles(home: string): Promise<string> {
  const setup = { ...userEnv(home), CI: '1' };
  expect((await runUserCli(['init'], home, setup)).status).toBe(0);
  for (const name of ['SECRET_ALPHA', 'SECRET_BETA']) {
    expect((await runUserCli(['profile', 'add', name, '--platform', 'ykt'], home, setup)).status).toBe(0);
  }
  const cookies = resolve(home, 'SECRET_COOKIES.json');
  writeFileSync(cookies, JSON.stringify([{ name: 'sessionid', value: 'SECRET_COOKIE', domain: 'www.yuketang.cn', path: '/' }]), { mode: 0o600 });
  return cookies;
}

function withLegacyConfig(home: string): NodeJS.ProcessEnv {
  return { ...userEnv(home), POSTHOG_PROJECT_TOKEN: 'phc_public_fixture_token_1234567890abcdef', POSTHOG_HOST: baseUrl };
}

async function runModel(home: string, env: NodeJS.ProcessEnv, invalid = false) {
  return runChild([resolve(import.meta.dirname, 'helpers/model-telemetry.mjs')], {
    ...env, LEARNING_HOME: home, LEARNING_MODEL_BASE_URL: 'https://model.example.test/SECRET_ENDPOINT',
    LEARNING_MODEL_NAME: 'fixture-model', LEARNING_MODEL_API_KEY: 'SECRET_MODEL_KEY',
    FIXTURE_INVALID_MODEL_OUTPUT: invalid ? '1' : '0',
  });
}

describe('one privacy boundary for all telemetry', () => {
  it('uses one installation across profile imports and preserves existing workflow events', async () => {
    const home = freshHome('learning-telemetry-profiles-');
    const cookies = await prepareProfiles(home);
    for (const profile of ['SECRET_ALPHA', 'SECRET_BETA']) {
      const result = await runUserCli(['login', '--profile', profile, '--import', cookies], home, withLegacyConfig(home));
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data.identityVerified).toBe(false);
    }
    expect(requests.every(request => request.url === '/batch' && request.method === 'POST' && request.contentType === 'application/json')).toBe(true);
    const events = requests.flatMap(request => request.body.batch);
    expect(events.map(event => event.event)).toEqual(['cli_command_started', 'login_completed', 'cli_command_completed', 'cli_command_started', 'login_completed', 'cli_command_completed']);
    expect(new Set(events.map(event => event.distinct_id)).size).toBe(1);
    expect(events[0]!.distinct_id).toMatch(/^cli:[0-9a-f-]{36}$/);
    expect(JSON.stringify(requests)).not.toContain('SECRET_');
  });

  it.each([
    ['CI', { CI: '1' }], ['Vitest', { VITEST: '1' }], ['test', { NODE_ENV: 'test' }], ['development', { NODE_ENV: 'development' }],
    ['test environment', { LEARNING_TELEMETRY_ENVIRONMENT: 'test' }], ['development environment', { LEARNING_TELEMETRY_ENVIRONMENT: 'development' }],
    ['no shared token', { LEARNING_TELEMETRY_TOKEN: '' }],
  ] as const)('isolates workflow, diagnostic and model telemetry in %s even when source token is present', async (_reason, overrides) => {
    const home = freshHome('learning-telemetry-all-off-');
    const cookies = await prepareProfiles(home);
    const env = { ...withLegacyConfig(home), ...overrides };
    const before = requests.length;
    const imported = await runUserCli(['login', '--profile', 'SECRET_ALPHA', '--import', cookies], home, env);
    expect(imported.status, imported.stderr).toBe(0);
    const model = await runModel(home, env, true);
    expect(model.status, model.stderr).toBe(1);
    expect(requests).toHaveLength(before);
  });

  it('sends only model metrics with the command installation and marks invalid output as failure', async () => {
    const home = freshHome('learning-telemetry-model-');
    await prepareProfiles(home);
    const env = withLegacyConfig(home);
    expect((await runModel(home, env)).status).toBe(0);
    const invalid = await runModel(home, env, true);
    expect(invalid.status, invalid.stderr).toBe(1);
    const events = requests.flatMap(request => request.body.batch);
    const generations = events.filter(event => event.event === '$ai_generation');
    expect(generations).toHaveLength(2);
    expect(generations[0]!.properties).toMatchObject({ product: 'learning', surface: 'cli', release: pkg.version,
      $process_person_profile: false, $geoip_disable: true, $ai_model: 'fixture-model', $ai_input_tokens: 12, $ai_output_tokens: 7,
      $ai_is_error: false });
    expect(generations[1]!.properties).toMatchObject({ $ai_is_error: true, $ai_error: 'invalid_proposal_json' });
    expect(new Set(events.map(event => event.distinct_id)).size).toBe(1);
    for (const generation of generations) {
      expect(generation.properties.$ai_latency).toBeGreaterThanOrEqual(0);
      expect(events.some(event => event.event === 'cli_command_completed' && event.properties.operation_id === generation.properties.operation_id)).toBe(true);
    }
    expect(requests.every(request => request.url === '/batch')).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(/SECRET_|model\.example\.test|\$ai_input"|\$ai_output_choices/);
  });

  it('captures a handled storage failure with real frames and without account data', async () => {
    const home = freshHome('learning-telemetry-error-');
    await prepareProfiles(home);
    writeFileSync(resolve(home, 'master.key'), 'SECRET_INVALID_KEY');
    const failed = await runUserCli(['profile', 'list'], home, withLegacyConfig(home));
    expect(failed.status, failed.stderr).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, error: { code: 'STORAGE' } });
    const events = requests.flatMap(request => request.body.batch);
    const exceptions = events.filter(event => event.event === '$exception');
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.properties).toMatchObject({ error_code: 'STORAGE', product: 'learning', operation: 'profile list',
      $process_person_profile: false, $exception_list: [{ type: 'LearningError', value: 'master.key must be 32 bytes', mechanism: { handled: true, synthetic: false },
        stacktrace: { frames: expect.arrayContaining([expect.objectContaining({ filename: 'packages/sdk/src/runtime/node/index.ts', lineno: expect.any(Number) })]) } }] });
    expect(new Set(events.map(event => event.distinct_id)).size).toBe(1);
    expect(JSON.stringify(requests)).not.toContain('SECRET_');
    expect(JSON.stringify(requests)).not.toContain(home);
  });
});


describe('diagnostic delivery limits', () => {
  it('captures every recovered SDK error beyond one batch without counting propagation twice', async () => {
    const home = freshHome('learning-telemetry-recovered-');
    const previousEnv = process.env;
    process.env = userEnv(home);
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    let runtime: ReturnType<typeof createCliRuntime> | undefined;
    try {
      await startTelemetry(output, home, 'download');
      runtime = createCliRuntime(home, output);
      for (let index = 0; index < 25; index++) {
        const error = new Error(`transient failure ${index}`);
        runtime.log({ level: 'error', message: 'request failed', error, fields: { stage: 'http.transport.read', recovered: true, attempt_id: index, method: 'GET', endpoint: 'https://example.com/api?token=SECRET_REQUEST' } });
        runtime.log({ level: 'error', message: 'propagated failure', error: new Error('wrapper', { cause: error }), fields: { stage: 'job.item', attempt_id: index } });
      }
      const reused = new Error('transport reused its error object');
      for (const attempt_id of [1, 2]) runtime.log({ level: 'error', message: 'retry failed', error: reused, fields: { stage: 'http.transport.read', recovered: true, attempt_id } });
      await output.finish();
      await finishTelemetry(output);
      const events = requests.flatMap(request => request.body.batch).filter(event => event.event === '$exception');
      expect(events).toHaveLength(27);
      expect(new Set(events.map(event => event.uuid)).size).toBe(27);
      expect(events.every(event => (event.properties.context as Record<string, unknown>).recovered === true)).toBe(true);
      expect(JSON.stringify(events)).not.toContain('SECRET_REQUEST');
      expect(Number(process.exitCode ?? 0)).toBe(0);
    } finally {
      runtime?.state.close();
      await finishTelemetry(output);
      output.close();
      process.exitCode = 0;
      process.env = previousEnv;
    }
  });

  it('preserves fatal exit behavior and replays the crash after restart', async () => {
    const home = freshHome('learning-telemetry-crash-');
    await prepareProfiles(home);
    const fatal = await runChild([resolve(import.meta.dirname, 'helpers/fatal-error.mjs'), 'profile', 'list', '--home', home, '--json'], userEnv(home));
    expect(fatal.status).toBe(1);
    expect(fatal.stderr).toContain('fatal fixture failure');
    requests.length = 0;
    expect((await runUserCli(['profile', 'list'], home)).status).toBe(0);
    const events = requests.flatMap(request => request.body.batch).filter(event => event.event === '$exception');
    expect(events).toHaveLength(1);
    expect(events[0]!.properties.$exception_list).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'fatal fixture failure', mechanism: expect.objectContaining({ handled: false }) }),
    ]));
  });

  it('retains real frames and causes for a failure even when the exit code is not 1', async () => {
    const home = freshHome('learning-telemetry-frames-');
    const previousEnv = process.env;
    process.env = userEnv(home);
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      await startTelemetry(output, home, 'download');
      const cause = new Error('connection closed; token=SECRET_CREDENTIAL');
      const error = new CliError('AUTH_EXPIRED', 'session expired', 3);
      error.cause = cause;
      await output.finish(error);
      await finishTelemetry(output, error);
      const event = requests.flatMap(request => request.body.batch).find(event => event.event === '$exception');
      expect(event).toBeDefined();
      expect(event!.properties.error_code).toBe('AUTH_EXPIRED');
      const exceptions = event!.properties.$exception_list as Array<{ type: string; stacktrace: { frames: Array<{ filename: string; lineno: number }> } }>;
      expect(exceptions).toHaveLength(2);
      expect(exceptions.some(exception => exception.stacktrace.frames.some(frame => frame.filename.endsWith('telemetry.test.ts') && frame.lineno > 0))).toBe(true);
      expect(JSON.stringify(event)).not.toContain('SECRET_CREDENTIAL');
      expect(JSON.stringify(event)).not.toContain(home);
    } finally {
      await finishTelemetry(output);
      output.close();
      process.exitCode = 0;
      process.env = previousEnv;
    }
  });

  it('replays an unacknowledged exception on a later command with the same event id', async () => {
    const home = freshHome('learning-telemetry-retry-');
    const previousEnv = process.env;
    process.env = userEnv(home);
    const makeOutput = () => createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    const first = makeOutput();
    const second = makeOutput();
    const third = makeOutput();
    try {
      responseStatus = 503;
      await startTelemetry(first, home, 'download');
      const error = new Error('download transport unavailable');
      await first.finish(error);
      await finishTelemetry(first, error);
      const pending = requests.flatMap(request => request.body.batch).find(event => event.event === '$exception');
      expect(pending).toBeDefined();
      requests.length = 0;
      responseStatus = 200;
      process.exitCode = 0;
      await startTelemetry(second, home, 'profile list');
      await finishTelemetry(second);
      const replay = requests.flatMap(request => request.body.batch).filter(event => event.event === '$exception');
      expect(replay).toHaveLength(1);
      expect(replay[0]!.uuid).toBe(pending!.uuid);
      expect(replay[0]!.properties.operation_id).toBe(pending!.properties.operation_id);
      requests.length = 0;
      await startTelemetry(third, home, 'profile list');
      await finishTelemetry(third);
      expect(requests.flatMap(request => request.body.batch).filter(event => event.event === '$exception')).toHaveLength(0);
    } finally {
      responseStatus = 200;
      for (const output of [first, second, third]) { await finishTelemetry(output); output.close(); }
      process.exitCode = 0;
      process.env = previousEnv;
    }
  });

  it('reports an unexpected AbortError and independent cleanup failure while excluding user cancellation', async () => {
    const home = freshHome('learning-telemetry-abort-');
    const previousEnv = process.env;
    process.env = userEnv(home);
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      await startTelemetry(output, home, 'download');
      trackException(output, new DOMException('transport aborted without user cancellation', 'AbortError'), { stage: 'transport' });
      output.markCanceled();
      trackException(output, new DOMException('user canceled', 'AbortError'), { stage: 'transport' });
      trackException(output, new Error('cleanup failed after cancellation'), { stage: 'cleanup' });
      await finishTelemetry(output);
      const errors = requests.flatMap(request => request.body.batch).filter(event => event.event === '$exception');
      expect(errors).toHaveLength(2);
      expect(errors[0]!.properties).toMatchObject({ error_code: 'INTERNAL', $exception_list: [{ type: 'AbortError', value: 'transport aborted without user cancellation' }] });
      expect(errors[1]!.properties.$exception_list).toMatchObject([{ value: 'cleanup failed after cancellation' }]);
    } finally {
      await finishTelemetry(output);
      output.close();
      process.exitCode = 0;
      process.env = previousEnv;
    }
  });

  it('does not report a canceled request as an exception', async () => {
    const home = freshHome('learning-telemetry-canceled-');
    const previousEnv = process.env;
    process.env = userEnv(home);
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      await startTelemetry(output, home, 'discuss draft');
      output.markCanceled();
      const error = new DOMException('aborted', 'AbortError');
      await output.finish(error);
      await finishTelemetry(output, error);
      const events = requests.flatMap(request => request.body.batch);
      expect(events.map(event => event.event)).toEqual(['cli_command_started', 'cli_command_completed']);
      expect(events[1]!.properties.outcome).toBe('canceled');
      expect(JSON.stringify(requests)).not.toContain('SECRET_');
    } finally {
      await finishTelemetry(output);
      output.close();
      process.exitCode = 0;
      process.env = previousEnv;
    }
  });

  it('redacts unknown errors and exits within the telemetry budget when the collector never responds', async () => {
    const home = freshHome('learning-telemetry-stalled-error-');
    const previousEnv = process.env;
    process.env = userEnv(home);
    const output = createOutput({ format: 'json', debug: false }, { stdout: sink(), stderr: sink() });
    try {
      await startTelemetry(output, home, 'profile list');
      holdNextRequest = true;
      const error = Object.assign(new Error('password=SECRET_MESSAGE /Users/SECRET/file?token=SECRET_TOKEN'), { code: 'SECRET_CODE' });
      error.stack = 'SECRET_STACK';
      await output.finish(error);
      const startedAt = performance.now();
      await finishTelemetry(output, error);
      expect(performance.now() - startedAt).toBeLessThan(1500);
      expect(requests).toHaveLength(1);
      const events = requests[0]!.body.batch;
      expect(events.map(event => event.event)).toEqual(['cli_command_started', 'cli_command_completed', '$exception']);
      expect(events[2]!.properties).toMatchObject({ error_code: 'INTERNAL', $exception_list: [{ type: 'Error', mechanism: { handled: true, synthetic: false } }] });
      expect(JSON.stringify(requests)).not.toContain('SECRET_');
    } finally {
      releaseHeldRequest();
      await finishTelemetry(output);
      output.close();
      process.exitCode = 0;
      process.env = previousEnv;
    }
  });
});
