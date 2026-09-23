import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const cliEntry = resolve(import.meta.dirname, '../dist/index.js');
const tempRoots: string[] = [];

function runCli(args: string[], options: { home?: string; env?: Record<string, string> } = {}) {
  const home = options.home ?? mkdtempSync(resolve(tmpdir(), 'learning-cli-'));
  if (options.home === undefined) tempRoots.push(home);
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, ...args, '--home', home], {
      env: { ...process.env, LEARNING_HOME: home, ...(options.env ?? {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0, home };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 1, home };
  }
}

afterAll(() => {
  for (const home of tempRoots) rmSync(home, { recursive: true, force: true });
});

describe('cli basics (T25, A251/A252)', () => {
  it('--version prints the package version', () => {
    const run = runCli(['--version']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('init creates the master key once and prints no secrets', () => {
    const first = runCli(['init']);
    expect(first.exitCode).toBe(0);
    expect(existsSync(resolve(first.home, 'master.key'))).toBe(true);
    expect(first.stdout).not.toContain(readFileSync(resolve(first.home, 'master.key'), 'utf8'));
  });

  it('doctor reports missing browser without installing anything', () => {
    const run = runCli(['doctor']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('browser: not configured');
  });

  it('a second concurrent writer in the same home is rejected with CONFLICT semantics', () => {
    const run = runCli(['init']);
    expect(run.exitCode).toBe(0);
    const lock = readFileSync(resolve(run.home, 'learning.lock'), 'utf8').trim();
    const second = runCli(['init'], { home: run.home });
    expect(second.exitCode).toBe(3);
    expect(second.stderr).toContain(`pid ${lock}`);
  });
});
