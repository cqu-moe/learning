// Compile and run a real Bun crash probe; the source is generated so no test entry enters the CLI package.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { bunVersion, compile, root, target } from './build-cli.mjs';

const { positionals } = parseArgs({ allowPositionals: true });
const bundledTelemetryToken = 'phc_public_fixture_token_1234567890abcdef';

const outputDirectory = resolve(root, 'dist/error-diagnostics');
const sourcePath = resolve(outputDirectory, 'learning-error-source.ts');
const executable = resolve(outputDirectory, `learning-error-diagnostics-${target}${process.platform === 'win32' ? '.exe' : ''}`);
mkdirSync(outputDirectory, { recursive: true });
rmSync(executable, { force: true });
rmSync(`${executable}.map`, { force: true });

writeFileSync(sourcePath, `function createRootCause(): Error {
  return new Error('diagnostic root cause');
}

function throwDiagnostics(): never {
  throw new Error('diagnostic from original source', { cause: createRootCause() });
}

function throwUncaughtForMonitor(): never {
  throw new Error('fatal diagnostic from original source');
}

if (process.env.LEARNING_BUNDLED_TELEMETRY_TOKEN !== '${bundledTelemetryToken}') process.abort();

process.setSourceMapsEnabled?.(true);

if (process.argv.includes('--monitor')) {
  process.on('uncaughtExceptionMonitor', error => {
    process.stderr.write(\`uncaught-monitor-invoked:\${error.message}\\n\`);
  });
  throwUncaughtForMonitor();
}

try {
  throwDiagnostics();
} catch (error) {
  if (!(error instanceof Error) || !(error.cause instanceof Error)) process.abort();
  process.stderr.write(\`\${error.stack}\\ncause-stack:\\n\${error.cause.stack}\\n\`);
  process.exitCode = 1;
}
`);

compile(sourcePath, executable, { bundledTelemetryToken });
assert.equal(existsSync(`${executable}.map`), false, 'diagnostic maps must be embedded, not shipped beside the program');

const runDirectory = realpathSync(mkdtempSync(resolve(tmpdir(), 'learning 堆栈诊断 ')));
const program = resolve(runDirectory, basename(executable));
copyFileSync(executable, program);
if (process.platform !== 'win32') chmodSync(program, 0o755);
assert.deepEqual(readdirSync(runDirectory), [basename(program)], 'the diagnostic program must run without companion files');

const environment = { ...process.env, PATH: '' };
for (const key of Object.keys(environment)) {
  if (/^(bun_options|node_options)$/i.test(key)) delete environment[key];
}

const result = spawnSync(program, [], { cwd: runDirectory, env: environment, encoding: 'utf8', timeout: 20_000 });
const monitor = spawnSync(program, ['--monitor'], { cwd: runDirectory, env: environment, encoding: 'utf8', timeout: 20_000 });
rmSync(runDirectory, { recursive: true, force: true });
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 1, `\n${result.stdout}\n${result.stderr}`);
assert.equal(monitor.error, undefined, monitor.error?.message);
assert.equal(monitor.status, 1, `\n${monitor.stdout}\n${monitor.stderr}`);
assert.equal(monitor.signal, null, 'the monitor listener must not prevent the fatal exit');

const diagnostics = `${result.stdout}\n${result.stderr}`;
const fatalDiagnostics = `${monitor.stdout}\n${monitor.stderr}`;
assert.match(diagnostics, /learning-error-source\.ts:6:\d+/, 'outer stack must identify the original TypeScript throw site');
assert.match(diagnostics, /at throwDiagnostics/, 'outer stack must retain the original function name');
assert.match(diagnostics, /cause-stack:/, 'the error chain must expose its cause');
assert.match(diagnostics, /learning-error-source\.ts:2:\d+/, 'cause stack must identify the original TypeScript site');
assert.match(diagnostics, /at createRootCause/, 'cause stack must retain the original function name');
assert.match(diagnostics, /diagnostic root cause/);
assert.match(fatalDiagnostics, /uncaught-monitor-invoked:fatal diagnostic from original source/, 'Bun must emit uncaughtExceptionMonitor');
assert.match(fatalDiagnostics, /learning-error-source\.ts:10:\d+/, 'fatal stack must identify the original TypeScript throw site');
assert.match(fatalDiagnostics, /at throwUncaughtForMonitor/, 'fatal stack must retain the original function name');

