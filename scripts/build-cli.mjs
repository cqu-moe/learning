import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const bunVersion = readFileSync(resolve(root, '.bun-version'), 'utf8').trim();
export const cliVersion = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'))).version;
export const targets = ['windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
export const target = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]}-${process.arch}`;
export const executable = process.platform === 'win32' ? 'learning.exe' : 'learning';
export const stage = resolve(root, 'dist', `learning-${cliVersion}-${target}`);

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
  mkdirSync(stage, { recursive: true });
  compile('apps/cli/src/index.ts', resolve(stage, executable));
}
