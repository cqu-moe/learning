import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const bunVersion = readFileSync(resolve(root, '.bun-version'), 'utf8').trim();
export const cliVersion = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'))).version;
export const targets = ['windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
export const target = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]}-${process.arch}`;
export const executable = `learning-${cliVersion}-${target}${process.platform === 'win32' ? '.exe' : ''}`;
export const releaseDirectory = resolve(root, 'dist/releases');

export function compile(entry, outfile) {
  const bun = process.env.BUN_BINARY ?? 'bun';
  assert.equal(execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(), bunVersion, 'use the pinned Bun version');
  execFileSync(bun, ['build', '--compile', '--minify', '--bytecode', '--format=esm',
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
    entry, '--outfile', outfile], { cwd: root, stdio: 'inherit' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(targets.includes(target), `unsupported release target: ${target}`);
  assert.match(cliVersion, /^\d+\.\d+\.\d+$/);
  mkdirSync(releaseDirectory, { recursive: true });
  const binary = resolve(releaseDirectory, executable);
  compile('apps/cli/src/index.ts', binary);
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(`${binary}.sha256`, `${digest}  ${executable}\n`);
}
