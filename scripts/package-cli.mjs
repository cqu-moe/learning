import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { bunVersion, cliVersion, executable, root, stage, target } from './build-cli.mjs';

// Produced by the frozen pnpm installation; copy license texts, never local paths.
const groups = JSON.parse(readFileSync(resolve(root, 'dist/licenses.json')));
const notices = [`Bun ${bunVersion}: https://github.com/oven-sh/bun/tree/bun-v${bunVersion}\nSee BUN-LICENSE.md for runtime dependencies and rebuilding instructions.`];
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
writeFileSync(resolve(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n====================\n\n'));
copyFileSync(resolve(root, 'docs/BUN-LICENSE.md'), resolve(stage, 'BUN-LICENSE.md'));
copyFileSync(resolve(root, 'docs/INSTALL.md'), resolve(stage, 'INSTALL.md'));
writeFileSync(resolve(stage, 'BUILD.json'), JSON.stringify({ version: cliVersion, bun: bunVersion, target,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }, null, 2) + '\n');
const expected = ['BUILD.json', 'BUN-LICENSE.md', 'INSTALL.md', 'THIRD-PARTY-NOTICES.txt', executable].sort();
assert.deepEqual(readdirSync(stage).sort(), expected, 'release includes only the executable and distribution documents');
const output = resolve(root, 'dist/releases');
mkdirSync(output, { recursive: true });
const archive = resolve(output, `${basename(stage)}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
if (process.platform === 'win32') {
  execFileSync(resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:LEARNING_PACKAGE_DIR -DestinationPath $env:LEARNING_PACKAGE_ARCHIVE -Force'],
    { env: { ...process.env, LEARNING_PACKAGE_DIR: stage, LEARNING_PACKAGE_ARCHIVE: archive }, stdio: 'inherit' });
} else {
  execFileSync('tar', ['-czf', archive, '-C', resolve(root, 'dist'), basename(stage)], { stdio: 'inherit' });
}
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
console.log(archive);
