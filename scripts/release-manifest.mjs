import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliVersion, targets } from './build-cli.mjs';

export function releaseManifest(directory, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const archives = targets.map(target => `learning-${version}-${target}.${target.startsWith('windows') ? 'zip' : 'tar.gz'}`);
  assert.deepEqual(readdirSync(directory).filter(name => name !== 'SHA256SUMS').sort(),
    archives.flatMap(name => [name, `${name}.sha256`]).sort(), 'exactly five release archives and checksums required');
  return archives.map(name => {
    const hash = createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex');
    const line = `${hash}  ${name}\n`;
    assert.equal(readFileSync(resolve(directory, `${name}.sha256`), 'utf8'), line, `checksum mismatch: ${name}`);
    return line;
  }).join('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  writeFileSync(resolve(directory, 'SHA256SUMS'), releaseManifest(directory, cliVersion));
  console.log('OK five release archives and SHA256SUMS');
}
