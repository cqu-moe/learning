import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteStateStore } from '@learning/sdk/node';

const root = mkdtempSync(resolve(tmpdir(), 'learning-terminal-'));
const cli = resolve(import.meta.dirname, '../dist/index.js');
const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');

afterAll(() => rmSync(root, { recursive: true, force: true }));

type TerminalStep = { wait: string; send?: string; signal?: string; occurrences?: number };
type TerminalResult = { code: number; screen: string; steps: number };

function terminal(args: string[], steps: TerminalStep[] = [], bare = false, preload?: string) {
  const result = spawnSync('python3', [driver, JSON.stringify({
    argv: [process.execPath, ...(preload ? ['--import', preload] : []), cli, ...(bare ? [] : ['--home', root]), ...args],
    steps,
    columns: 32,
    env: bare
      ? { PATH: '', HOME: root, USERPROFILE: root, LEARNING_HOME: resolve(root, '首次使用'), NODE_OPTIONS: '', BUN_OPTIONS: '' }
      : { LEARNING_TELEMETRY_DISABLED: '1' },
  })], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as TerminalResult;
}

function envelope(result: TerminalResult) {
  const lines = result.screen.replaceAll('\r', '').trim().split('\n').filter(line => line.startsWith('{'));
  expect(lines, result.screen).not.toHaveLength(0);
  return JSON.parse(lines.at(-1)!);
}

function expectCatalog(value: unknown) {
  expect(value).toMatchObject({
    schemaVersion: 1, ok: true, status: 'success',
    data: { name: expect.any(String), arguments: expect.any(Array), commands: expect.any(Array), options: expect.any(Array), globalOptions: expect.any(Array) },
  });
}

describe('real terminal agent contract', () => {
  it('returns a JSON command directory without initializing storage or asking a question', () => {
    const result = terminal([], [], true);
    expect(result.code, result.screen).toBe(0);
    expect(result.screen).not.toContain('\u001b');
    expect(result.screen).not.toMatch(/请选择|账号名称|选择平台|Type:|Search:/);
    expectCatalog(envelope(result));
    expect(existsSync(resolve(root, '首次使用', 'state.db'))).toBe(false);
    expect(existsSync(resolve(root, '首次使用', 'master.key'))).toBe(false);
  }, 20_000);

  it('returns a JSON command directory for a command group', () => {
    const result = terminal(['profile']);
    expect(result.code, result.screen).toBe(0);
    const body = envelope(result);
    expectCatalog(body);
    expect(body.command).toBe('profile');
    expect(body.data.commands.map((command: { name: string }) => command.name)).toContain('add');
    expect(existsSync(resolve(root, 'state.db'))).toBe(false);
  }, 20_000);

  it('keeps the profile name as a positional argument', () => {
    expect(terminal(['init']).code).toBe(0);
    const result = terminal(['profile', 'add', 'agent-user', '--platform', 'ykt']);
    expect(result.code, result.screen).toBe(0);
    expect(envelope(result)).toMatchObject({ ok: true, data: { name: 'agent-user' } });
    expect(result.screen).not.toContain('--name');
  }, 20_000);

  it('reports missing positional and option inputs as JSON before initialization', () => {
    const result = terminal(['profile', 'add'], [], true);
    expect(result.code, result.screen).toBe(2);
    const body = envelope(result);
    expect(body).toMatchObject({ ok: false, status: 'error', error: { code: 'INVALID_INPUT' } });
    expect(body.error.fields).toEqual(expect.arrayContaining(['name', 'platform']));
    expect(result.screen).not.toMatch(/账号名称|选择平台|请选择/);
    expect(result.screen).not.toContain('\u001b');
    expect(existsSync(resolve(root, '首次使用', 'state.db'))).toBe(false);
  }, 20_000);

  it.each([
    ['--no-interactive'],
    ['--quiet'],
    ['--no-color'],
    ['--output-format', 'pretty'],
    ['--output-format', 'plain'],
  ])('rejects removed human option %s in a terminal', (...flags) => {
    const result = terminal(flags);
    expect(result.code, result.screen).toBe(2);
    expect(envelope(result)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(result.screen).not.toContain('\u001b');
    expect(result.screen).not.toMatch(/请选择|账号名称|选择平台/);
  }, 20_000);

  it('returns version and help text inside JSON envelopes', async () => {
    const version = envelope(terminal(['--version']));
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string };
    const expected = manifest.version;
    expect(version).toMatchObject({ ok: true, data: { text: expected } });
    const help = envelope(terminal(['--help']));
    expect(help.data.text).toContain('Usage:');
    expect(help.data.text).toContain('--output-format <format>');
    expect(help.data.text).not.toContain('--no-interactive');
  }, 20_000);
});

describe('terminal signal safety', () => {
  beforeAll(() => {
    expect(terminal(['init']).code).toBe(0);
    expect(terminal(['profile', 'add', 'signal-user', '--platform', 'ykt']).code).toBe(0);
  });
  async function seedJob(name: string) {
    const state = new SqliteStateStore(resolve(root, 'state.db'));
    try {
      const profile = await state.get('cli:profile:signal-user');
      const scope = (profile!.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
      await state.commit({
        expected: [{ key: `job:${name}`, revision: null }, { key: `job-meta:${name}`, revision: null }],
        changes: [
          { key: `job:${name}`, value: { id: name, scope, kind: 'export', status: 'waiting', createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: Date.now() + 30_000, completed: 0, total: 1, items: [], warnings: [] } },
          { key: `job-meta:${name}`, value: { inputDigest: 'x', generation: 1, cursor: null, pendingOperationId: null, running: false } },
        ],
      });
    } finally { state.close(); }
  }

  it.each(['SIGINT', 'SIGTERM'])('persists cancellation and releases the lock on %s', async signal => {
    const name = `terminal-${signal.toLowerCase()}`;
    await seedJob(name);
    const result = terminal(['jobs', 'resume', name, '--output-format', 'jsonl'], [{ wait: `"jobId":"${name}"`, signal }], false,
      'data:text/javascript,await new Promise(resolve => setTimeout(resolve, 500))');
    expect(result.code, result.screen).toBe(3);
    const lines = result.screen.replaceAll('\r', '').trim().split('\n').filter(line => line.startsWith('{'));
    const events = lines.map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: 'progress', data: expect.objectContaining({ jobId: name, status: 'waiting' }) }));
    expect(events.at(-1)).toMatchObject({ type: 'result', data: { status: 'canceled', exitCode: 3, error: { code: 'CANCELED' } } });
    const saved = spawnSync(process.execPath, [cli, '--home', root, 'jobs', 'show', name, '--json'], { encoding: 'utf8' });
    expect(saved.status, saved.stderr).toBe(0);
    expect(JSON.parse(saved.stdout).data.status).toBe('paused');
    expect(existsSync(resolve(root, 'learning.lock'))).toBe(false);
  }, 20_000);
});
