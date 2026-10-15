import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { platformProxy } from './helpers/platform-proxy.mjs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

for (const control of ['wrong-expectation', 'missing-fixture', 'unregistered-host', 'unregistered-route']) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-catalog.mjs'), ...(process.argv[2] ? [process.argv[2]] : []), '--' + control], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.error, undefined, 'negative control could not launch');
  assert.equal(result.status, 1, 'negative control must fail with an assertion, not be skipped');
  const messages = { 'wrong-expectation': /incorrect title negative control/, 'missing-fixture': /ENOENT/, 'unregistered-host': /Outbound destination rejected/, 'unregistered-route': /platform path mismatch/ };
  assert.match(result.stderr, messages[control]);
}
console.log('OK catalog negative controls: wrong result, missing fixture and binary host/route rejection exit nonzero');

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
