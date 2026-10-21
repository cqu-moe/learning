// Run the shipped executable outside the checkout, with no JS runtime on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'without-telemetry': { type: 'boolean', default: false } } });
assert.equal(positionals.length, 1, 'provide one executable path');
const binary = resolve(positionals[0]);
const tokenConfigured = !values['without-telemetry'];
const version = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url))).version;
const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'learning-binary-')));
const home = resolve(root, '账号 数据');
const env = { ...process.env, PATH: '', LEARNING_HOME: resolve(root, 'ignored-home') };
// Windows requires its system PowerShell for the owner-only ACL, not Node/Bun.
for (const key of Object.keys(env)) {
  if (/^(path|bun_options|node_options|posthog_project_token|posthog_host|learning_model_.+|learning_telemetry_token|learning_bundled_telemetry_token)$/i.test(key)) delete env[key];
}
env.PATH = '';
function run(args, expected = 0) {
  const result = spawnSync(binary, ['--home', '账号 数据', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function json(args, expected = 0) {
  const stdout = run([...args, '--json'], expected);
  assert.equal(stdout.trim().split('\n').length, 1, 'one JSON document per command');
  assert.ok(!stdout.includes('\u001b'), 'no terminal escapes in JSON');
  return JSON.parse(stdout);
}
const failures = [];
try {
  assert.equal(run(['--version']).trim(), version);
  assert.match(run(['--help']), /learning/);
  const telemetryStatusText = run(['telemetry', 'status', '--json']);
  assert.doesNotMatch(telemetryStatusText, /phc_[A-Za-z0-9_-]+/, 'telemetry status must not display the token');
  const telemetryStatus = JSON.parse(telemetryStatusText).data;
  assert.equal(telemetryStatus.tokenConfigured, tokenConfigured, 'verify the expected embedded telemetry configuration');
  if (process.env.CI !== undefined && !['0', 'false'].includes(process.env.CI.toLowerCase())) {
    assert.deepEqual(telemetryStatus, { enabled: false, reason: 'automatic', tokenConfigured });
  }
  const defaultStatus = spawnSync(binary, ['--home', home, 'telemetry', 'status', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...env, CI: '0', VITEST: '0', NODE_ENV: 'production', LEARNING_TELEMETRY_ENVIRONMENT: 'production' },
  });
  assert.equal(defaultStatus.status, 0);
  assert.deepEqual(JSON.parse(defaultStatus.stdout).data, { enabled: tokenConfigured, reason: tokenConfigured ? 'active' : 'configuration', tokenConfigured }, 'runtime telemetry must match the explicit build mode');
  // Compile must not silently load local project config or dotenv files.
  writeFileSync(resolve(root, '.env'), 'LEARNING_MODEL_NAME=unwanted\nLEARNING_MODEL_BASE_URL=https://invalid.example\nLEARNING_MODEL_API_KEY=fixture-only\n');
  writeFileSync(resolve(root, 'bunfig.toml'), 'invalid = [');
  const doctor = json(['doctor']).data;
  assert.equal(doctor.runtime, 'Bun');
  assert.equal(doctor.runtimeVersion, readFileSync(new URL('../.bun-version', import.meta.url), 'utf8').trim());
  assert.equal(doctor.home, home);
  assert.equal(doctor.initialized, false);
  assert.equal(doctor.ffprobe.available, false);
  assert.match(doctor.model, /^not configured/);
  assert.equal(existsSync(home), false, 'doctor is read-only');
  assert.equal(json(['init']).data.home, home);
  const key = readFileSync(resolve(home, 'master.key'));
  assert.equal(key.length, 32);
  assert.equal(json(['init']).data.initialized, true);
  assert.deepEqual(readFileSync(resolve(home, 'master.key')), key);
  assert.equal(existsSync(resolve(root, 'ignored-home')), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(home).mode & 0o777, 0o700);
    for (const file of ['master.key', 'state.db']) assert.equal(statSync(resolve(home, file)).mode & 0o777, 0o600);
  }
  const first = json(['profile', 'add', '甲账号', '--platform', 'ykt']).data;
  const second = json(['profile', 'add', '乙账号', '--platform', 'xuetang']).data;
  assert.notEqual(first.scope.profileId, second.scope.profileId);
  const profiles = json(['profile', 'list']).data.profiles;
  assert.equal(profiles.length, 2);
  assert.deepEqual(new Set(profiles.map(profile => profile.name)), new Set(['甲账号', '乙账号']));
  json(['profile', 'add', '甲账号', '--platform', 'ykt'], 2);
  // Test against a real live parent PID, then a confirmed dead PID.
  const lock = resolve(home, 'learning.lock');
  writeFileSync(lock, String(process.pid));
  run(['init'], 3);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  writeFileSync(lock, '2147483647');
  json(['init']);
  assert.equal(existsSync(lock), false);
  writeFileSync(resolve(home, 'master.key'), 'invalid');
  run(['init'], 1);
  assert.equal(readFileSync(resolve(home, 'master.key'), 'utf8'), 'invalid');
  assert.equal(existsSync(lock), false, 'failed init releases its lock');
  console.log(`OK standalone CLI ${process.platform}/${process.arch}: runtime-free launch, SQLite, profiles, permissions, locks, failure cleanup`);
} catch (error) { failures.push(error); } finally {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(existsSync(root), false, 'isolated directory still exists after cleanup');
  } catch (error) { failures.push(error); }
}
if (failures.length) throw new AggregateError(failures, 'standalone binary failed; primary and cleanup errors retained');
