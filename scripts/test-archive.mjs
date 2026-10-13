import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { executable, root, stage } from './build-cli.mjs';

const directory = mkdtempSync(resolve(tmpdir(), 'learning-archive-'));
const archive = resolve(root, 'dist/releases', `${basename(stage)}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
try {
  if (process.platform === 'win32') {
    execFileSync(resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:LEARNING_PACKAGE_ARCHIVE -DestinationPath $env:LEARNING_PACKAGE_DIR'],
      { env: { ...process.env, LEARNING_PACKAGE_ARCHIVE: archive, LEARNING_PACKAGE_DIR: directory }, stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', directory]);
  }
  assert.deepEqual(readdirSync(directory), [basename(stage)]);
  const binary = resolve(directory, basename(stage), executable);
  execFileSync(process.execPath, [resolve(root, 'scripts/test-binary.mjs'), binary], { stdio: 'inherit' });
  const script = process.platform === 'win32' ? 'test-windows-permissions.mjs' : 'test-binary-terminal.mjs';
  execFileSync(process.execPath, [resolve(root, 'scripts', script), binary], { stdio: 'inherit' });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
