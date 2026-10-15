import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { platformProxy } from './helpers/platform-proxy.mjs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

for (const control of ['wrong-expectation', 'missing-fixture', 'unregistered-host', 'unregistered-route', 'ws-unregistered-route', 'ws-missing-fixture', 'ws-wrong-message']) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-catalog.mjs'), ...(process.argv[2] ? [process.argv[2]] : []), '--' + control], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.error, undefined, 'negative control could not launch');
  assert.equal(result.status, 1, 'negative control must fail with an assertion, not be skipped');
  const messages = { 'wrong-expectation': /incorrect title negative control/, 'missing-fixture': /ENOENT/, 'unregistered-host': /Outbound destination rejected/, 'unregistered-route': /platform path mismatch/, 'ws-unregistered-route': /WebSocket path mismatch/, 'ws-missing-fixture': /undeclared WebSocket request/, 'ws-wrong-message': /WebSocket message or response rejected/ };
  assert.match(result.stderr, messages[control]);
}
console.log('OK catalog negative controls: wrong result, missing fixture and binary host/route rejection exit nonzero');

// These external executables exercise runner diagnostics, not platform success.
// A Windows executable cannot be replaced with a shebang script; native CI
// records the same metadata while exercising the real PowerShell/ACL path.
if (process.platform !== 'win32') {
  const directory = mkdtempSync(resolve(root, 'dist/catalog-process-controls-'));
  try {
    for (const mode of ['timeout', 'empty', 'invalid']) {
      const reportsBefore = new Set(readdirSync(resolve(root, 'dist/e2e')));
      const tool = resolve(directory, 'external-command');
      writeFileSync(tool, '#!/bin/sh\nexec "' + process.execPath + '" --input-type=commonjs - "$@" <<\'SCRIPT\'\n' +
        "if (process.argv.includes('doctor')) { process.stdout.write(JSON.stringify({data:{initialized:false}})); process.exit(0); }\n" +
        (mode === 'timeout' ? "process.stderr.write('synthetic-output-must-remain-private'); setInterval(() => {}, 1000);\n"
          : mode === 'invalid' ? "process.stdout.write('invalid-json-must-remain-private');\n" : '') + 'SCRIPT\n');
      chmodSync(tool, 0o755);
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-catalog.mjs'), tool], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.error, undefined, 'process diagnostic control did not finish');
      assert.equal(result.status, 1);
      const reportNames = readdirSync(resolve(root, 'dist/e2e')).filter(name => !reportsBefore.has(name) && name.startsWith('catalog-journey-'));
      assert.equal(reportNames.length, 1);
      const contents = readFileSync(resolve(root, 'dist/e2e', reportNames[0]), 'utf8');
      const run = JSON.parse(contents).runs[0];
      const command = run.commands.at(-1);
      assert.equal(command.command, 'init');
      assert.equal(run.cleaned, true);
      assert.equal(run.network.requests, 0);
      assert.ok(command.elapsedMs >= 0);
      assert.equal(command.timeoutMs, 20_000);
      if (mode === 'timeout') {
        assert.equal(command.timedOut, true);
        assert.equal(command.signal, 'SIGKILL');
        assert.equal(command.code, null);
        assert.ok(command.elapsedMs >= 20_000 && command.elapsedMs < 25_000);
        assert.equal(command.stdoutBytes, 0);
        assert.equal(command.stderrBytes, Buffer.byteLength('synthetic-output-must-remain-private'));
        assert.equal(run.failure, 'BINARY_TIMEOUT');
      } else {
        assert.equal(command.timedOut, false);
        assert.equal(command.signal, null);
        assert.equal(command.code, 0);
        assert.equal(command.stderrBytes, 0);
        assert.equal(command.stdoutBytes, mode === 'empty' ? 0 : Buffer.byteLength('invalid-json-must-remain-private'));
        assert.equal(run.failure, mode === 'invalid' ? 'BINARY_JSON' : 'ERR_ASSERTION');
      }
      assert.doesNotMatch(contents + result.stderr, /must-remain-private|SyntaxError/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  }
  console.log('OK runner diagnostics: real timeout/signal/elapsed/byte counts precede JSON, no raw output');
}

// Use a real failing external executable and real POSIX permission denial.
// This guards error reporting; Windows cleanup is exercised by the full journey.
if (process.platform !== 'win32') {
  const shim = mkdtempSync(resolve(root, 'dist/openssl-failure-'));
  const before = new Set(readdirSync(resolve(root, 'dist')));
  const reportsBefore = new Set(readdirSync(resolve(root, 'dist/e2e')));
  try {
    const tool = resolve(shim, 'openssl');
    writeFileSync(tool, `#!${process.execPath}\nimport { chmodSync } from 'node:fs';\nchmodSync(process.cwd(), 0o000);\nprocess.stderr.write('synthetic OpenSSL setup rejection\\n');\nprocess.exit(37);\n`);
    chmodSync(tool, 0o755);
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-catalog.mjs'), ...(process.argv[2] ? [process.argv[2]] : []), '--setup-cleanup-failure'], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH ?? ''}` }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /platform-proxy-setup: platform TLS certificate setup failed \(37\)/);
    assert.match(result.stderr, /directory-cleanup: isolated directory still exists/);
    const reports = readdirSync(resolve(root, 'dist/e2e')).filter(name => !reportsBefore.has(name));
    assert.equal(reports.length, 1);
    const [run] = JSON.parse(readFileSync(resolve(root, 'dist/e2e', reports[0]), 'utf8')).runs;
    assert.deepEqual(run.commands, []);
    assert.deepEqual(run.failures.map(failure => failure.phase), ['platform-proxy-setup', 'directory-cleanup']);
    assert.equal(run.failures[0].diagnostic.status, 37);
    assert.equal(run.failures[0].diagnostic.stderr, 'synthetic OpenSSL setup rejection\n');
    assert.equal(run.cleaned, false);
    assert.equal(run.cleanupError, 'EACCES');
  } finally {
    for (const name of readdirSync(resolve(root, 'dist')).filter(name => name.startsWith('独立目录 ') && !before.has(name))) {
      const path = resolve(root, 'dist', name);
      chmodSync(path, 0o700);
      rmSync(path, { recursive: true, force: true });
      assert.equal(existsSync(path), false);
    }
    rmSync(shim, { recursive: true, force: true });
  }
  console.log('OK setup and cleanup errors survive together in stderr and evidence');
}

const directory = mkdtempSync(resolve(root, 'dist/proxy-denial-'));
let proxy;
try {
  proxy = await platformProxy(directory);
  const status = await new Promise((res, rej) => {
    const req = request(proxy.url, { method: 'CONNECT', path: 'unexpected.invalid:443' });
    req.on('connect', (response, socket) => { socket.destroy(); res(response.statusCode); });
    req.on('error', rej); req.end();
  });
  assert.equal(status, 403);
  assert.throws(() => proxy.assertHealthy(), /Outbound destination rejected/);
} finally {
  try { await proxy?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
}
assert.equal(existsSync(directory), false);
writeFileSync(resolve(root, 'dist/e2e/proxy-denial.json'), JSON.stringify({ deniedUnexpectedOrigin: true, cleaned: true }) + '\n');
console.log('OK local transport whitelist: unexpected destination denied without forwarding');
