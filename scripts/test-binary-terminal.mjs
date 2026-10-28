import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

const home = mkdtempSync(resolve(tmpdir(), 'learning-binary-agent-pty-'));
const binary = resolve(process.argv[2]);
const driver = resolve(root, 'apps/cli/tests/helpers/terminal-driver.py');
const firstUse = resolve(home, '首次使用');

function terminal(args, steps = [], bare = false) {
  return JSON.parse(execFileSync('python3', [driver, JSON.stringify({
    argv: [binary, ...(bare ? [] : ['--home', home]), ...args],
    steps,
    columns: 32,
    env: {
      PATH: '',
      HOME: home,
      USERPROFILE: home,
      LEARNING_HOME: bare ? firstUse : home,
      LEARNING_TELEMETRY_DISABLED: '1',
      LEARNING_MODEL_API_KEY: '',
      NODE_OPTIONS: '',
      BUN_OPTIONS: '',
    },
  })], { encoding: 'utf8', timeout: 20_000 }));
}

function envelope(result) {
  assert.equal(result.screen.includes('\u001b'), false, 'TTY output must not contain ANSI controls');
  const lines = result.screen.replaceAll('\r', '').trim().split('\n').filter(line => line.startsWith('{'));
  assert.equal(lines.length > 0, true, 'TTY output must be JSON');
  const body = JSON.parse(lines.at(-1));
  assert.equal(result.code, body.exitCode, result.screen);
  return body;
}

const failures = [];
try {
  const discovered = envelope(terminal([], [], true));
  assert.equal(discovered.schemaVersion, 1);
  assert.equal(discovered.ok, true);
  assert.equal(discovered.data.name, 'learning');
  assert.deepEqual(discovered.data.arguments, []);
  assert.equal(discovered.data.commands.some(command => command.name === 'profile'), true);
  assert.doesNotMatch(discovered.data.commands.at(0).description, /请选择|账号名称|选择平台/);
  assert.equal(existsSync(resolve(firstUse, 'state.db')), false, 'command discovery must not initialize storage');
  assert.equal(existsSync(resolve(firstUse, 'master.key')), false, 'command discovery must not create a key');

  execFileSync(binary, ['--home', home, 'init'], { stdio: 'pipe', env: { ...process.env, LEARNING_TELEMETRY_DISABLED: '1' } });
  const added = envelope(terminal(['profile', 'add', 'binary-user', '--platform', 'ykt']));
  assert.equal(added.ok, true);
  assert.equal(added.data.name, 'binary-user');
  assert.equal(added.data.scope.platform, 'ykt');

  for (const flags of [['--no-interactive'], ['--quiet'], ['--no-color'], ['--output-format', 'pretty'], ['--output-format', 'plain']]) {
    const rejected = envelope(terminal(flags));
    assert.equal(rejected.exitCode, 2);
    assert.equal(rejected.error.code, 'INVALID_INPUT');
  }
  const missing = envelope(terminal(['profile', 'add']));
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.error.code, 'INVALID_INPUT');
  assert.deepEqual(missing.error.fields, ['name', 'platform']);
  assert.doesNotMatch(missing.error.message, /账号名称|选择平台/);

  const version = JSON.parse(execFileSync(binary, ['--version'], { encoding: 'utf8', env: { ...process.env, LEARNING_TELEMETRY_DISABLED: '1' } }));
  assert.equal(version.ok, true);
  assert.match(version.data.text, /^\d+\.\d+\.\d+/);
  const help = JSON.parse(execFileSync(binary, ['--help'], { encoding: 'utf8', env: { ...process.env, LEARNING_TELEMETRY_DISABLED: '1' } }));
  assert.match(help.data.text, /Usage:/);
  assert.equal(help.data.text.includes('--no-interactive'), false);

  console.log('OK compiled CLI real PTY: JSON discovery and results, no prompts or ANSI, explicit agent inputs, rejected human flags');
} catch (error) {
  failures.push(error);
} finally {
  try {
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false, 'PTY data directory remains after cleanup');
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length) throw new AggregateError(failures, 'PTY agent contract and cleanup failures retained');
