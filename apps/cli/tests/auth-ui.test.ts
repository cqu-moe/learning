import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
});
