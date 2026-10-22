import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStateStore } from '@learning/sdk/node';
import type { Fixture } from '../../../packages/sdk/tests/helpers/replay.js';

const cli = resolve(import.meta.dirname, '../dist/index.js');
const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');
const fixtures = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
const homes: string[] = [];
function home() { const dir = mkdtempSync(resolve(tmpdir(), 'learning-home-')); homes.push(dir); return dir; }
function fixture(name: string): Fixture { return JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), 'utf8')) as Fixture; }
function command(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, '--home', dir, ...args], { encoding: 'utf8', env: { ...process.env, LEARNING_TELEMETRY_DISABLED: '1' } });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function terminal(dir: string, steps: Array<{ wait: string; send: string; occurrences?: number }>, interactions: Fixture['interactions'] = [], term = 'dumb', columns = 80) {
  const path = resolve(dir, 'fixture.json');
  writeFileSync(path, JSON.stringify({ interactions }));
  const result = spawnSync('python3', [driver, JSON.stringify({
    argv: [process.execPath, '--import', preload, cli], term, columns,
    env: { LEARNING_HOME: dir, LEARNING_FIXTURE_FILE: path, NO_COLOR: '1' }, steps,
  })], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout) as { code: number; screen: string; steps: number; snapshots: string[] };
  data.screen = stripVTControlCharacters(data.screen);
  expect(data.steps, data.screen).toBe(steps.length);
  return data;
}
afterAll(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

describe('no-argument home', () => {
  it('initializes once, shows four choices and labels other features as beta', () => {
    const dir = home();
    const result = terminal(dir, [
      { wait: '请选择操作', send: '3\n' },
      { wait: '更多功能', send: '\u0003' },
    ]);
    const first = result.snapshots[0]!;
    expect(first).toContain('1. 开始学习');
    expect(first).toContain('2. 配置');
    expect(first).toContain('3. 更多');
    expect(first).toContain('4. 退出');
    expect(first).not.toContain('5.');
    expect(first).not.toContain('内测');
    expect(result.screen).not.toMatch(/账号管理（内测）|检查运行环境（内测）|登录账号（内测）/);
    expect(result.screen).not.toMatch(/ExperimentalWarning|等价命令|\[CANCELED\]|不会回滚|初始化本地/);
    expect(result.screen).toContain('下载课件（内测）');
    expect(result.code).toBe(3);
    const key = readFileSync(resolve(dir, 'master.key'));
    expect(existsSync(resolve(dir, 'state.db'))).toBe(true);
    expect(terminal(dir, [{ wait: '请选择操作', send: '4\n' }]).code).toBe(0);
    expect(readFileSync(resolve(dir, 'master.key'))).toEqual(key);
    expect(existsSync(resolve(dir, 'learning.lock'))).toBe(false);
  }, 20_000);

  it('supports keyboard navigation and cancellation in a narrow interactive terminal', () => {
    const dir = home();
    const result = terminal(dir, [
      { wait: '退出', send: '\u001b[B\u001b[B\r' },
      { wait: '更多功能', send: '\u0003' },
    ], [], 'xterm-256color', 32);
    expect(result.code).toBe(3);
    expect(result.screen).toContain('更多功能');
    expect(result.screen).not.toMatch(/ExperimentalWarning|\[CANCELED\]|不会回滚|Search:|Type:/);
    expect(existsSync(resolve(dir, 'learning.lock'))).toBe(false);
  }, 20_000);

  it('creates an account and logs in inline before selecting a course', () => {
    const dir = home();
    const result = terminal(dir, [
      { wait: '请选择操作', send: '1\n' },
      { wait: '选择平台', send: '1\n' },
      { wait: '账号名称', send: '新账号\n' },
      { wait: '搜索并选择课程', send: '\u0003' },
    ], [...fixture('ykt/qr-login').interactions, ...fixture('ykt/courses-list').interactions]);
    expect(result.code).toBe(3);
    expect(result.screen).toContain('已登录账号：新账号');
    expect(result.screen).not.toMatch(/选择登录方式|learning init|profile add|learning login|[a-f0-9]{64}|等价命令|不会回滚/);
    expect(JSON.parse(command(dir, ['profile', 'list', '--json'])).data.profiles).toHaveLength(1);
    expect(existsSync(resolve(dir, 'learning.lock'))).toBe(false);
  }, 20_000);

  it.each([false, true])('checks login and resumes course selection after reauthentication, expired=%s', expired => {
    const dir = home();
    command(dir, ['init']);
    command(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']);
    const cookies = resolve(dir, 'cookies.json');
    writeFileSync(cookies, JSON.stringify([{ name: 'sessionid', value: 'fixture-session', domain: 'www.yuketang.cn' }]));
    command(dir, ['login', '--profile', 'alpha', '--import', cookies]);
    const probe = fixture('ykt/qr-login').interactions.at(-1)!;
    if (expired) probe.response = { status: 401, body: { errcode: 401002 } };
    const result = terminal(dir, [
      { wait: '请选择操作', send: '1\n' },
      { wait: '选择账号', send: '1\n' },
      { wait: '搜索并选择课程', send: '\u0003' },
    ], [probe, ...(expired ? fixture('ykt/qr-login').interactions : []), ...fixture('ykt/courses-list').interactions]);
    expect(result.code).toBe(3);
    expect(result.screen).toContain('学术写作');
    expect(result.screen.includes('已登录账号')).toBe(expired);
    expect(result.screen).not.toMatch(/[a-f0-9]{64}|选择账号 \[[a-f0-9-]{36}\]|\[CANCELED\]|不会回滚/);
    expect(existsSync(resolve(dir, 'learning.lock'))).toBe(false);
  }, 20_000);

  it.each([false, true])('starts once with the chosen settings and returns home, custom=%s', async custom => {
    const dir = home();
    const outline = fixture('ykt/nested-outline');
    const chapters = (outline.interactions[2]!.response.body as { data: { course_chapter: Array<{ section_leaf_list: Array<{ leaf_type: number }> }> } }).data.course_chapter;
    chapters[0]!.section_leaf_list = chapters[0]!.section_leaf_list.filter(leaf => leaf.leaf_type === 3);
    const article = {
      request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/504/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } },
      response: { status: 200, body: { success: true, data: { leaf_type: 3, sku_id: 901, finish: true } } },
    };
    const result = terminal(dir, [
      { wait: '请选择操作', send: '1\n' },
      { wait: '选择平台', send: '1\n' },
      { wait: '账号名称', send: 'alpha\n' },
      { wait: '搜索并选择课程', send: '1\n' },
      { wait: '开始学习 [', send: custom ? '2\n' : '1\n' },
      ...(custom ? [
        { wait: '倍速（', send: '2\n' },
        { wait: '目标进度（%）', send: '50\n' },
        { wait: '按当前设置开始', send: '1\n' },
      ] : []),
      { wait: '请选择操作', occurrences: 2, send: '4\n' },
    ], [...fixture('ykt/qr-login').interactions, ...fixture('ykt/courses-list').interactions, ...outline.interactions, article, article]);
    expect(result.code, result.screen).toBe(0);
    expect(result.screen).toContain('按默认设置开始（5 倍速，完成整门课）');
    expect(result.screen).toContain('已完成');
    expect(result.screen).not.toMatch(/确认执行|任务 ID|等价命令|[a-f0-9]{64}/);
    const jobs = JSON.parse(command(dir, ['jobs', 'list', '--json'])).data.jobs as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('succeeded');
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    try { expect((await state.get(`job-input:${jobs[0]!.id}`))?.value).toMatchObject({ settings: { speed: custom ? 2 : 5, targetFraction: custom ? 0.5 : 1 } }); }
    finally { state.close(); }
  }, 20_000);

  it('keeps an indeterminate login and returns home without starting QR login', async () => {
    const dir = home();
    command(dir, ['init']);
    command(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']);
    const cookies = resolve(dir, 'cookies.json');
    writeFileSync(cookies, JSON.stringify([{ name: 'sessionid', value: 'fixture-session', domain: 'www.yuketang.cn' }]));
    command(dir, ['login', '--profile', 'alpha', '--import', cookies]);
    const beforeState = new SqliteStateStore(resolve(dir, 'state.db'));
    const session = await beforeState.list('session:', null, 10);
    beforeState.close();
    // An unregistered request fails closed in the fixture transport, simulating an unavailable connection.
    const result = terminal(dir, [
      { wait: '请选择操作', send: '1\n' },
      { wait: '选择账号', send: '1\n' },
      { wait: '请选择操作', occurrences: 2, send: '4\n' },
    ]);
    expect(result.code).toBe(0);
    expect(result.screen).toContain('暂时无法核验登录');
    expect(result.screen).not.toContain('请扫码登录');
    const afterState = new SqliteStateStore(resolve(dir, 'state.db'));
    try { expect(await afterState.list('session:', null, 10)).toEqual(session); }
    finally { afterState.close(); }
    expect(JSON.parse(command(dir, ['jobs', 'list', '--json'])).data.jobs).toEqual([]);
  }, 20_000);

  it('never replaces a missing key beside an existing database', () => {
    const dir = home();
    command(dir, ['init']);
    const database = readFileSync(resolve(dir, 'state.db'));
    rmSync(resolve(dir, 'master.key'));
    const result = terminal(dir, []);
    expect(result.code).not.toBe(0);
    expect(existsSync(resolve(dir, 'master.key'))).toBe(false);
    expect(readFileSync(resolve(dir, 'state.db'))).toEqual(database);
    expect(result.screen).toContain('密钥');
  }, 20_000);
});
