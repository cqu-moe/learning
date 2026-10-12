import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import qrcode from 'qrcode';
import { realisticByteQrJpeg } from './helpers/qr-images.js';
const home = mkdtempSync(resolve(tmpdir(), 'learning-auth-ui-'));
const empty = resolve(home, 'empty.json');
writeFileSync(empty, '{"interactions":[]}');
afterAll(() => rmSync(home, { recursive: true, force: true }));
function run(args: string[], fixture = empty) {
 return runIn(home, args, fixture);
}

function runIn(commandHome: string, args: string[], fixture = empty) {
 const result = spawnSync(process.execPath, ['--import',resolve(import.meta.dirname,'fixture-fetch.mjs'),resolve(import.meta.dirname,'../dist/index.js'),'--home',commandHome,...args], { encoding: 'utf8', env: { ...process.env, LEARNING_FIXTURE_FILE: fixture } });
 return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function digest(value: string): string {
 return createHash('sha256').update(value).digest('hex');
}

function decodeTerminalQr(screen: string): string {
 const lines = stripVTControlCharacters(screen)
  .split(/\r\n|\r|\n/)
  .filter(line => line.length >= 21 && [...line].every(char => char === ' ' || char === '█' || char === '▀' || char === '▄'));
 const groups: string[][] = [];
 for (const line of lines) {
  const group = groups.at(-1);
  if (group !== undefined && group[0]!.length === line.length) group.push(line);
  else groups.push([line]);
 }
 const group = groups.sort((left, right) => right.length - left.length)[0];
 expect(group?.length).toBeGreaterThan(8);

 const matrix: boolean[][] = [];
 for (const line of group!) {
  const top: boolean[] = [];
  const bottom: boolean[] = [];
  for (const char of line) {
   if (char === '█') { top.push(true); bottom.push(true); }
   else if (char === '▀') { top.push(true); bottom.push(false); }
   else if (char === '▄') { top.push(false); bottom.push(true); }
   else { top.push(false); bottom.push(false); }
  }
  matrix.push(top, bottom);
 }
 const scale = 2;
 const width = matrix[0]!.length * scale;
 const height = matrix.length * scale;
 const data = new Uint8ClampedArray(width * height * 4);
 matrix.forEach((row, y) => {
  row.forEach((dark, x) => {
   const value = dark ? 0 : 255;
   for (let offsetY = 0; offsetY < scale; offsetY++) {
    for (let offsetX = 0; offsetX < scale; offsetX++) {
     const offset = (((y * scale) + offsetY) * width + (x * scale) + offsetX) * 4;
     data[offset] = value;
     data[offset + 1] = value;
     data[offset + 2] = value;
     data[offset + 3] = 255;
    }
   }
  });
 });
 const decoded = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
 expect(decoded).not.toBeNull();
 return decoded!.data;
}

function writeWeChatFixture(destination: string, bytes: Uint8Array, contentType: string): string {
 const fixtureRoot = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
 const source = JSON.parse(readFileSync(resolve(fixtureRoot, 'zhs/wechat-qr.json'), 'utf8')) as { interactions: Array<{ request: { method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }; response: { status: number; body?: unknown; base64?: string; headers?: Record<string, string | string[]> } }> };
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
 source.interactions[5]!.response = { status: 302, headers: { location: transit.toString(),
  'set-cookie': ['JSESSIONID=fixture-session; Path=/zhsuser; HttpOnly'] }, body: '' };
 const headers = { origin: 'https://login.zhihuishu.com', referer: 'https://login.zhihuishu.com/',
  'content-type': 'application/json;charset=UTF-8', cookie: 'JSESSIONID=fixture-session' };
 source.interactions.push(
  { request: { method: 'GET', host: 'login.zhihuishu.com', path: '/wxTransit/0', query: { cacheId: 'CACHE1', isLock: '0', service }, body: '' },
   response: { status: 200, body: '<html><title>登录中心</title></html>' } },
  { request: { method: 'GET', host: 'user.zhihuishu.com', path: '/zhsuser/user/cache/CACHE1', headers, body: '' },
   response: { status: 200, body: { status: 200, rt: { mobile: 'fixture-mobile', certifyList: [{ schoolId: 'fixture-school', role: 1 }] } } } },
  { request: { method: 'POST', host: 'user.zhihuishu.com', path: '/zhsuser/login/code/skipSet/CACHE1', headers, body: '' },
   response: { status: 200, body: { status: 1, rt: { pwd: 'ONCE1' } } } },
  { request: { method: 'GET', host: 'passport.zhihuishu.com', path: '/login', query: { pwd: 'ONCE1', service }, headers: { referer: 'https://login.zhihuishu.com/' }, body: '' },
   response: { status: 302, headers: { location: `${service}&ticket=fixture-ticket`,
    'set-cookie': ['CASLOGC=%7B%22uuid%22%3A%22u1%22%7D; Domain=zhihuishu.com; Path=/; Secure'] }, body: '' } },
  { request: { method: 'GET', host: 'onlineservice-api.zhihuishu.com', path: '/gateway/f/v1/login/gologin',
   query: { fromurl: 'https://onlineweb.zhihuishu.com/onlinestuh5', ticket: 'fixture-ticket' }, headers: { cookie: 'CASLOGC=%7B%22uuid%22%3A%22u1%22%7D' }, body: '' },
   response: { status: 200, body: {} } },
 );
 writeFileSync(destination, JSON.stringify(source));
 return destination;
}
describe('explicit machine QR login', () => {
 it('refuses implicit manual scanning before any network request', () => {
  expect(run(['init']).code).toBe(0);
  expect(run(['profile','add','alpha','--platform','ykt']).code).toBe(0);
  const result = run(['login','--profile','alpha','--json']);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stdout).error.code).toBe('INTERACTION_REQUIRED');
  expect(result.stderr).not.toContain('undeclared request');
 });
 it('emits only QR file metadata, cleans up, and never overwrites another file', () => {
  const path = resolve(home,'qr.png');
  writeFileSync(path,'keep');
  expect(run(['login','--profile','alpha','--qr-file',path,'--json']).code).toBe(3);
  expect(readFileSync(path,'utf8')).toBe('keep');
  const target = resolve(home,'new-qr.png');
  const result = run(['login','--profile','alpha','--qr-file',target,'--output-format','jsonl'],resolve(import.meta.dirname,'../../../packages/sdk/tests/fixtures/ykt/qr-login.json'));
  expect(result.code,result.stderr).toBe(0);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events.some(event => event.type === 'auth' && event.data.qrPath === target)).toBe(true);
  expect(events.at(-1).data.ok).toBe(true);
  expect(result.stdout).not.toContain('base64');
  expect(result.stdout).not.toContain('sessionid');
  expect(existsSync(target)).toBe(false);
 });

 it('keeps a synthetic logo-bearing JPEG QR payload out of machine JSONL output', () => {
  const machineHome = mkdtempSync(resolve(tmpdir(), 'learning-zhs-jpeg-machine-'));
  try {
   expect(runIn(machineHome, ['init']).code).toBe(0);
   expect(runIn(machineHome, ['profile', 'add', 'alpha', '--platform', 'zhs']).code).toBe(0);
   const value = 'https://example.com/zhs-machine-jpeg';
   const image = realisticByteQrJpeg(new TextEncoder().encode(value));
   const fixture = writeWeChatFixture(resolve(machineHome, 'wechat-machine-jpeg.json'), image, 'image/jpeg');
   const target = resolve(machineHome, 'new-qr.jpg');
   const result = runIn(machineHome, ['login', '--profile', 'alpha', '--qr-file', target, '--output-format', 'jsonl'], fixture);
   expect(result.code, result.stderr).toBe(0);
   const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
   expect(events.some(event => event.type === 'auth' && event.data.qrPath === target)).toBe(true);
   expect(events.at(-1).data.ok).toBe(true);
   expect(result.stdout).not.toContain('base64');
   expect(result.stdout).not.toContain('sessionid');
   expect(result.stdout).not.toContain(value);
   expect(result.stdout).not.toMatch(/CACHE1|ONCE1|fixture-ticket|%7B%22uuid|CODE1/);
   expect(existsSync(target)).toBe(false);
  } finally {
   rmSync(machineHome, { recursive: true, force: true });
  }
 });

 it('renders a ZHS WeChat PNG QR and completes wxTransit in a real terminal', async () => {
  const terminalHome = mkdtempSync(resolve(tmpdir(), 'learning-zhs-terminal-'));
  const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
  try {
   const prepare = (args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), '--home', terminalHome, ...args], { encoding: 'utf8' });
   const init = prepare(['init']);
   const addProfile = prepare(['profile', 'add', 'alpha', '--platform', 'zhs']);
   expect(init.status, init.stderr).toBe(0);
   expect(addProfile.status, addProfile.stderr).toBe(0);

   const png = await qrcode.toBuffer('https://example.com/zhs-terminal-qr', { type: 'png', margin: 4, scale: 4 });
   const fixture = writeWeChatFixture(resolve(terminalHome, 'wechat-terminal.json'), png, 'image/png');

   const terminalEnv = { ...process.env };
   delete terminalEnv.NO_COLOR;
   const result = spawnSync('python3', [driver, JSON.stringify({
    argv: [process.execPath, '--import', resolve(import.meta.dirname, 'fixture-fetch.mjs'), resolve(import.meta.dirname, '../dist/index.js'), '--home', terminalHome, 'login', '--profile', 'alpha'],
    steps: [],
    columns: 96,
    env: { LEARNING_FIXTURE_FILE: fixture },
   })], { encoding: 'utf8', timeout: 15_000, env: terminalEnv });
   expect(result.status, result.stderr).toBe(0);
   const terminal = JSON.parse(result.stdout) as { code: number; screen: string };
   expect(terminal.code, terminal.screen).toBe(0);
   expect(terminal.screen).toContain('已登录账号：alpha');
   expect(terminal.screen).not.toContain('请扫描二维码图片');
   expect(terminal.screen).not.toContain('https://example.com/zhs-terminal-qr');
   const modules = terminal.screen.match(/[█▀▄]/g)?.length ?? 0;
   expect(modules).toBeGreaterThan(100);
  } finally {
   rmSync(terminalHome, { recursive: true, force: true });
  }
 }, 20_000);

 it('renders a resized logo-bearing ZHS JPEG QR and completes wxTransit in a real terminal', async () => {
  const terminalHome = mkdtempSync(resolve(tmpdir(), 'learning-zhs-jpeg-terminal-'));
  const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
  try {
   const prepare = (args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), '--home', terminalHome, ...args], { encoding: 'utf8' });
   expect(prepare(['init']).status).toBe(0);
   expect(prepare(['profile', 'add', 'alpha', '--platform', 'zhs']).status).toBe(0);
   const value = 'https://example.com/zhs-terminal-jpeg';
   const image = realisticByteQrJpeg(new TextEncoder().encode(value));
   const fixture = writeWeChatFixture(resolve(terminalHome, 'wechat-terminal-jpeg.json'), image, 'image/jpeg');

   const terminalEnv = { ...process.env };
   delete terminalEnv.NO_COLOR;
   const result = spawnSync('python3', [driver, JSON.stringify({
    argv: [process.execPath, '--import', resolve(import.meta.dirname, 'fixture-fetch.mjs'), resolve(import.meta.dirname, '../dist/index.js'), '--home', terminalHome, 'login', '--profile', 'alpha'],
    steps: [], columns: 96, env: { LEARNING_FIXTURE_FILE: fixture },
   })], { encoding: 'utf8', timeout: 15_000, env: terminalEnv });
   expect(result.status, result.stderr).toBe(0);
   const terminal = JSON.parse(result.stdout) as { code: number; screen: string };
   expect(terminal.code).toBe(0);
   expect(terminal.screen).toContain('已登录账号：alpha');
   expect(terminal.screen.includes('请扫描二维码图片')).toBe(false);
   expect(terminal.screen).not.toContain(value);
   expect(terminal.screen).not.toMatch(/CACHE1|ONCE1|fixture-ticket|%7B%22uuid|CODE1/);
   expect(digest(decodeTerminalQr(terminal.screen))).toBe(digest(value));
  } finally {
   rmSync(terminalHome, { recursive: true, force: true });
  }
 }, 20_000);
});
