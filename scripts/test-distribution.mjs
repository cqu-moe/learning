import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executable, releaseDirectory, root } from './build-cli.mjs';

const { values } = parseArgs({ options: { 'without-telemetry': { type: 'boolean', default: false } } });
const telemetryArgs = values['without-telemetry'] ? ['--without-telemetry'] : [];
const directory = mkdtempSync(resolve(tmpdir(), 'learning 独立程序 '));
try {
  const binary = resolve(directory, executable);
  copyFileSync(resolve(releaseDirectory, executable), binary);
  // Browser/gh downloads do not retain the POSIX executable bit. Match INSTALL.md.
  if (process.platform !== 'win32') { chmodSync(binary, 0o644); chmodSync(binary, 0o755); }
  assert.deepEqual(readdirSync(directory), [executable], 'the program runs without companion files');
  execFileSync(process.execPath, [resolve(root, 'scripts/test-binary.mjs'), binary, ...telemetryArgs], { stdio: 'inherit' });
  const script = process.platform === 'win32' ? 'test-windows-permissions.mjs' : 'test-binary-terminal.mjs';
  execFileSync(process.execPath, [resolve(root, 'scripts', script), binary], { stdio: 'inherit' });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
