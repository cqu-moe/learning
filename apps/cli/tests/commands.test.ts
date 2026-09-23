import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const cliEntry = resolve(import.meta.dirname, '../dist/index.js');
const tempRoots: string[] = [];

function runCli(args: string[]) {
  const home = mkdtempSync(resolve(tmpdir(), 'learning-cmds-'));
  tempRoots.push(home);
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, ...args, '--home', home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 1 };
  }
}

afterAll(() => {
  for (const home of tempRoots) rmSync(home, { recursive: true, force: true });
});

describe('cli commands (T26, A261/A262)', () => {
  it('help lists the command groups', () => {
    const run = runCli(['--help']);
    expect(run.exitCode).toBe(0);
    for (const name of ['init', 'doctor', 'jobs', 'exam', 'run', 'download']) {
      expect(run.stdout).toContain(name);
    }
  });

  it('exam submit without --yes --final refuses with exit 2', () => {
    const run = runCli(['exam', 'submit', 'draft.yaml']);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('--yes --final');
  });

  it('run and download accept --dry-run without writes', () => {
    const runA = runCli(['run', '--dry-run']);
    expect(runA.exitCode).toBe(0);
    expect(JSON.parse(runA.stdout)).toMatchObject({ command: 'run', dryRun: true });
    const runB = runCli(['download', '--dry-run']);
    expect(JSON.parse(runB.stdout)).toMatchObject({ command: 'download', dryRun: true });
  });

  it('jobs list prints structured json and reconcile reports read-only state', () => {
    const list = runCli(['jobs', 'list']);
    expect(list.exitCode).toBe(0);
    expect(() => JSON.parse(list.stdout)).not.toThrow();
    const rec = runCli(['jobs', 'reconcile', 'job-1']);
    expect(JSON.parse(rec.stdout)).toMatchObject({ jobId: 'job-1', state: 'no-pending-operation' });
  });
});
