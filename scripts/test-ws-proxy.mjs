import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { bunVersion, compile, root } from './build-cli.mjs';
import { platformProxy } from './helpers/platform-proxy.mjs';
import { egressBoundary, loopbackCommand } from './helpers/loopback-command.mjs';

const directory = mkdtempSync(resolve(root, 'dist/ws-proxy-'));
const report = {
  bunVersion, egressBoundary,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  results: [], cleaned: false, failures: [],
};
const errors = [];
let proxy;
async function run(program, args, env, allowedProxy) {
  const [command, argv] = loopbackCommand(program, args, allowedProxy);
  const child = spawn(command, argv, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); });
  return { code, result: output.trim() };
}
try {
  const program = resolve(directory, process.platform === 'win32' ? 'probe.exe' : 'probe');
  compile('scripts/ws-proxy-probe.ts', program);
  report.artifactSha256 = createHash('sha256').update(readFileSync(program)).digest('hex');
  proxy = await platformProxy(directory);
  if (process.platform === 'darwin') {
    // Use a second listening loopback port: denial cannot pass merely because no server exists.
    let accepted = 0;
    const other = createServer(socket => { accepted++; socket.destroy(); });
    try {
      await new Promise((res, rej) => { other.once('error', rej); other.listen(0, '127.0.0.1', res); });
      for (const [port, expected] of [[new URL(proxy.url).port, 0], [other.address().port, 1]]) {
        const result = await run(process.execPath, ['--input-type=module', '-e', `import {connect} from 'node:net'; const s=connect(${port},'127.0.0.1'); s.on('connect',()=>process.exit(0)); s.on('error',()=>process.exit(1));`], { PATH: '' }, proxy.url);
        assert.equal(result.code, expected, 'OS network boundary');
      }
      assert.equal(accepted, 0);
      report.osDenial = { allowedPortConnected: true, otherPortAccepted: accepted };
    } finally { await new Promise(res => other.close(res)); }
  }
  proxy.use([{ kind: 'websocket', request: { host: 'fixture.invalid', path: '/wsapp/', headers: { origin: 'https://fixture.invalid' } }, message: { probe: 'client' }, respond: ws => ws.send('server') }]);
  for (const mode of ['explicit', 'untrusted-ca', 'unregistered-host', 'invalid-proxy']) {
    const before = proxy.evidence();
    const result = await run(program, [mode === 'unregistered-host' ? 'wss://unregistered.invalid/wsapp/' : 'wss://fixture.invalid/wsapp/'], {
      PATH: '', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HTTPS_PROXY: mode === 'invalid-proxy' ? 'invalid proxy URL' : proxy.url,
      ...(mode === 'untrusted-ca' ? {} : { NODE_EXTRA_CA_CERTS: proxy.ca }),
    }, proxy.url);
    const after = proxy.evidence();
    Object.assign(result, { mode, connects: after.tunnels - before.tunnels, upgrades: after.wsUpgrades - before.wsUpgrades, denied: after.deniedHosts - before.deniedHosts });
    report.results.push(result);
    assert.equal(result.code, mode === 'explicit' ? 0 : 1, 'native transport proxy result: ' + mode);
    assert.equal(result.result, mode === 'explicit' ? 'connected' : 'rejected');
    assert.equal(result.connects, mode === 'invalid-proxy' ? 0 : 1);
    assert.equal(result.upgrades, mode === 'explicit' ? 1 : 0);
    assert.equal(result.denied, mode === 'unregistered-host' ? 1 : 0);
    if (mode === 'explicit') proxy.done();
  }
} catch (error) { errors.push(error); report.failures.push({ phase: 'probe', code: error.code ?? error.name }); }
finally {
  try { await proxy?.close(); } catch (error) { errors.push(error); report.failures.push({ phase: 'proxy-close', code: error.code ?? error.name }); }
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    report.cleaned = !existsSync(directory);
    assert.equal(report.cleaned, true);
  } catch (error) { errors.push(error); report.failures.push({ phase: 'directory-cleanup', code: error.code ?? error.name }); }
  mkdirSync(resolve(root, 'dist/e2e'), { recursive: true });
  writeFileSync(resolve(root, `dist/e2e/ws-proxy-${Date.now()}.json`), JSON.stringify(report, null, 2) + '\n');
}
if (errors.length) throw new AggregateError(errors, 'native WS proxy checks failed');
console.log('OK native WSS proxy: trusted exchange; untrusted CA, unknown destination and invalid proxy rejected');
