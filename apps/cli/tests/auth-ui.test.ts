import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import qrcode from 'qrcode';
const home = mkdtempSync(resolve(tmpdir(), 'learning-auth-ui-'));
const empty = resolve(home, 'empty.json');
writeFileSync(empty, '{"interactions":[]}');
afterAll(() => rmSync(home, { recursive: true, force: true }));
function run(args: string[], fixture = empty) {
 const result = spawnSync(process.execPath, ['--import',resolve(import.meta.dirname,'fixture-fetch.mjs'),resolve(import.meta.dirname,'../dist/index.js'),'--home',home,...args], { encoding: 'utf8', env: { ...process.env, LEARNING_FIXTURE_FILE: fixture } });
 return { code: result.status, stdout: result.stdout, stderr: result.stderr };
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

 it('renders a ZHS WeChat PNG QR in a real terminal without re-encoding its URL', async () => {
  const terminalHome = mkdtempSync(resolve(tmpdir(), 'learning-zhs-terminal-'));
  const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
  const fixtureRoot = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
  try {
   const prepare = (args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), '--home', terminalHome, ...args], { encoding: 'utf8' });
   const init = prepare(['init']);
   const addProfile = prepare(['profile', 'add', 'alpha', '--platform', 'zhs']);
   expect(init.status, init.stderr).toBe(0);
   expect(addProfile.status, addProfile.stderr).toBe(0);

   const source = JSON.parse(readFileSync(resolve(fixtureRoot, 'zhs/wechat-qr.json'), 'utf8')) as { interactions: Array<{ request: { query?: Record<string, string> }; response: { base64?: string } }> };
   const service = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=https://onlineweb.zhihuishu.com/onlinestuh5';
   const redirect = `https://user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin?service=${encodeURIComponent(service)}`;
   const state = 'https://login.zhihuishu.com/wxTransit/0';
   source.interactions[0]!.request.query = { appid: 'wx3f96cd4b1dc1f574', scope: 'snsapi_login', redirect_uri: redirect, state, login_type: 'jssdk', self_redirect: 'false' };
   for (const row of source.interactions.slice(2, 5)) row.request.query = { uuid: 'WXUUID1', _: '__NOW_MS__' };
   source.interactions[5]!.request.query = { service, code: 'CODE1', state };
   source.interactions[1]!.response.base64 = (await qrcode.toBuffer('https://example.com/zhs-terminal-qr', { type: 'png', margin: 4, scale: 4 })).toString('base64');
   const fixture = resolve(terminalHome, 'wechat-terminal.json');
   writeFileSync(fixture, JSON.stringify(source));

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
});
