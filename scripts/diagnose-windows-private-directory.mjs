// Diagnostic evidence only. The standalone catalog and real ACL checks remain gates.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { executable, releaseDirectory, root } from './build-cli.mjs';
import { platformProxy } from './helpers/platform-proxy.mjs';

assert.equal(process.platform, 'win32', 'Windows diagnostic requires a native Windows runner');
const output = resolve(root, 'dist/e2e');
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(resolve(root, 'dist/权限 诊断 '));
const report = { diagnosticOnly: true, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), probes: [], cleaned: false };
let proxy, asciiDirectory;
const failures = [];
try {
  proxy = await platformProxy(directory);
  const program = join(directory, executable);
  copyFileSync(resolve(releaseDirectory, executable), program);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const minimal = {
    PATH: '', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
    SystemRoot: systemRoot, CI: '1', LEARNING_TELEMETRY_DISABLED: '1',
    HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: proxy.ca,
  };
  // All user-specific directories are new and isolated. Never inherit a user's
  // profile, modules, proxy credentials, or credential-bearing environment.
  const windows = {
    ...minimal, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
    ComSpec: join(systemRoot, 'System32/cmd.exe'),
    APPDATA: join(directory, 'AppData/Roaming'), LOCALAPPDATA: join(directory, 'AppData/Local'),
    PSModulePath: join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  mkdirSync(windows.APPDATA, { recursive: true });
  mkdirSync(windows.LOCALAPPDATA, { recursive: true });
  // Execute the actual production script. The extracted source is never used
  // as a success oracle; markers only locate native execution stalls.
  const source = readFileSync(resolve(root, 'apps/cli/src/private-directory.ts'), 'utf8');
  const start = source.indexOf('const secureDirectoryScript = `') + 'const secureDirectoryScript = `'.length;
  const end = source.indexOf('`;', start);
  assert.ok(start >= 'const secureDirectoryScript = `'.length && end > start);
  const script = "Write-Output 'DIAG:start'\n" + source.slice(start, end)
    .replace('$ancestor = $root', "Write-Output 'DIAG:ancestors'\n$ancestor = $root")
    .replace('[void][System.IO.Directory]::CreateDirectory($root)', "Write-Output 'DIAG:create'\n[void][System.IO.Directory]::CreateDirectory($root)")
    .replace('Clear-And-GrantAcl $root $true', "Write-Output 'DIAG:acl'\nClear-And-GrantAcl $root $true\nWrite-Output 'DIAG:acl-done'")
    + "\nWrite-Output 'DIAG:done'";
  async function probe(name, command, args, env, timeoutMs, cwd = directory) {
    const started = Date.now();
    let stdout = '', stderrBytes = 0, spawnError, timedOut = false;
    const markerTimings = [];
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk.toString()).slice(0, 16_384);
      for (const line of stdout.split(/\r?\n/).slice(0, -1)) {
        const marker = line.trim();
        if (/^DIAG:(start|ready|ancestors|create|acl|acl-done|done)$/.test(marker) && !markerTimings.some(item => item.marker === marker)) {
          markerTimings.push({ marker, elapsedMs: Date.now() - started });
        }
      }
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.once('error', error => { spawnError = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'SPAWN_ERROR'; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) spawnSync(join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
      child.kill('SIGKILL');
    }, timeoutMs);
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    clearTimeout(timer);
    const markers = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^DIAG:(start|ready|ancestors|create|acl|acl-done|done)$/.test(line));
    let errorCode;
    try { const code = JSON.parse(stdout).error?.code; if (/^[A-Z0-9_]+$/.test(code ?? '')) errorCode = code; } catch { /* PowerShell marker output is not JSON. */ }
    report.probes.push({ name, elapsedMs: Date.now() - started, timeoutMs, timedOut, ...result, ...(spawnError ? { spawnError } : {}), markers, markerTimings, ...(errorCode ? { errorCode } : {}), stdoutBytes: Buffer.byteLength(stdout), stderrBytes });
    writeFileSync(join(output, 'windows-private-directory-diagnostic.json'), JSON.stringify(report, null, 2));
  }
  for (const [name, env] of [['minimal', minimal], ['windows-system-and-isolated-profile', windows]]) {
    await probe(`${name}:powershell-start`, powershell, ['-NoProfile', '-NonInteractive', '-Command', "Write-Output 'DIAG:ready'"], env, 35_000);
    await probe(`${name}:production-acl-script`, powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { ...env, LEARNING_PRIVATE_DIRECTORY_PATH: join(directory, `${name} 权限`) }, 35_000);
    await probe(`${name}:compiled-cli-init`, program, ['--home', join(directory, `${name} 账号`), 'init', '--json', '--no-interactive'], env, 75_000);
  }
  // Pure startup controls: no ACL/data path or trust-policy change. Bracket
  // these with the same baseline so a warm-up or runner-load shift is visible.
  asciiDirectory = mkdtempSync(resolve(root, 'dist/windows-ps-'));
  if (!/^[\x20-\x7e]+$/.test(asciiDirectory)) {
    throw Object.assign(new Error('ASCII startup control needs an ASCII checkout parent'), { code: 'ASCII_CONTROL_UNAVAILABLE' });
  }
  // Both path classes start with the same empty layout; do not compare the
  // previous CLI/TLS fixture contents with a fresh ASCII profile directory.
  for (const parent of [directory, asciiDirectory]) {
    for (const name of ['startup-profile', 'startup-temp', 'startup-cwd']) mkdirSync(join(parent, name));
  }
  const startup = {
    ...minimal, HOME: join(directory, 'startup-profile'), USERPROFILE: join(directory, 'startup-profile'),
    TMPDIR: join(directory, 'startup-temp'), TMP: join(directory, 'startup-temp'), TEMP: join(directory, 'startup-temp'),
  };
  const cwd = join(directory, 'startup-cwd');
  const osDiscovery = { ...startup };
  // Only these non-secret OS values from the disposable Windows CI runner.
  // A grouped improvement needs a later one-variable bisection, not a fix.
  for (const name of ['ProgramData', 'ALLUSERSPROFILE', 'COMPUTERNAME']) {
    if (!process.env[name]) throw Object.assign(new Error('OS startup control is unavailable'), { code: 'OS_CONTROL_UNAVAILABLE' });
    osDiscovery[name] = process.env[name];
  }
  const startupArgs = ['-NoProfile', '-NonInteractive', '-Command', "Write-Output 'DIAG:ready'"];
  for (const [name, env, workingDirectory] of [
    ['baseline-before', startup, cwd],
    ['os-discovery-variables', osDiscovery, cwd],
    ['ascii-profile-only', { ...startup, HOME: join(asciiDirectory, 'startup-profile'), USERPROFILE: join(asciiDirectory, 'startup-profile') }, cwd],
    ['ascii-temp-only', { ...startup, TMPDIR: join(asciiDirectory, 'startup-temp'), TMP: join(asciiDirectory, 'startup-temp'), TEMP: join(asciiDirectory, 'startup-temp') }, cwd],
    ['ascii-cwd-only', startup, join(asciiDirectory, 'startup-cwd')],
    ['baseline-after', startup, cwd],
  ]) {
    await probe(`startup:${name}`, powershell, startupArgs, env, 35_000, workingDirectory);
  }
  const network = proxy.evidence();
  report.network = { requests: network.requests, tunnels: network.tunnels };
} catch (error) {
  failures.push(error);
  report.failure = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name;
} finally {
  try { await proxy?.close(); } catch (error) { failures.push(error); }
  const directories = [directory, asciiDirectory].filter(Boolean);
  for (const owned of directories) {
    try {
      await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) { failures.push(error); }
  }
  report.cleaned = directories.every(owned => !existsSync(owned));
  writeFileSync(join(output, 'windows-private-directory-diagnostic.json'), JSON.stringify(report, null, 2));
  if (!report.cleaned) failures.push(new Error('Windows diagnostic left its isolated directory'));
}
if (failures.length) throw new AggregateError(failures, 'Windows diagnostic setup or cleanup failed');
