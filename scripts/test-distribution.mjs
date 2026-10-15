import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executable, releaseDirectory, root } from './build-cli.mjs';

const { values } = parseArgs({ options: { 'without-telemetry': { type: 'boolean', default: false } } });
const telemetryArgs = values['without-telemetry'] ? ['--without-telemetry'] : [];
const directory = mkdtempSync(resolve(tmpdir(), 'learning 独立程序 '));
const failures = [];
try {
  const binary = resolve(directory, executable);
  copyFileSync(resolve(releaseDirectory, executable), binary);
  // Browser/gh downloads do not retain the POSIX executable bit. Match INSTALL.md.
  if (process.platform !== 'win32') { chmodSync(binary, 0o644); chmodSync(binary, 0o755); }
  assert.deepEqual(readdirSync(directory), [executable], 'the program runs without companion files');
  execFileSync(process.execPath, [resolve(root, 'scripts/test-binary.mjs'), binary, ...telemetryArgs], { stdio: 'inherit' });
  const script = process.platform === 'win32' ? 'test-windows-permissions.mjs' : 'test-binary-terminal.mjs';
  execFileSync(process.execPath, [resolve(root, 'scripts', script), binary], { stdio: 'inherit' });
} catch (error) { failures.push(error); } finally {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(existsSync(directory), false, 'isolated directory still exists after cleanup');
  } catch (error) { failures.push(error); }
}
if (failures.length) throw new AggregateError(failures, 'standalone distribution failed; primary and cleanup errors retained');
