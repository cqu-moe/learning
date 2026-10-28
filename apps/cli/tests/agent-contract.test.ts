import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const home = mkdtempSync(resolve(tmpdir(), 'learning-agent-contract-'));
const entry = resolve(import.meta.dirname, '../dist/index.js');
afterAll(() => rmSync(home, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [entry, '--home', home, ...args], {
  encoding: 'utf8', timeout: 10_000,
  env: { ...process.env, CI: '1', NODE_ENV: 'test' },
});

it('discovers commands without initializing storage or requiring a terminal', () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body).toMatchObject({ schemaVersion: 1, ok: true, status: 'success', command: 'learning' });
  expect(body.data.commands.map((command: { name: string }) => command.name)).toContain('homework');
  expect(body.data.options.some((option: { flags: string }) => option.flags === '--profile <name>')).toBe(true);
  expect(existsSync(resolve(home, 'state.db'))).toBe(false);
  expect(result.stderr).toBe('');
});

it('returns structured missing inputs without prompting or creating local data', () => {
  const result = run('profile', 'add');
  expect(result.status, result.stderr).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', fields: expect.arrayContaining(['name', 'platform']) } });
  expect(existsSync(resolve(home, 'state.db'))).toBe(false);
  expect(result.stderr).toBe('');
});

it('exposes the required inputs of a command without invoking it', () => {
  const result = run('schema', 'homework', 'draft');
  expect(result.status, result.stderr).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.data.arguments).toContainEqual(expect.objectContaining({ name: 'resource', required: true }));
  expect(body.data.options).toContainEqual(expect.objectContaining({ flags: '-o, --output <file>', required: true }));
  expect(body.data.globalOptions).toContainEqual(expect.objectContaining({ flags: '--profile <name>' }));
  expect(existsSync(resolve(home, 'state.db'))).toBe(false);
});

it('wraps nested command help in the same JSON result without invoking it', () => {
  const result = run('homework', 'draft', '--help');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'homework draft', data: { text: expect.stringContaining('--output <file>') } });
  expect(result.stderr).toBe('');
  expect(existsSync(resolve(home, 'state.db'))).toBe(false);
});

it.each(['--quiet', '--no-interactive', '--no-color'])('rejects the removed human option %s', flag => {
  const result = run('doctor', flag);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
