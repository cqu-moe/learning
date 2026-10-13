import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { executable, releaseDirectory, root, target } from './build-cli.mjs';

const directory = mkdtempSync(resolve(tmpdir(), 'learning 独立程序 '));
try {
  const binary = resolve(directory, executable);
  copyFileSync(resolve(releaseDirectory, executable), binary);
  if (target.startsWith('macos-')) {
    const header = readFileSync(binary).subarray(0, 8);
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'expected a 64-bit Mach-O executable');
    assert.equal(header.readUInt32LE(4), target === 'macos-x64' ? 0x01000007 : 0x0100000c,
      'the executable architecture must match the matrix target');
  }
  // Browser/gh downloads do not retain the POSIX executable bit. Match INSTALL.md.
  if (process.platform !== 'win32') { chmodSync(binary, 0o644); chmodSync(binary, 0o755); }
  assert.deepEqual(readdirSync(directory), [executable], 'the program runs without companion files');
  execFileSync(process.execPath, [resolve(root, 'scripts/test-binary.mjs'), binary], { stdio: 'inherit' });
  const script = process.platform === 'win32' ? 'test-windows-permissions.mjs' : 'test-binary-terminal.mjs';
  execFileSync(process.execPath, [resolve(root, 'scripts', script), binary], { stdio: 'inherit' });
  console.log(`Validated ${target} on ${process.platform}/${process.arch}${target === 'macos-x64' && process.arch === 'arm64' ? ' via Rosetta (not native Intel)' : ''}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
