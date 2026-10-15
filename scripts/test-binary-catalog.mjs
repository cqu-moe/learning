import assert from 'node:assert/strict';
import { setTimeout, clearTimeout } from 'node:timers';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executable, releaseDirectory, root } from './build-cli.mjs';
import { egressBoundary, loopbackCommand } from './helpers/loopback-command.mjs';

// This journey deliberately uses the shipped program, never a preload or SDK import.
const binary = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? resolve(releaseDirectory, executable));
const control = ['wrong-expectation', 'missing-fixture', 'unregistered-host', 'unregistered-route', 'setup-cleanup-failure', 'ws-unregistered-route', 'ws-missing-fixture', 'ws-wrong-message'].find(name => process.argv.includes('--' + name)) ?? 'journey';
const reportDir = resolve(root, 'dist/e2e');
mkdirSync(reportDir, { recursive: true });
const report = { schemaVersion: 1, control, egressBoundary, sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), artifact: { name: executable, sha256: existsSync(binary) ? createHash('sha256').update(readFileSync(binary)).digest('hex') : null }, runs: [] };
const failures = [];

async function removeIsolatedDirectory(directory) {
  let lastError;
  let attempts = 0;
  for (; attempts < 50;) {
    attempts++;
    try {
      // Node 24.11.1 rmSync uses std::filesystem's narrow Windows paths;
      // async rm uses libuv and preserves Chinese directory names (nodejs/node#61108).
      await rm(directory, { recursive: true, force: true });
      if (!existsSync(directory)) return { cleaned: true, attempts };
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM', 'EMFILE', 'ENFILE'].includes(error.code)) break;
    }
    if (process.platform !== 'win32') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { cleaned: !existsSync(directory), attempts, error: lastError?.code ?? lastError?.name };
}

try {
  assert.ok(existsSync(binary), 'standalone artifact missing');
  const { platformProxy } = await import('./helpers/platform-proxy.mjs');
  for (let pass = 1; pass <= 2; pass++) {
    const directory = mkdtempSync(resolve(root, 'dist/独立目录 '));
    const home = resolve(directory, '账号 数据');
    const record = { pass, commands: [], cleaned: false, status: 'running', failures: [] };
    report.runs.push(record);
    let proxy;
    let stage = 'artifact-copy';
    const fail = (error, phase) => {
      record.status = 'failed';
      failures.push(new Error(`${phase}: ${error.message}`));
      record.failure ??= error.code ?? error.name;
      record.failures.push({ phase, code: error.code ?? error.name, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    };
    try {
      const program = resolve(directory, executable);
      copyFileSync(binary, program);
      if (process.platform !== 'win32') chmodSync(program, 0o755);
      stage = 'platform-proxy-setup';
      proxy = await platformProxy(directory);
      stage = 'commands';
      const env = {
        PATH: '', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CI: '1', LEARNING_HOME: resolve(directory, 'ignored-env'),
        LEARNING_TELEMETRY_DISABLED: '1', HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, ALL_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: proxy.ca,
      };
      if (process.platform === 'win32') {
        // Compare presence only: never copy or record inherited credential values.
        record.windowsEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PSModulePath'].map(name => [name, {
          inherited: process.env[name] !== undefined, passed: env[name] !== undefined,
        }]));
      }
      let activeChild;
      const waitForQr = async file => {
        for (let i = 0; i < 200; i++) {
          if (existsSync(file) && readFileSync(file).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
          await new Promise(res => setTimeout(res, 10));
        }
        assert.fail('binary did not publish a PNG QR');
      };
      const wsLogin = (file, outcome = 'success') => {
        const http = JSON.parse(readFileSync(new URL('../packages/sdk/tests/fixtures/xuetang/qr-is-new.json', import.meta.url), 'utf8')).interactions;
        const isNew = pass === 1;
        const ws = {
          kind: 'websocket',
          request: { host: 'www.xuetangx.com', path: '/wsapp/', headers: { origin: 'https://www.xuetangx.com', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } },
          message: { op: 'requestlogin', role: 'web', version: '1.4', purpose: 'login', xtbz: 'xt', 'x-client': 'web' },
          respond: async socket => {
            socket.send(JSON.stringify({ op: 'requestlogin', ticket: 'https://qr.invalid/ws-qr-fixture', expire_seconds: outcome === 'expired' ? 5 : 60 }));
            await waitForQr(file);
            if (outcome === 'close') { socket.close(); return; }
            if (outcome === 'cancel') { assert.ok(activeChild.kill('SIGINT')); return; }
            if (outcome === 'expired') await new Promise(res => setTimeout(res, 6000));
            if (outcome === 'malformed') { socket.send('{'); return; }
            socket.send(JSON.stringify(outcome === 'missing-token' ? { op: 'loginsuccess', is_new: true } : { op: 'loginsuccess', is_new: isNew, token: isNew ? 'unused-token' : 'fixture-token', ...(isNew ? { s_s: 'fixture-token' } : {}) }));
          },
        };
        if (control === 'ws-unregistered-route') ws.request.path = '/unregistered';
        if (control === 'ws-wrong-message') ws.message.purpose = 'wrong-purpose';
        if (outcome === 'exchange-denied') http[1].response = { status: 403, body: { success: false } };
        proxy.use([http[0], ...(control === 'ws-missing-fixture' ? [] : [ws]), ...(['success', 'exchange-denied'].includes(outcome) ? [http[1]] : [])]);
      };
      async function run(args, expected = 0) {
        // Some commands validate the private directory both while resolving the
        // target and while opening it. Each production PowerShell has a 30s bound.
        const timeoutMs = process.platform === 'win32' ? 75_000 : 20_000;
        const startedAt = Date.now();
        const [command, argv] = loopbackCommand(program, ['--home', home, ...args, '--json', '--no-interactive'], proxy.url);
        const child = spawn(command, argv, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
        activeChild = child;
        let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, timedOut = false, spawnErrorCode;
        child.stdout.on('data', chunk => { stdout += chunk; stdoutBytes += chunk.length; });
        child.stderr.on('data', chunk => { stderr += chunk; stderrBytes += chunk.length; });
        child.once('error', error => { spawnErrorCode = error.code ?? error.name; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        const result = await new Promise(res => { child.once('close', (code, signal) => res({ code, signal })); }).finally(() => clearTimeout(timer));
        record.commands.push({ profile: args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined, command: args[0] + (['profile','config','telemetry'].includes(args[0]) ? ' ' + args[1] : ''), ...result,
          elapsedMs: Date.now() - startedAt, timeoutMs, timedOut, stdoutBytes, stderrBytes, ...(spawnErrorCode ? { spawnErrorCode } : {}) });
        if (timedOut) throw Object.assign(new Error('standalone command timed out (' + timeoutMs + 'ms)'), { code: 'BINARY_TIMEOUT' });
        assert.equal(spawnErrorCode, undefined, 'standalone command could not launch');
        proxy.assertHealthy();
        assert.equal(result.signal, null, 'standalone command terminated by signal');
        assert.equal(result.code, expected, 'standalone command exit mismatch');
        assert.ok(stdoutBytes + stderrBytes > 0, 'standalone command returned no JSON output');
        // Do not include raw output in failure reports: login traffic contains synthetic secrets.
        let envelope;
        try { envelope = JSON.parse(stdout || stderr); }
        catch { throw Object.assign(new Error('standalone command returned invalid JSON'), { code: 'BINARY_JSON' }); }
        record.commands.at(-1).errorCode = envelope.error?.code;
        proxy.assertHealthy();
        for (const secret of proxy.secrets) assert.ok(!(stdout + stderr).includes(secret), 'sensitive output');
        proxy.assertHealthy();
        return envelope;
      }
      const doctor = await run(['doctor']);
      assert.equal(doctor.data.initialized, false);
      assert.equal(existsSync(home), false, 'doctor must not create the home');
      await run(['init']);
      if (control === 'missing-fixture') proxy.use('not-declared');
      await run(['init']);
      await run(['profile', 'add', 'alpha', '--platform', 'ykt']);
      if (control.startsWith('unregistered-')) {
        const first = JSON.parse(readFileSync(new URL('../packages/sdk/tests/fixtures/ykt/qr-login.json', import.meta.url), 'utf8')).interactions[0];
        if (control === 'unregistered-host') first.response = { status: 302, headers: { location: 'https://unregistered.yuketang.cn/blocked' }, body: '' };
        else first.request.path = '/not-registered';
        proxy.use([first]);
      } else proxy.use('ykt/qr-login');
      const loggedIn = await run(['login', '--profile', 'alpha', '--qr-file', resolve(directory, 'qr.png')]);
      assert.equal(loggedIn.data.identityVerified, true);
      proxy.done();
      assert.equal(existsSync(resolve(directory, 'qr.png')), false);
      proxy.use('ykt/courses-list', { cookie: 'sessionid=sess-fixture' });
      const courses = await run(['courses', '--profile', 'alpha']);
      assert.equal(courses.data.items[0].title, process.argv.includes('--wrong-expectation') ? 'incorrect title negative control' : '学术写作');
      proxy.done();
      proxy.use('ykt/nested-outline');
      const outline = await run(['outline', courses.data.items[0].ref.key, '--profile', 'alpha']);
      assert.ok(outline.data.value.roots.length > 0);
      proxy.done();
      const yktProbe = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/v2/api/web/userinfo' }, response: { status: 200, body: { errcode: 0, data: { id: 424242, name: 'Synthetic reader' } } } };
      proxy.use([yktProbe], { cookie: 'sessionid=sess-fixture' });
      assert.equal((await run(['whoami', '--profile', 'alpha'])).data.state, 'valid');
      proxy.done();
      await run(['profile', 'add', 'beta', '--platform', 'ykt']);
      assert.equal((await run(['outline', courses.data.items[0].ref.key, '--profile', 'beta'], 3)).error.code, 'FORBIDDEN');
      assert.equal((await run(['whoami', '--profile', 'beta'])).data.state, 'expired');
      const betaImport = resolve(directory, 'synthetic-beta.json');
      writeFileSync(betaImport, JSON.stringify([{ name: 'sessionid', value: 'beta-session-fixture', domain: 'www.yuketang.cn' }]));
      assert.equal((await run(['login', '--profile', 'beta', '--import', betaImport])).data.identityVerified, false);
      proxy.use([yktProbe], { cookie: 'sessionid=beta-session-fixture' });
      assert.equal((await run(['whoami', '--profile', 'beta'])).data.state, 'valid');
      proxy.done();
      assert.equal((await run(['outline', courses.data.items[0].ref.key, '--profile', 'beta'], 3)).error.code, 'FORBIDDEN');
      // Real QR login writes the session; later commands read it in new processes.
      const xtProfile = await run(['profile', 'add', 'xt', '--platform', 'xuetang']);
      const imported = resolve(directory, 'synthetic-import.json');
      const xtQr = resolve(directory, 'xt-qr.png');
      wsLogin(xtQr);
      assert.equal((await run(['login', '--profile', 'xt', '--qr-file', xtQr])).data.identityVerified, true);
      proxy.done();
      assert.equal(existsSync(xtQr), false);
      proxy.use('xuetang/courses', { cookie: 'sessionid=xtx-sess-fixture' });
      assert.equal((await run(['whoami', '--profile', 'xt'])).data.state, 'valid');
      proxy.done();
      proxy.use('xuetang/courses', { cookie: 'sessionid=xtx-sess-fixture' });
      const xt = await run(['courses', '--profile', 'xt']);
      assert.equal(xt.data.items[0].title, '电路原理');
      proxy.done();
      proxy.use(JSON.parse(readFileSync(new URL('../packages/sdk/tests/fixtures/xuetang/outline.json', import.meta.url), 'utf8')).interactions.slice(1), { cookie: 'sessionid=xtx-sess-fixture' });
      assert.ok((await run(['outline', xt.data.items[0].ref.key, '--profile', 'xt'])).data.value.roots.length > 0);
      proxy.done();
      writeFileSync(imported, JSON.stringify([{ name: 'sessionid', value: 'xtx-import-fixture', domain: '.xuetangx.com' }]));
      assert.equal((await run(['login', '--profile', 'xt', '--import', imported])).data.identityVerified, false);
      proxy.use('xuetang/courses', { cookie: 'sessionid=xtx-import-fixture' });
      assert.equal((await run(['whoami', '--profile', 'xt'])).data.state, 'valid');
      proxy.done();
      await run(['profile', 'add', 'xt-failed', '--platform', 'xuetang']);
      record.wsTokenBranch = pass === 1 ? 'is_new:s_s' : 'existing:token';
      record.wsFailures = [];
      const wsFailures = [['missing-token', 1, 'PROTOCOL'], ['malformed', 1, 'PROTOCOL'], ['close', 3, 'AUTH_REQUIRED'], ['exchange-denied', 3, 'AUTH_REQUIRED'], ['expired', 1, 'TIMEOUT']];
      // POSIX signals reach the actual CLI handler; Windows kill() forcibly terminates.
      if (process.platform !== 'win32') wsFailures.push(['cancel', 3, 'CANCELED']);
      record.wsCancellation = process.platform === 'win32' ? 'not-run: requires Windows console Ctrl+C' : 'SIGINT';
      for (const [outcome, code, error] of wsFailures) {
        wsLogin(xtQr, outcome);
        assert.equal((await run(['login', '--profile', 'xt-failed', '--qr-file', xtQr], code)).error.code, error);
        proxy.done();
        assert.equal(existsSync(xtQr), false);
        assert.equal((await run(['whoami', '--profile', 'xt-failed'])).data.state, 'expired');
        record.wsFailures.push({ outcome, code, error, qrRemoved: true, session: 'expired' });
      }
      await run(['profile', 'remove', 'xt-failed', '--yes']);
      await run(['profile', 'add', 'zhs', '--platform', 'zhs']);
      proxy.use('zhs/wechat-qr');
      assert.equal((await run(['login', '--profile', 'zhs', '--qr-file', resolve(directory, 'wx.jpg')])).data.identityVerified, false);
      proxy.done();
      const zhsProbe = { request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/login/getLoginUserInfo' }, response: { status: 200, body: { code: 0, data: { uuid: 'u1', name: 'Synthetic reader' } } } };
      proxy.use([zhsProbe]);
      assert.equal((await run(['whoami', '--profile', 'zhs'])).data.state, 'valid');
      proxy.done();
      proxy.use(['zhs/share-list', 'zhs/hike-list']);
      const zhs = await run(['courses', '--profile', 'zhs']);
      assert.equal(zhs.data.items[0].title, '共享课1');
      assert.equal(zhs.data.items.length, 7);
      proxy.done();
      proxy.use('zhs/share-outline');
      assert.ok((await run(['outline', zhs.data.items[0].ref.key, '--profile', 'zhs'])).data.value.roots.length > 0);
      proxy.done();
      proxy.use('zhs/qr-login');
      await run(['login', '--profile', 'zhs', '--variant', 'native', '--qr-file', resolve(directory, 'native.png')]);
      proxy.done();
      for (const status of [2, 3]) {
        const start = JSON.parse(readFileSync(new URL('../packages/sdk/tests/fixtures/zhs/qr-login.json', import.meta.url), 'utf8')).interactions;
        start[1].response.body = { status };
        proxy.use(start.slice(0, 2));
        assert.equal((await run(['login', '--profile', 'zhs', '--variant', 'native', '--qr-file', resolve(directory, 'failed.png')], 3)).ok, false);
        proxy.done();
        assert.equal(existsSync(resolve(directory, 'failed.png')), false);
      }
      proxy.use([{ ...yktProbe, response: { status: 401, body: { errcode: 401002 } } }]);
      assert.equal((await run(['whoami', '--profile', 'alpha'])).data.state, 'expired');
      proxy.done();
      const denied = JSON.parse(readFileSync(new URL('../packages/sdk/tests/fixtures/ykt/qr-login.json', import.meta.url), 'utf8')).interactions[0];
      denied.response.body = { code: 403, msg: 'Synthetic rejection' };
      proxy.use([denied]);
      assert.equal((await run(['login', '--profile', 'alpha', '--qr-file', resolve(directory, 'denied.png')], 3)).error.code, 'AUTH_REQUIRED');
      proxy.done();
      denied.response.body = { code: 0 };
      proxy.use([denied]);
      assert.equal((await run(['login', '--profile', 'alpha', '--qr-file', resolve(directory, 'malformed.png')], 1)).error.code, 'PROTOCOL');
      proxy.done();
      writeFileSync(imported, JSON.stringify([{ name: 'CASLOGC', value: 'synthetic-zhs-cookie', domain: '.zhihuishu.com' }]));
      assert.equal((await run(['login', '--profile', 'zhs', '--import', imported])).data.identityVerified, false);
      proxy.use([zhsProbe]);
      assert.equal((await run(['whoami', '--profile', 'zhs'])).data.state, 'valid');
      proxy.done();
      await run(['config', 'set', 'default-profile', 'xt']);
      assert.equal((await run(['config', 'show'])).data.defaultProfileId, xtProfile.data.scope.profileId);
      await run(['config', 'set', 'download-dir', resolve(directory, '导出')]);
      assert.equal((await run(['config', 'show'])).data.downloadDir, resolve(directory, '导出'));
      await run(['config', 'unset', 'download-dir']);
      assert.equal((await run(['config', 'show'])).data.downloadDir, null);
      await run(['telemetry', 'off']);
      assert.equal((await run(['telemetry', 'status'])).data.reason, 'persistent');
      await run(['telemetry', 'on']);
      const telemetry = (await run(['telemetry', 'status'])).data;
      assert.equal(telemetry.enabled, false, 'CI always disables outbound telemetry');
      assert.notEqual(telemetry.reason, 'persistent', 'on clears the persisted opt-out');
      await run(['profile', 'remove', 'beta', '--yes']);
      const profiles = (await run(['profile', 'list'])).data.profiles;
      assert.deepEqual(profiles.map(p => p.name).sort(), ['alpha', 'xt', 'zhs']);
      assert.equal(existsSync(env.LEARNING_HOME), false);
      assert.ok(readdirSync(home).includes('state.db'));
      assert.equal(readdirSync(directory).some(name => /^(qr|wx|native|failed|denied|malformed)\./.test(name)), false);
      proxy.done();
      assert.ok(proxy.evidence().requests > 0, 'binary must use the actual local proxy');
      assert.equal(proxy.evidence().wsUpgrades, 1 + wsFailures.length);
      assert.equal(proxy.evidence().wsMessages, 1 + wsFailures.length);
      for (let i = 0; i < 100 && proxy.evidence().wsClosed < 1 + wsFailures.length; i++) await new Promise(res => setTimeout(res, 10));
      assert.equal(proxy.evidence().wsClosed, 1 + wsFailures.length, 'every auth socket must close');
      record.status = 'passed';
    } catch (error) {
      fail(error, stage);
    } finally {
      record.network = proxy?.evidence();
      try { await proxy?.close(); } catch (error) { fail(error, 'proxy-close'); }
      try {
        const cleanup = await removeIsolatedDirectory(directory);
        record.cleaned = cleanup.cleaned;
        record.cleanupAttempts = cleanup.attempts;
        record.cleanupError = cleanup.error;
        assert.equal(record.cleaned, true, 'isolated directory still exists after cleanup');
      } catch (error) { fail(error, 'directory-cleanup'); }
    }
    if (failures.length) break;
  }
  if (failures.length) throw new AggregateError(failures, 'standalone catalog failed; all failures retained');
} finally {
  writeFileSync(resolve(reportDir, `catalog-${control}-${Date.now()}-${process.pid}.json`), JSON.stringify(report, null, 2) + '\n');
}
console.log('OK standalone catalog: two isolated real-transport runs');
