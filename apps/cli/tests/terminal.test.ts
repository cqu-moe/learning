import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
const root = mkdtempSync(resolve(tmpdir(), 'learning-terminal-'));
const cli = resolve(import.meta.dirname, '../dist/index.js');
const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
afterAll(() => rmSync(root, { recursive: true, force: true }));
function terminal(args: string[], steps: Array<{ wait: string; send: string }>, columns = 80, term = 'xterm-256color') {
  const result = spawnSync('python3', [driver, JSON.stringify({ argv: [process.execPath, cli, '--home', root, ...args], steps, columns, term })], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { code: number; screen: string; steps: number };
}
describe('real terminal interaction', () => {
  it('fills only the missing profile name in plain mode', () => {
    expect(spawnSync(process.execPath, [cli, '--home', root, 'init']).status).toBe(0);
    const result = terminal(['profile','add','--platform','ykt','--output-format','plain'], [{ wait: '账号名称', send: 'plain-user\n' }]);
    expect(result.code).toBe(0);
    expect(result.screen).toContain('plain-user');
    expect(result.screen).not.toContain('选择平台');
  }, 20_000);
  it('runs one selected command then exits', () => {
    const result = terminal(['--output-format','plain'], [{ wait: '请选择操作', send: '2\n' }]);
    expect(result.code).toBe(0);
    expect(result.screen).toContain('node:');
    expect(result.screen.match(/请选择操作/g)).toHaveLength(1);
  }, 20_000);
  it('uses Clack in a real terminal', () => {
    const result = terminal(['profile','add','--platform','ykt'], [{ wait: '账号名称', send: 'pretty-user\r' }]);
    expect(result.code).toBe(0);
    expect(result.screen).toContain('pretty-user');
  }, 20_000);
  it('cancels before writing a profile', () => {
    const result = terminal(['profile','add','--platform','ykt','--output-format','plain'], [{ wait: '账号名称', send: '\u0003' }]);
    expect(result.code).toBe(3);
    expect(result.screen).toContain('CANCELED');
  }, 20_000);
});
