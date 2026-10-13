import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseManifest, releaseManifest } from './release-manifest.mjs';

const directory = mkdtempSync(resolve(tmpdir(), 'learning-release-'));
const names = ['learning-0.2.3-windows-x64.exe', 'learning-0.2.3-macos-x64',
  'learning-0.2.3-macos-arm64', 'learning-0.2.3-linux-x64', 'learning-0.2.3-linux-arm64', 'LICENSES.txt'];
function fixture(name) {
  const bytes = Buffer.from(`fixture-${name}`);
  writeFileSync(resolve(directory, name), bytes);
  const line = `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`;
  writeFileSync(resolve(directory, `${name}.sha256`), line);
  return line;
}
try {
  const expected = names.map(fixture).join('');
  assert.equal(releaseManifest(directory, '0.2.3'), expected);
  assert.deepEqual(parseManifest(expected, '0.2.3').map(item => item.name), names);
  for (const invalid of [expected.replace(/LICENSES.txt\n$/, '../LICENSES.txt\n'),
    expected.replace(/LICENSES.txt\n$/, names[0] + '\n'), expected.split('\n').slice(1).join('\n'),
    expected + expected.split('\n')[0] + '\n', expected.replace(/^[a-f0-9]/, 'z')]) {
    assert.throws(() => parseManifest(invalid, '0.2.3'));
  }
  assert.throws(() => releaseManifest(directory, '0.2.2'), /exactly five/);
  for (const name of [names[0], 'LICENSES.txt']) {
    rmSync(resolve(directory, name));
    assert.throws(() => releaseManifest(directory, '0.2.3'), /exactly five/);
    fixture(name);
    writeFileSync(resolve(directory, name), 'tampered');
    assert.throws(() => releaseManifest(directory, '0.2.3'), /checksum mismatch/);
    fixture(name);
  }
  fixture('learning-0.2.3-windows-x64.zip');
  assert.throws(() => releaseManifest(directory, '0.2.3'), /exactly five/);
  assert.throws(() => releaseManifest(directory, '../bad'), /match/);
  console.log('OK direct executables and separate licenses: exact assets, checksums and rejected archives');
} finally { rmSync(directory, { recursive: true, force: true }); }
