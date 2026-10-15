import assert from 'node:assert/strict';
import { setTimeout, clearTimeout } from 'node:timers';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executable, releaseDirectory, root } from './build-cli.mjs';

// This journey deliberately uses the shipped program, never a preload or SDK import.
const binary = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? resolve(releaseDirectory, executable));
const control = ['wrong-expectation', 'missing-fixture', 'unregistered-host', 'unregistered-route'].find(name => process.argv.includes('--' + name)) ?? 'journey';
const reportDir = resolve(root, 'dist/e2e');
mkdirSync(reportDir, { recursive: true });
const report = { schemaVersion: 1, control, sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), artifact: { name: executable, sha256: existsSync(binary) ? createHash('sha256').update(readFileSync(binary)).digest('hex') : null }, runs: [] };
const failures = [];
try {
  assert.ok(existsSync(binary), 'standalone artifact missing');
  const { platformProxy } = await import('./helpers/platform-proxy.mjs');
  for (let pass = 1; pass <= 2; pass++) {
    const directory = mkdtempSync(resolve(root, 'dist/独立目录 '));
    const home = resolve(directory, '账号 数据');
    const record = { pass, commands: [], cleaned: false, status: 'running' };
    report.runs.push(record);
    let proxy;
    try {
      const program = resolve(directory, executable);
      copyFileSync(binary, program);
      if (process.platform !== 'win32') chmodSync(program, 0o755);
      proxy = await platformProxy(directory);
      const env = {
        PATH: '', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CI: '1', LEARNING_HOME: resolve(directory, 'ignored-env'),
        LEARNING_TELEMETRY_DISABLED: '1', HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, ALL_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: proxy.ca,
      };
      async function run(args, expected = 0) {
        const child = spawn(program, ['--home', home, ...args, '--json', '--no-interactive'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        const code = await new Promise((res, rej) => { child.once('error', rej); child.once('exit', res); }).finally(() => clearTimeout(timer));
        record.commands.push({ profile: args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined, command: args[0] + (['profile','config','telemetry'].includes(args[0]) ? ' ' + args[1] : ''), code });
        // Do not include raw output in failure reports: login traffic contains synthetic secrets.
        const envelope = JSON.parse(stdout || stderr);
        record.commands.at(-1).errorCode = envelope.error?.code;
        proxy.assertHealthy();
        assert.equal(code, expected, `command ${record.commands.at(-1).command} exit mismatch (${envelope.error?.code ?? 'none'})`);
        for (const secret of proxy.secrets) assert.ok(!(stdout + stderr).includes(secret), 'sensitive output');
        proxy.assertHealthy();
        return JSON.parse(stdout || stderr);
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
      // Imports use only synthetic cookie files; no encrypted session or successful catalog is seeded.
      const xtProfile = await run(['profile', 'add', 'xt', '--platform', 'xuetang']);
      const imported = resolve(directory, 'synthetic-import.json');
      writeFileSync(imported, JSON.stringify([{ name: 'sessionid', value: 'xtx-sess-fixture', domain: '.xuetangx.com' }]));
      assert.equal((await run(['login', '--profile', 'xt', '--import', imported])).data.identityVerified, false);
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
      record.status = 'passed';
    } catch (error) {
      record.status = 'failed';
      failures.push(error);
      record.failure = error.code ?? error.name;
    } finally {
      record.network = proxy?.evidence();
      try { await proxy?.close(); } finally {
        rmSync(directory, { recursive: true, force: true });
        record.cleaned = !existsSync(directory);
        assert.equal(record.cleaned, true);
      }
    }
    if (failures.length) break;
  }
  assert.equal(failures.length, 0, failures[0]?.message);
} finally {
  writeFileSync(resolve(reportDir, `catalog-${control}-${Date.now()}-${process.pid}.json`), JSON.stringify(report, null, 2) + '\n');
}
console.log('OK standalone catalog: two isolated real-transport runs');
