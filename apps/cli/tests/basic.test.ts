import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const cliEntry = resolve(import.meta.dirname, '../dist/index.js');
const tempRoots: string[] = [];

function runCli(args: string[], options: { home?: string; env?: Record<string, string>; homeBeforeCommand?: boolean } = {}) {
  const home = options.home ?? mkdtempSync(resolve(tmpdir(), 'learning-cli-'));
  if (options.home === undefined) tempRoots.push(home);
  const envHome = options.env?.LEARNING_HOME ?? mkdtempSync(resolve(tmpdir(), 'learning-env-'));
  if (options.env?.LEARNING_HOME === undefined) tempRoots.push(envHome);
  const invocation = options.homeBeforeCommand ? ['--home', home, ...args] : [...args, '--home', home];
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, ...invocation], {
      env: { ...process.env, LEARNING_HOME: envHome, ...(options.env ?? {}) },
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
    expect(existsSync(resolve(first.home, 'learning.lock'))).toBe(false);
    expect(statSync(first.home).mode & 0o777).toBe(0o700);
    expect(statSync(resolve(first.home, 'master.key')).mode & 0o777).toBe(0o600);
    expect(statSync(resolve(first.home, 'state.db')).mode & 0o777).toBe(0o600);
    expect(first.stdout).not.toContain(readFileSync(resolve(first.home, 'master.key'), 'utf8'));
  });

  it('creates a new local data directory with owner-only access', () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'learning-parent-'));
    tempRoots.push(parent);
    const target = resolve(parent, 'fresh-home');
    expect(runCli(['init'], { home: target }).exitCode).toBe(0);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it('--home overrides LEARNING_HOME explicitly', () => {
    for (const before of [false, true]) {
      const envHome = mkdtempSync(resolve(tmpdir(), 'learning-env-'));
      tempRoots.push(envHome);
      const run = runCli(['init'], { env: { LEARNING_HOME: envHome }, homeBeforeCommand: before });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(`已初始化：${run.home}`);
      expect(existsSync(resolve(run.home, 'master.key'))).toBe(true);
      expect(existsSync(resolve(envHome, 'master.key'))).toBe(false);
    }
  });

  it('LEARNING_HOME is used when --home is absent', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'learning-env-only-'));
    tempRoots.push(home);
    const stdout = execFileSync(process.execPath, [cliEntry, 'init'], {
      env: { ...process.env, LEARNING_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout).toContain(`已初始化：${home}`);
    expect(existsSync(resolve(home, 'master.key'))).toBe(true);
  });

  it('doctor reports missing browser without installing anything', () => {
    const run = runCli(['doctor']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('浏览器：未配置');
  });

  it('doctor uses the OS home instead of the working directory when HOME is unset', () => {
    const cwd = mkdtempSync(resolve(tmpdir(), 'learning-no-home-'));
    tempRoots.push(cwd);
    const env = { ...process.env };
    delete env.HOME;
    delete env.LEARNING_HOME;
    const osHome = execFileSync(process.execPath, ['--input-type=module', '-e', "import { homedir } from 'node:os'; process.stdout.write(homedir());"], {
      cwd, env, encoding: 'utf8',
    });
    const stdout = execFileSync(process.execPath, [cliEntry, 'doctor', '--json'], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(stdout).data.home).toBe(resolve(osHome, '.learning'));
    expect(existsSync(resolve(cwd, '.learning'))).toBe(false);
  });

  it('doctor and init agree on an absolute path for a relative --home', () => {
    const cwd = realpathSync(mkdtempSync(resolve(tmpdir(), 'learning-relative-home-')));
    tempRoots.push(cwd);
    const relative = '账号 数据';
    const home = resolve(cwd, relative);
    const run = (command: string) => JSON.parse(execFileSync(process.execPath, [cliEntry, command, '--home', relative, '--json'], {
      cwd, env: { ...process.env, LEARNING_HOME: resolve(cwd, 'ignored-env') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).data;
    expect(run('doctor')).toMatchObject({ home, initialized: false });
    expect(existsSync(home)).toBe(false);
    expect(run('init')).toMatchObject({ home, initialized: true });
    expect(run('doctor')).toMatchObject({ home, initialized: true });
    expect(existsSync(resolve(home, 'state.db'))).toBe(true);
    expect(existsSync(resolve(cwd, 'ignored-env'))).toBe(false);
  });

  it('doctor JSON reports actual local state and renderer limits in one result', () => {
    const init = runCli(['init']);
    const doctor = runCli(['doctor', '--json'], { home: init.home });
    expect(doctor.exitCode).toBe(0);
    const status = JSON.parse(doctor.stdout).data as { initialized: boolean; pdf: string; font: string; browser: string };
    expect(status.initialized).toBe(true);
    expect(status.pdf).toBe('available');
    expect(status.font).toContain('unavailable');
    expect(status.browser).toContain('not configured');
    expect(doctor.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('a live writer lock is rejected without replacing it', () => {
    const run = runCli(['init']);
    expect(run.exitCode).toBe(0);
    writeFileSync(resolve(run.home, 'learning.lock'), String(process.pid));
    const second = runCli(['init'], { home: run.home });
    expect(second.exitCode).toBe(3);
    expect(second.stderr).toContain(`pid ${process.pid}`);
    expect(readFileSync(resolve(run.home, 'learning.lock'), 'utf8')).toBe(String(process.pid));
  });

  it('a stale writer lock from a dead pid is taken over automatically', () => {
    const run = runCli(['init']);
    expect(run.exitCode).toBe(0);
    writeFileSync(resolve(run.home, 'learning.lock'), '2147483647');
    const second = runCli(['init'], { home: run.home });
    expect(second.exitCode).toBe(0);
    expect(existsSync(resolve(run.home, 'learning.lock'))).toBe(false);
  });

  it('an unreadable writer lock is still refused, never overwritten blindly', () => {
    const run = runCli(['init']);
    expect(run.exitCode).toBe(0);
    writeFileSync(resolve(run.home, 'learning.lock'), 'not-a-pid');
    const second = runCli(['init'], { home: run.home });
    expect(second.exitCode).toBe(3);
    expect(second.stderr).toContain('unreadable');
    expect(readFileSync(resolve(run.home, 'learning.lock'), 'utf8')).toBe('not-a-pid');
  });

  it('a normal second init keeps the existing key', () => {
    const first = runCli(['init']);
    const original = readFileSync(resolve(first.home, 'master.key'), 'utf8');
    const second = runCli(['init'], { home: first.home });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(resolve(first.home, 'master.key'), 'utf8')).toBe(original);
  });

  it('profile unlock removes a stale lock but refuses a live owner', () => {
    const init = runCli(['init']);
    expect(init.exitCode).toBe(0);
    const lockPath = resolve(init.home, 'learning.lock');
    writeFileSync(lockPath, String(process.pid));
    const active = runCli(['profile', 'unlock'], { home: init.home });
    expect(active.exitCode).toBe(3);
    expect(existsSync(lockPath)).toBe(true);
    writeFileSync(lockPath, '2147483647');
    const stale = runCli(['profile', 'unlock'], { home: init.home });
    expect(stale.exitCode).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });
});
