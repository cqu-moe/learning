import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixedQrJpeg } from './helpers/qr-images.js';

const home = mkdtempSync(resolve(tmpdir(), 'learning-auth-ui-'));
const empty = resolve(home, 'empty.json');
const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
writeFileSync(empty, '{"interactions":[]}');

afterAll(() => rmSync(home, { recursive: true, force: true }));

function runIn(commandHome: string, args: string[], fixture = empty) {
  const result = spawnSync(process.execPath, [
    '--import', resolve(import.meta.dirname, 'fixture-fetch.mjs'),
    resolve(import.meta.dirname, '../dist/index.js'),
    '--home', commandHome, ...args,
  ], { encoding: 'utf8', env: { ...process.env, LEARNING_FIXTURE_FILE: fixture } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function run(args: string[], fixture = empty) {
  return runIn(home, args, fixture);
}

function writeWeChatFixture(destination: string, bytes: Uint8Array, contentType: string): string {
  const fixtureRoot = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
  const source = JSON.parse(readFileSync(resolve(fixtureRoot, 'zhs/wechat-qr.json'), 'utf8')) as {
    interactions: Array<{
      request: { method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string };
      response: { status: number; body?: unknown; base64?: string; headers?: Record<string, string | string[]> };
    }>;
  };
  const service = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=https://onlineweb.zhihuishu.com/onlinestuh5';
  const redirect = `https://user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin?service=${encodeURIComponent(service)}`;
  const state = 'https://login.zhihuishu.com/wxTransit/0';
  source.interactions[0]!.request.query = { appid: 'wx3f96cd4b1dc1f574', scope: 'snsapi_login', redirect_uri: redirect, state, login_type: 'jssdk', self_redirect: 'false' };
  for (const row of source.interactions.slice(2, 5)) row.request.query = { uuid: 'WXUUID1', _: '__NOW_MS__' };
  source.interactions[5]!.request.query = { service, code: 'CODE1', state };
  source.interactions[1]!.response = { status: 200, headers: { 'content-type': contentType }, base64: Buffer.from(bytes).toString('base64') };
  const transit = new URL(state);
  transit.searchParams.set('cacheId', 'CACHE1');
  transit.searchParams.set('isLock', '0');
  transit.searchParams.set('service', service);
  source.interactions[5]!.response = {
    status: 302,
    headers: { location: transit.toString(), 'set-cookie': ['JSESSIONID=fixture-session; Path=/zhsuser; HttpOnly'] },
    body: '',
  };
  const headers = { origin: 'https://login.zhihuishu.com', referer: 'https://login.zhihuishu.com/', 'content-type': 'application/json;charset=UTF-8', cookie: 'JSESSIONID=fixture-session' };
  source.interactions.push(
    { request: { method: 'GET', host: 'login.zhihuishu.com', path: '/wxTransit/0', query: { cacheId: 'CACHE1', isLock: '0', service }, body: '' }, response: { status: 200, body: '<html><title>登录中心</title></html>' } },
    { request: { method: 'GET', host: 'user.zhihuishu.com', path: '/zhsuser/user/cache/CACHE1', headers, body: '' }, response: { status: 200, body: { status: 200, rt: { mobile: 'fixture-mobile', certifyList: [{ schoolId: 'fixture-school', role: 1 }] } } } },
    { request: { method: 'POST', host: 'user.zhihuishu.com', path: '/zhsuser/login/code/skipSet/CACHE1', headers, body: '' }, response: { status: 200, body: { status: 1, rt: { pwd: 'ONCE1' } } } },
    { request: { method: 'GET', host: 'passport.zhihuishu.com', path: '/login', query: { pwd: 'ONCE1', service }, headers: { referer: 'https://login.zhihuishu.com/' }, body: '' }, response: { status: 302, headers: { location: `${service}&ticket=fixture-ticket`, 'set-cookie': ['CASLOGC=%7B%22uuid%22%3A%22u1%22%7D; Domain=zhihuishu.com; Path=/; Secure'] }, body: '' } },
    { request: { method: 'GET', host: 'onlineservice-api.zhihuishu.com', path: '/gateway/f/v1/login/gologin', query: { fromurl: 'https://onlineweb.zhihuishu.com/onlinestuh5', ticket: 'fixture-ticket' }, headers: { cookie: 'CASLOGC=%7B%22uuid%22%3A%22u1%22%7D' }, body: '' }, response: { status: 200, body: {} } },
  );
  writeFileSync(destination, JSON.stringify(source));
  return destination;
}

describe('explicit machine QR login', () => {
  it('refuses implicit manual scanning before any network request', () => {
    expect(run(['init']).code).toBe(0);
    expect(run(['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const result = run(['login', '--profile', 'alpha']);
    expect(result.code, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe('INTERACTION_REQUIRED');
    expect(result.stderr).not.toContain('undeclared request');
  });

  it('emits only QR file metadata, cleans up, and never overwrites another file', () => {
    const path = resolve(home, 'qr.png');
    writeFileSync(path, 'keep');
    expect(run(['login', '--profile', 'alpha', '--qr-file', path]).code).toBe(3);
    expect(readFileSync(path, 'utf8')).toBe('keep');
    const target = resolve(home, 'new-qr.png');
    const result = run([
      'login', '--profile', 'alpha', '--qr-file', target, '--output-format', 'jsonl',
    ], resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures/ykt/qr-login.json'));
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'auth' && event.data.qrPath === target)).toBe(true);
    expect(events.at(-1).data.ok).toBe(true);
    expect(result.stdout).not.toContain('base64');
    expect(result.stdout).not.toContain('sessionid');
    expect(existsSync(target)).toBe(false);
  });

  it('keeps fixed JPEG QR image bytes out of machine JSONL output and removes the file', () => {
    const machineHome = mkdtempSync(resolve(tmpdir(), 'learning-zhs-jpeg-machine-'));
    try {
      expect(runIn(machineHome, ['init']).code).toBe(0);
      expect(runIn(machineHome, ['profile', 'add', 'alpha', '--platform', 'zhs']).code).toBe(0);
      const image = fixedQrJpeg();
      const fixture = writeWeChatFixture(resolve(machineHome, 'wechat-machine-jpeg.json'), image, 'image/jpeg');
      const target = resolve(machineHome, 'new-qr.jpg');
      const result = runIn(machineHome, ['login', '--profile', 'alpha', '--qr-file', target, '--output-format', 'jsonl'], fixture);
      expect(result.code, result.stderr).toBe(0);
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(events.some(event => event.type === 'auth' && event.data.qrPath === target)).toBe(true);
      expect(events.at(-1).data.ok).toBe(true);
      expect(result.stdout).not.toContain(image.toString('base64'));
      expect(result.stdout).not.toContain('sessionid');
      expect(result.stdout).not.toMatch(/CACHE1|ONCE1|fixture-ticket|%7B%22uuid|CODE1/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(machineHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not render terminal QR blocks when a TTY requests implicit login', () => {
    const terminalHome = mkdtempSync(resolve(tmpdir(), 'learning-auth-terminal-'));
    try {
      expect(runIn(terminalHome, ['init']).code).toBe(0);
      expect(runIn(terminalHome, ['profile', 'add', 'alpha', '--platform', 'zhs']).code).toBe(0);
      const result = spawnSync('python3', [driver, JSON.stringify({
        argv: [process.execPath, resolve(import.meta.dirname, '../dist/index.js'), '--home', terminalHome, 'login', '--profile', 'alpha'],
        steps: [],
        columns: 96,
        env: { LEARNING_FIXTURE_FILE: empty },
      })], { encoding: 'utf8', timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0);
      const terminal = JSON.parse(result.stdout) as { code: number; screen: string };
      expect(terminal.code, terminal.screen).toBe(3);
      expect(terminal.screen).not.toContain('\u001b');
      expect(terminal.screen).not.toMatch(/[█▀▄]/);
      const body = JSON.parse(terminal.screen.replaceAll('\r', '').trim());
      expect(body.error.code).toBe('INTERACTION_REQUIRED');
    } finally {
      rmSync(terminalHome, { recursive: true, force: true });
    }
  }, 20_000);
});
