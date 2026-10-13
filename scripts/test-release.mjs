import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { targets } from './build-cli.mjs';
import { releaseManifest } from './release-manifest.mjs';

const directory = mkdtempSync(resolve(tmpdir(), 'learning-release-'));
try {
  assert.throws(() => releaseManifest(directory, '0.2.1'), /exactly five/);
  for (const target of targets) {
    const name = `learning-0.2.1-${target}.${target.startsWith('windows') ? 'zip' : 'tar.gz'}`;
    const bytes = Buffer.from(`fixture-${target}`);
    writeFileSync(resolve(directory, name), bytes);
    writeFileSync(resolve(directory, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  assert.equal(releaseManifest(directory, '0.2.1').trim().split('\n').length, 5);
  assert.throws(() => releaseManifest(directory, '0.2.2'), /exactly five/);
  writeFileSync(resolve(directory, 'learning-0.2.1-windows-x64.zip'), 'tampered');
  assert.throws(() => releaseManifest(directory, '0.2.1'), /checksum mismatch/);
  assert.throws(() => releaseManifest(directory, '../bad'), /match/);
  console.log('OK release refuses missing targets, wrong version, invalid version and tampered archives');
} finally { rmSync(directory, { recursive: true, force: true }); }
