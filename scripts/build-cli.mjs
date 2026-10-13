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
export function resolveTarget(requested, platform = process.platform, arch = process.arch) {
  const native = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[platform]}-${arch}`;
  const selected = requested ?? native;
  assert.ok(targets.includes(selected), `unsupported release target: ${selected}`);
  assert.ok(selected === native || (native === 'macos-arm64' && selected === 'macos-x64'),
    `cannot validate ${selected} on ${native}; only macOS x64 under Rosetta is supported`);
  return selected;
}
export const target = resolveTarget(process.env.LEARNING_BUILD_TARGET);
export const executable = `learning-${cliVersion}-${target}${target === 'windows-x64' ? '.exe' : ''}`;
export const releaseDirectory = resolve(root, 'dist/releases');
const publicTokenPattern = /^phc_[A-Za-z0-9_-]{20,}$/;

export function compile(entry, outfile, options = {}) {
  const bun = process.env.BUN_BINARY ?? 'bun';
  assert.equal(execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(), bunVersion, 'use the pinned Bun version');
  const args = ['build', '--compile', `--target=bun-${target.replace('macos-', 'darwin-')}`, '--minify', '--bytecode', '--format=esm',
    '--env=disable', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'];
  if (options.bundledTelemetryToken !== undefined) {
    args.push('--define', `process.env.LEARNING_BUNDLED_TELEMETRY_TOKEN=${JSON.stringify(options.bundledTelemetryToken)}`);
  }
  args.push(entry, '--outfile', outfile);
  execFileSync(bun, args, { cwd: root, stdio: 'inherit' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(targets.includes(target), `unsupported release target: ${target}`);
  assert.match(cliVersion, /^\d+\.\d+\.\d+$/);
  const buildToken = process.env.POSTHOG_PROJECT_TOKEN?.trim();
  if (buildToken === undefined || !publicTokenPattern.test(buildToken)) {
    throw new Error('POSTHOG_PROJECT_TOKEN must be configured as a valid public PostHog token');
  }
  mkdirSync(releaseDirectory, { recursive: true });
  const binary = resolve(releaseDirectory, executable);
  compile('apps/cli/src/index.ts', binary, { bundledTelemetryToken: buildToken });
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(`${binary}.sha256`, `${digest}  ${executable}\n`);
}