async function verifyShippedBinary(source) {
  const runDirectory = realpathSync(mkdtempSync(resolve(tmpdir(), 'learning 实际诊断 ')));
  const program = resolve(runDirectory, basename(source));
  const home = resolve(runDirectory, 'home 数据');
  const token = 'phc_public_fixture_token_1234567890abcdef';
  const requests = [];
  const protocolErrors = [];
  copyFileSync(source, program);
  if (process.platform !== 'win32') chmodSync(program, 0o755);

  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      const expectedProtocol = request.method === 'POST' && request.url === '/batch' && request.headers['content-type'] === 'application/json';
      let body = null;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed?.api_key === 'string' && Array.isArray(parsed.batch)) body = parsed;
      } catch { /* Keep malformed bodies for the final protocol assertion. */ }
      if (!expectedProtocol || body === null || bytes > 1024 * 1024) {
        protocolErrors.push(`${request.method ?? ''} ${request.url ?? ''} ${bytes} bytes`);
        response.writeHead(bytes > 1024 * 1024 ? 413 : 400, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      requests.push({ body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;

  let init;
  let failure;
  try {
    await new Promise((resolveListen, rejectListen) => server.once('error', rejectListen).listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null, 'actual-binary telemetry collector did not bind a port');
    const environment = { ...process.env,
      PATH: '',
      TMPDIR: runDirectory,
      CI: '0',
      VITEST: '0',
      NODE_ENV: 'production',
      LEARNING_TELEMETRY_ENVIRONMENT: 'production',
      LEARNING_TELEMETRY_TOKEN: token,
      LEARNING_TELEMETRY_HOST: `http://127.0.0.1:${address.port}`,
    };
    for (const key of Object.keys(environment)) {
      if (/^(?:home|path|bun_options|node_options|https?_proxy|all_proxy|no_proxy|learning_model_.+|learning_telemetry_token|learning_telemetry_host|posthog_project_token|learning_bundled_telemetry_token)$/i.test(key)) delete environment[key];
    }
    environment.PATH = '';
    environment.LEARNING_TELEMETRY_TOKEN = token;
    environment.LEARNING_TELEMETRY_HOST = `http://127.0.0.1:${address.port}`;

    const run = args => new Promise(resolveRun => {
      const child = spawn(program, args, { cwd: runDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
      child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
      child.on('error', resolveRun);
      child.on('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }));
    });

    init = await run(['--home', home, 'init', '--json']);
    assert.equal(init.status, 0, `\n${init.stdout}\n${init.stderr}`);
    requests.length = 0;
    writeFileSync(resolve(home, 'master.key'), 'invalid');
    failure = await run(['--home', home, 'profile', 'list', '--json']);
    assert.equal(failure.status, 1, `\n${failure.stdout}\n${failure.stderr}`);

    const deadline = Date.now() + 2000;
    while (requests.length === 0 && Date.now() < deadline) await setTimeout(10);
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolveClose, rejectClose) => server.close(error => error === undefined ? resolveClose() : rejectClose(error)));
    await rm(runDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(existsSync(runDirectory), false, 'actual-binary diagnostic directory still exists after cleanup');
  }

  assert.deepEqual(protocolErrors, [], 'the actual binary must use the declared local JSON telemetry protocol');
  assert.ok(requests.length > 0, 'the actual binary did not send telemetry to the local collector');
  for (const request of requests) {
    assert.equal(request.body.api_key, token);
    assert.ok(request.body.batch.every(event => event.event !== undefined && typeof event.properties === 'object'));
  }
  const events = requests.flatMap(request => request.body.batch);
  const exceptions = events.filter(event => event.event === '$exception');
  assert.equal(exceptions.length, 1, `expected one exception event, got ${events.map(event => event.event).join(', ')}`);
  const exception = exceptions[0];
  const list = exception.properties.$exception_list;
  assert.ok(Array.isArray(list) && list.length > 0, '$exception_list must contain the LearningError');
  assert.equal(list[0].type, 'LearningError');
  assert.match(list[0].value ?? '', /master\.key must be 32 bytes/);
  const frames = list[0].stacktrace?.frames;
  assert.ok(Array.isArray(frames) && frames.length > 0, 'LearningError frames must not be empty');
  const sdkFrame = frames.find(frame => frame.filename === 'packages/sdk/src/runtime/node/index.ts' && Number.isInteger(frame.lineno) && frame.lineno > 0);
  assert.ok(sdkFrame !== undefined, `LearningError frames must point to actual SDK TypeScript source: ${JSON.stringify(frames)}`);
  for (const event of events) {
    const rejectPrivate = (value, path) => {
      if (typeof value === 'string') {
        assert.ok(!value.includes(token), `telemetry property leaks the token: ${path}`);
        assert.ok(!value.includes(home) && !value.includes(runDirectory), `telemetry property leaks a local path: ${path}`);
      } else if (Array.isArray(value)) value.forEach((item, index) => rejectPrivate(item, `${path}[${index}]`));
      else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) rejectPrivate(item, `${path}.${key}`);
    };
    rejectPrivate(event.properties, `properties for ${event.event}`);
  }
  return { requestCount: requests.length, eventCount: events.length, frameCount: frames.length, sdkFrame: `${sdkFrame.filename}:${sdkFrame.lineno}` };
}

let actualBinaryResult;
if (positionals.length > 0) {
  assert.equal(positionals.length, 1, 'provide at most one actual executable path');
  actualBinaryResult = await verifyShippedBinary(resolve(positionals[0]));
}

console.log(`OK standalone error diagnostics (${bunVersion}, ${target}): TS locations, function names, cause chain, and uncaughtExceptionMonitor fatal exit${actualBinaryResult === undefined ? '' : `; actual CLI captured 1 exception with ${actualBinaryResult.frameCount} frames at ${actualBinaryResult.sdkFrame}`}`);
