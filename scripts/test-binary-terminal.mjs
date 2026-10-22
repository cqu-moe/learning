import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

const home = mkdtempSync(resolve(tmpdir(), 'learning-binary-pty-'));
const binary = resolve(process.argv[2]);
const driver = resolve(root, 'apps/cli/tests/helpers/terminal-driver.py');
function terminal(args, steps, bare = false) {
  return JSON.parse(execFileSync('python3', [driver, JSON.stringify({
    argv: [binary, ...(bare ? [] : ['--home', home]), ...args], steps, columns: 32,
    env: { PATH: '', HOME: home, USERPROFILE: home, LEARNING_HOME: bare ? resolve(home, '首次使用') : home, LEARNING_MODEL_API_KEY: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
  })], { encoding: 'utf8', timeout: 20_000 }));
}
const failures = [];
try {
  const guided = terminal([], [{ wait: '退出', send: '\u001b[B\u001b[B\u001b[B\r' }], true);
  assert.equal(guided.code, 0, guided.screen);
  assert.match(guided.screen, /开始学习/);
  assert.match(guided.screen, /配置/);
  assert.match(guided.screen, /更多/);
  assert.doesNotMatch(guided.screen, /ExperimentalWarning|内测|等价命令|初始化本地|Type:/);
  assert.equal(existsSync(resolve(home, '首次使用', 'master.key')), true);
  assert.equal(existsSync(resolve(home, '首次使用', 'state.db')), true);
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
  const returned = terminal(['--output-format', 'plain'], [
    { wait: '请选择操作', send: '7\n' },
    { wait: '请选择操作', occurrences: 2, send: '1\n' },
    { wait: '账号名称', send: 'menu-user\n' },
    { wait: '选择平台', send: '1\n' },
    { wait: '请选择操作', occurrences: 3, send: '20\n' },
  ]);
  assert.equal(returned.code, 0, returned.screen);
  assert.equal(returned.steps, 5, returned.screen);
  assert.match(returned.screen, /等价命令：learning 'profile' 'add'/);
  assert.equal((returned.screen.match(/请选择操作/g) ?? []).length >= 3, true, 'wizard must return home after a leaf operation');
  const savedProfiles = JSON.parse(execFileSync(binary, ['--home', home, 'profile', 'list', '--json'], { encoding: 'utf8' })).data.profiles;
  assert.deepEqual(savedProfiles.map(profile => profile.name).sort(), ['binary-user', 'menu-user']);
  assert.equal(existsSync(resolve(home, 'learning.lock')), false);
  console.log('OK compiled CLI real PTY: Clack, Chinese narrow terminal, cancellation, lock cleanup and home-menu return');
} catch (error) { failures.push(error); } finally {
  try {
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false, 'PTY data directory remains after cleanup');
  } catch (error) { failures.push(error); }
}
if (failures.length) throw new AggregateError(failures, 'PTY primary and cleanup failures retained');
