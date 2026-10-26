import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const bunVersion = readFileSync(resolve(root, '.bun-version'), 'utf8').trim();
export const cliVersion = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'))).version;
export const targets = ['windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64', 'linux-arm64'];
export const target = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]}-${process.arch}`;
export const executable = `learning-${cliVersion}-${target}${process.platform === 'win32' ? '.exe' : ''}`;
export const releaseDirectory = resolve(root, 'dist/releases');
const publicTokenPattern = /^phc_[A-Za-z0-9_-]{20,}$/;

export function compile(entry, outfile, options = {}) {
  const bun = process.env.BUN_BINARY ?? 'bun';
  assert.equal(execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(), bunVersion, 'use the pinned Bun version');
  execFileSync(bun, [resolve(root, 'scripts/bun-build-cli.mjs'), entry, outfile,
    ...(options.bundledTelemetryToken === undefined ? [] : [JSON.stringify(options.bundledTelemetryToken)])],
  { cwd: root, stdio: 'inherit' });
  // Bun compile emits an external map for build tooling, while the executable embeds its own copy.
  rmSync(`${outfile}.map`, { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(targets.includes(target), `unsupported release target: ${target}`);
  assert.match(cliVersion, /^\d+\.\d+\.\d+$/);
  const { values } = parseArgs({ options: { 'without-telemetry': { type: 'boolean', default: false } } });
  // PR artifacts must build without repository configuration; release builds stay strict.
  const buildToken = values['without-telemetry'] ? '' : process.env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!values['without-telemetry'] && (buildToken === undefined || !publicTokenPattern.test(buildToken))) {
    throw new Error('POSTHOG_PROJECT_TOKEN must be configured as a valid public PostHog token');
  }
  mkdirSync(releaseDirectory, { recursive: true });
  const binary = resolve(releaseDirectory, executable);
  compile('apps/cli/src/index.ts', binary, { bundledTelemetryToken: buildToken });
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(`${binary}.sha256`, `${digest}  ${executable}\n`);
}
