import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliVersion, targets } from './build-cli.mjs';

function assetNames(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  return [...targets.map(target => `learning-${version}-${target}${target.startsWith('windows') ? '.exe' : ''}`), 'LICENSES.txt'];
}

export function parseManifest(content, version) {
  const entries = content.trimEnd().split('\n').map(line => {
    const match = /^([a-f0-9]{64}) {2}([\w.-]+)$/.exec(line);
    assert.ok(match, 'invalid published checksum manifest');
    return { digest: match[1], name: match[2] };
  });
  assert.deepEqual(entries.map(item => item.name).sort(), assetNames(version).sort(), 'published manifest must list every asset exactly once');
  return entries;
}

export function releaseManifest(directory, version) {
  const assets = assetNames(version);
  assert.deepEqual(readdirSync(directory).filter(name => name !== 'SHA256SUMS').sort(),
    assets.flatMap(name => [name, `${name}.sha256`]).sort(), 'exactly five executables, LICENSES.txt and checksums required');
  return assets.map(name => {
    const hash = createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex');
    const line = `${hash}  ${name}\n`;
    assert.equal(readFileSync(resolve(directory, `${name}.sha256`), 'utf8'), line, `checksum mismatch: ${name}`);
    return line;
  }).join('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  writeFileSync(resolve(directory, 'SHA256SUMS'), releaseManifest(directory, cliVersion));
  console.log('OK five executables, separate licenses and SHA256SUMS');
}
