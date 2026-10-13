import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

const home = mkdtempSync(resolve(tmpdir(), 'learning-binary-pty-'));
const binary = resolve(process.argv[2]);
const driver = resolve(root, 'apps/cli/tests/helpers/terminal-driver.py');
function terminal(args, steps) {
  return JSON.parse(execFileSync('python3', [driver, JSON.stringify({
    argv: [binary, '--home', home, ...args], steps, columns: 32,
    env: { LEARNING_MODEL_API_KEY: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
  })], { encoding: 'utf8', timeout: 20_000 }));
}
try {
  execFileSync(binary, ['--home', home, 'init'], { stdio: 'pipe' });
  const add = terminal(['profile', 'add', '--platform', 'ykt'], [{ wait: '账号名称', send: 'binary-user\r' }]);
  assert.equal(add.code, 0, add.screen);
  assert.equal(add.steps, 1);
  assert.match(add.screen, /binary-user/);
  const cancel = terminal(['profile', 'remove', 'binary-user', '--output-format', 'plain'], [{ wait: '确认执行以上操作', send: '\u0003' }]);
  assert.equal(cancel.code, 3, cancel.screen);
  assert.equal(cancel.steps, 1);
  assert.match(cancel.screen, /CANCELED/);
  assert.equal(existsSync(resolve(home, 'learning.lock')), false);
  const profiles = JSON.parse(execFileSync(binary, ['--home', home, 'profile', 'list', '--json'], { encoding: 'utf8' })).data.profiles;
  assert.equal(profiles.length, 1, 'canceled removal preserves account');
  const menu = terminal(['--output-format', 'plain'], [{ wait: '请选择操作', send: '20\n' }]);
  assert.equal(menu.code, 0, menu.screen);
  assert.equal(menu.steps, 1);
  console.log('OK compiled CLI real PTY: Clack, Chinese narrow terminal, cancellation and lock cleanup, menu exit');
} finally {
  rmSync(home, { recursive: true, force: true });
}
