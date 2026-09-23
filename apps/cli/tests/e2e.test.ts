import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

const tempRoots: string[] = [];

function runPackedCli(args: string[], home = mkdtempSync(resolve(tmpdir(), 'learning-e2e-'))) {
  if (!tempRoots.includes(home)) tempRoots.push(home);
  try {
    const stdout = execFileSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), ...args, '--home', home], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: home,
      env: { ...process.env, LEARNING_HOME: home },
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

describe('packed cli e2e (T31, A311/A312)', () => {
  it('--help works from built output', () => {
    const run = runPackedCli(['--help']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('learning');
  });

  it('version matches the package manifest', () => {
    const run = runPackedCli(['--version']);
    expect(run.stdout.trim()).toBe(pkg.version);
  });

  it('init/doctor run offline without any cloud configuration', () => {
    const init = runPackedCli(['init']);
    expect(init.exitCode).toBe(0);
    const doctor = runPackedCli(['doctor'], init.home);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain('node:');
    const jobs = runPackedCli(['jobs', 'list'], init.home);
    expect(jobs.exitCode).toBe(0);
    expect(JSON.parse(jobs.stdout)).toEqual([]);
  });

  it('no unapproved live platform writes happen in offline e2e', () => {
    const run = runPackedCli(['run', 'fixture-course', '--dry-run']);
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not initialized');
    expect(run.stdout).not.toContain('yuketang.cn');
    expect(run.stdout).not.toContain('xuetangx.com');
    expect(run.stdout).not.toContain('zhihuishu.com');
  });
});
