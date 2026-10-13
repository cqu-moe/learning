import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLearningClient } from '@learning/sdk';
import { SqliteStateStore } from '@learning/sdk/node';
import { JobRunner } from '../../../packages/sdk/src/services/jobs.js';
import { createOutput } from '../src/output.js';
import { createCliRuntime } from '../src/runtime.js';
import { runJobForeground } from '../src/foreground.js';
import { finishTelemetry, startTelemetry } from '../src/telemetry.js';

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
type CapturedRequest = { url: string; body: TelemetryPayload };

let server: Server;
const requests: CapturedRequest[] = [];
let baseUrl = '';
let holdNextRequest = false;
let heldResponse: ServerResponse | null = null;

function startServer(): Promise<void> {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body: JSON.parse(body) as TelemetryPayload });
      if (holdNextRequest) {
        holdNextRequest = false;
        heldResponse = response;
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
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
    if (payloads.length >= count) return payloads.slice(-count);
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

function runUserCli(args: string[], home: string, env = userEnv(home)) {
  const result = spawnSync(process.execPath, [cliEntry, ...args, '--home', home, '--json'], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  await startServer();
});

beforeEach(async () => {
  // Let a previous child process's final response handler finish before changing fixture controls.
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  requests.length = 0;
  holdNextRequest = false;
  releaseHeldRequest();
});

afterAll(async () => {
  process.env = originalEnv;
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  for (const path of tempRoots) rmSync(path, { recursive: true, force: true });
});

describe('cli telemetry lifecycle', () => {
  it('is default-on, notices once on stderr, and sends only allowlisted command facts', async () => {
    const home = freshHome('learning-telemetry-live-');
    const first = runUserCli(['init'], home);
    expect(first.status).toBe(0);
    expect(existsSync(resolve(home, 'telemetry.json')), `test endpoint ${baseUrl}`).toBe(true);
    expect(first.stderr).toContain('learning telemetry off');
    expect(first.stderr.match(/匿名使用统计/g)).toHaveLength(1);
    expect(first.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(first.stdout)).toMatchObject({ command: 'init', ok: true, exitCode: 0 });
    expect(statSync(resolve(home, 'telemetry.json')).mode & 0o777).toBe(0o600);

    const payloads = await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 2);
    expect(payloads.map(payload => payload.url)).toEqual(['/batch', '/batch']);
    expect(payloads.map(payload => payload.body.api_key)).toEqual(['phc_public_fixture_token_1234567890abcdef', 'phc_public_fixture_token_1234567890abcdef']);
    expect(payloads.map(payload => payload.body.batch.map(event => event.event))).toEqual([['cli_command_started'], ['cli_command_completed']]);
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
      release: '0.2.4',
      actor_type: 'installation',
      trigger: 'user',
      operation: 'init',
      operation_id: events.find(event => event.event === 'cli_command_started')!.properties.operation_id,
      outcome: 'success',
      exit_code: 0,
      error_code: null,
      is_test: false,
      duration_basis: 'cli_process',
    });
    expect(JSON.stringify(payloads)).not.toContain(home);

    const second = runUserCli(['init'], home);
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 4);
  });

  it('keeps a failing command result and exit code unchanged without uploading its argument', async () => {
    const home = freshHome('learning-telemetry-sensitive-');
    const token = 'phc_sensitive_fixture_token_1234567890abcdef';
    expect(runUserCli(['init'], home, userEnv(home, { token })).status).toBe(0);
    await waitForTokenPayloads(token, 2);
    const failed = runUserCli(['jobs', 'show', 'SECRET_JOB_ARGUMENT'], home, userEnv(home, { token }));
    expect(failed.status).toBe(2);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, exitCode: 2, error: { code: 'INVALID_INPUT' } });
    const payloads = await waitForTokenPayloads(token, 4);
    const completed = payloads.flatMap(payload => payload.body.batch).find(event => event.event === 'cli_command_completed' && event.properties.operation === 'jobs show')!.properties;
    expect(completed).toMatchObject({ operation: 'jobs show', outcome: 'failure', exit_code: 2, error_code: 'INVALID_INPUT' });
    expect(JSON.stringify(payloads)).not.toContain('SECRET_JOB_ARGUMENT');
    expect(JSON.stringify(payloads)).not.toContain(home);
  });

  it('sends a started request before command completion without blocking business output', async () => {
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
    expect(startPayload.body.batch.map(event => event.event)).toEqual(['cli_command_started']);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ command: 'init', ok: true, exitCode: 0 });
    expect(stderr).toContain('learning telemetry off');
    expect(child.exitCode).toBeNull();

    releaseHeldRequest();
    const [completionPayload] = await waitForRequests(2);
    expect(await exited).toBe(0);
    expect(completionPayload.body.batch.map(event => event.event)).toEqual(['cli_command_completed']);
    expect(completionPayload.body.batch[0]!.properties.operation_id).toBe(startPayload.body.batch[0]!.properties.operation_id);
    expect(new Set([startPayload.body.batch[0]!.uuid, completionPayload.body.batch[0]!.uuid]).size).toBe(2);
  });

  it('keeps command result and exit code unchanged when sending fails', () => {
    const home = freshHome('learning-telemetry-network-');
    const env = userEnv(home);
    env.LEARNING_TELEMETRY_HOST = 'http://127.0.0.1:9';
    const before = requests.length;
    const failed = runUserCli(['init'], home, env);
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain('learning telemetry off');
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: true, exitCode: 0 });
    expect(requests).toHaveLength(before);
  });

  it('works with no token configured and still creates only the local installation state', () => {
    const home = freshHome('learning-telemetry-no-token-');
    const before = requests.length;
    const first = runUserCli(['init'], home, userEnv(home, { telemetry: false }));
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('learning telemetry off');
    expect(existsSync(resolve(home, 'telemetry.json'))).toBe(true);
    expect(runUserCli(['init'], home, userEnv(home, { telemetry: false })).stderr).toBe('');
    expect(requests).toHaveLength(before);
  });

  it('honors persistent and environment opt-out without touching stdout', async () => {
    const home = freshHome('learning-telemetry-off-');
    expect(runUserCli(['init'], home).status).toBe(0);
    await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 2);

    const disabled = runUserCli(['telemetry', 'off'], home);
    expect(disabled.status).toBe(0);
    expect(JSON.parse(disabled.stdout).data).toEqual({ enabled: false, reason: 'persistent' });
    const afterOff = requests.length;
    expect(afterOff).toBe(2);
    expect(runUserCli(['init'], home).status).toBe(0);
    expect(requests).toHaveLength(afterOff);

    const enabled = runUserCli(['telemetry', 'on'], home);
    expect(enabled.status).toBe(0);
    expect(JSON.parse(enabled.stdout).data).toEqual({ enabled: true, reason: 'persistent' });
    expect(requests).toHaveLength(afterOff);
    expect(runUserCli(['init'], home).status).toBe(0);
    await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 4);
    const afterEnable = requests.length;

    const envOff = userEnv(home);
    envOff.LEARNING_TELEMETRY_DISABLED = '1';
    expect(runUserCli(['init'], home, envOff).status).toBe(0);
    expect(requests).toHaveLength(afterEnable);
  });

  it('is automatically disabled by CI and does not run for help or version', () => {
    const before = requests.length;
    for (const overrides of [{ CI: '1' }, { VITEST: '1' }, { NODE_ENV: 'test' }, { NODE_ENV: 'development' }]) {
      const ciHome = freshHome('learning-telemetry-ci-');
      const disabled = runUserCli(['init'], ciHome, { ...userEnv(ciHome), ...overrides });
      expect(disabled.status).toBe(0);
      expect(disabled.stderr).toBe('');
      expect(existsSync(resolve(ciHome, 'telemetry.json'))).toBe(false);
    }
    expect(requests).toHaveLength(before);

    const helpHome = freshHome('learning-telemetry-help-');
    for (const args of [['--help'], ['--version']]) {
      const result = runUserCli(args, helpHome);
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
    const output = createOutput({ format: 'json', interactive: false, quiet: true, color: false, debug: false }, { stdout: sink(), stderr: sink() });
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
    expect(runUserCli(['init'], home).status).toBe(0);
    await waitForTokenPayloads('phc_public_fixture_token_1234567890abcdef', 2);
    const added = runUserCli(['profile', 'add', 'fixture', '--platform', 'ykt'], home);
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

    const resumed = runUserCli(['jobs', 'resume', warningJob.id, '--profile', 'fixture'], home);
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

    const canceled = runUserCli(['jobs', 'cancel', canceledJob.id, '--profile', 'fixture', '--yes'], home);
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
