import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const cli = resolve(import.meta.dirname, '../dist/index.js');
const homes: string[] = [];
const home = () => {
  const path = mkdtempSync(resolve(tmpdir(), 'learning-home-'));
  homes.push(path);
  return path;
};
const run = (directory: string, args: string[]) => spawnSync(process.execPath, [cli, '--home', directory, ...args], {
  encoding: 'utf8',
  timeout: 10_000,
  env: { ...process.env, CI: '1', LEARNING_TELEMETRY_DISABLED: '1' },
});
const json = (directory: string, args: string[]) => {
  const result = run(directory, args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

afterAll(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('command discovery entry points', () => {
  it('returns a machine-readable root catalog without initializing storage', () => {
    const directory = home();
    const result = json(directory, []);
    expect(result).toMatchObject({ schemaVersion: 1, command: 'learning', ok: true, status: 'success' });
    expect(result.data).toMatchObject({ name: 'learning', arguments: [], globalOptions: [] });
    expect(result.data.commands.map((command: { name: string }) => command.name)).toEqual(expect.arrayContaining(['profile', 'homework', 'jobs']));
    expect(result.data.options.map((option: { flags: string }) => option.flags)).toEqual(expect.arrayContaining(['--home <dir>', '--profile <name>', '--json', '--output-format <format>']));
    expect(existsSync(resolve(directory, 'state.db'))).toBe(false);
    expect(existsSync(resolve(directory, 'master.key'))).toBe(false);
  });

  it('returns command-group catalogs with their own subcommands', () => {
    const directory = home();
    const result = json(directory, ['profile']);
    expect(result.command).toBe('profile');
    expect(result.data).toMatchObject({ name: 'profile', arguments: [], globalOptions: expect.arrayContaining([expect.objectContaining({ flags: '--profile <name>' })]) });
    expect(result.data.commands.map((command: { name: string }) => command.name)).toEqual(expect.arrayContaining(['add', 'list', 'remove']));
    expect(existsSync(resolve(directory, 'state.db'))).toBe(false);
  });

  it('does not inspect or repair local storage while discovering commands', () => {
    const directory = home();
    expect(run(directory, ['init']).status).toBe(0);
    const database = readFileSync(resolve(directory, 'state.db'));
    rmSync(resolve(directory, 'master.key'));
    const result = json(directory, []);
    expect(result.ok).toBe(true);
    expect(existsSync(resolve(directory, 'master.key'))).toBe(false);
    expect(readFileSync(resolve(directory, 'state.db'))).toEqual(database);
  });

  it('requires profile add inputs without prompting', () => {
    const directory = home();
    const result = run(directory, ['profile', 'add']);
    expect(result.status, result.stderr).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(body.error.fields).toEqual(expect.arrayContaining(['name', 'platform']));
    expect(result.stdout).not.toMatch(/账号名称|选择平台|请选择/);
    expect(existsSync(resolve(directory, 'state.db'))).toBe(false);
  });

  it.each(['pretty', 'plain'])('rejects removed output format %s', format => {
    const directory = home();
    const result = run(directory, ['--output-format', format]);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(existsSync(resolve(directory, 'state.db'))).toBe(false);
  });
});
