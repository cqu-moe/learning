import assert from 'node:assert/strict';
import { resolveTarget } from './build-cli.mjs';

assert.equal(resolveTarget(undefined, 'darwin', 'arm64'), 'macos-arm64');
assert.equal(resolveTarget('macos-x64', 'darwin', 'arm64'), 'macos-x64');
assert.equal(resolveTarget('linux-arm64', 'linux', 'arm64'), 'linux-arm64');
assert.equal(resolveTarget('windows-x64', 'win32', 'x64'), 'windows-x64');
assert.throws(() => resolveTarget('macos-x64', 'linux', 'x64'), /cannot validate/);
assert.throws(() => resolveTarget('linux-arm64', 'linux', 'x64'), /cannot validate/);
assert.throws(() => resolveTarget('../macos-x64', 'darwin', 'arm64'), /unsupported/);
console.log('OK explicit release targets, native runners and macOS Rosetta exception');
