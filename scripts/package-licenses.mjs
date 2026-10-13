import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { releaseDirectory, root } from './build-cli.mjs';

// Produced by the frozen pnpm installation; copy license texts, never local paths.
const groups = JSON.parse(readFileSync(resolve(root, 'dist/licenses.json')));
const notices = [readFileSync(resolve(root, 'docs/BUN-LICENSE.md'), 'utf8')];
for (const dependency of Object.values(groups).flat().sort((a, b) => a.name.localeCompare(b.name))) {
  const texts = [];
  for (const directory of dependency.paths) {
    for (const name of readdirSync(directory).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name))) {
      texts.push(readFileSync(resolve(directory, name), 'utf8'));
    }
  }
  assert.ok(texts.length, `missing license text: ${dependency.name}`);
  notices.push(`${dependency.name} ${dependency.versions.join(', ')} (${dependency.license})\n${[...new Set(texts)].join('\n')}`);
}
mkdirSync(releaseDirectory, { recursive: true });
const path = resolve(releaseDirectory, 'LICENSES.txt');
const content = notices.join('\n\n====================\n\n');
writeFileSync(path, content);
const digest = createHash('sha256').update(content).digest('hex');
writeFileSync(`${path}.sha256`, `${digest}  LICENSES.txt\n`);
console.log(path);
