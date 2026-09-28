import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
const root = mkdtempSync(resolve(tmpdir(), 'learning-terminal-'));
const cli = resolve(import.meta.dirname, '../dist/index.js');
const driver = resolve(import.meta.dirname, 'helpers/terminal-driver.py');
afterAll(() => rmSync(root, { recursive: true, force: true }));
function terminal(args: string[], steps: Array<{ wait: string; send?: string; signal?: string; occurrences?: number }>, columns = 80, term = 'xterm-256color') {
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
    expect(result.screen).not.toContain('\u001b');
  }, 20_000);
  it('returns home after each operation and exits explicitly', () => {
    const result = terminal(['--output-format','plain'], [
      { wait: '请选择操作', send: '2\n' },
      { wait: '请选择操作', occurrences: 2, send: '2\n' },
      { wait: '请选择操作', occurrences: 3, send: '19\n' },
    ]);
    expect(result.code).toBe(0);
    expect(result.steps).toBe(3);
    expect(result.screen.match(/Node：/g)).toHaveLength(2);
    expect(result.screen.match(/请选择操作/g)).toHaveLength(3);
    expect(result.screen).toContain('退出');
  }, 20_000);
  it('returns home after an operation error without leaking its exit code', () => {
    const result = terminal(['--output-format','plain'], [
      { wait: '请选择操作', send: '7\n' },
      { wait: '请选择操作', occurrences: 2, send: '1\n' },
      { wait: '账号名称', send: 'plain-user\n' },
      { wait: '选择平台', send: '1\n' },
      { wait: '请选择操作', occurrences: 3, send: '19\n' },
    ]);
    expect(result.code).toBe(0);
    expect(result.steps).toBe(5);
    expect(result.screen).toContain('错误');
  }, 20_000);
  it('collects fresh arguments and releases the lock between home operations', () => {
    const result = terminal(['--output-format','plain'], [
      { wait: '请选择操作', send: '7\n' },
      { wait: '请选择操作', occurrences: 2, send: '1\n' },
      { wait: '账号名称', send: 'home-first\n' },
      { wait: '选择平台', send: '1\n' },
      { wait: '请选择操作', occurrences: 3, send: '7\n' },
      { wait: '请选择操作', occurrences: 4, send: '1\n' },
      { wait: '账号名称', occurrences: 2, send: 'home-second\n' },
      { wait: '选择平台', occurrences: 2, send: '2\n' },
      { wait: '请选择操作', occurrences: 5, send: '19\n' },
    ]);
    expect(result.code).toBe(0);
    expect(result.steps).toBe(9);
    const list = spawnSync(process.execPath, [cli,'--home',root,'profile','list','--json'], {encoding:'utf8'});
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout).data.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({name:'home-first',scope:expect.objectContaining({platform:'ykt'})}),
      expect.objectContaining({name:'home-second',scope:expect.objectContaining({platform:'xuetang'})}),
    ]));
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

it('retries invalid plain input and preserves a profile when confirmation is declined', () => {
 const result = terminal(['profile','remove','plain-user','--output-format','plain','--quiet'], [{ wait: '确认执行以上操作', send: 'n\n' }], 32, 'dumb');
 expect(result.code).toBe(3);
 const list = spawnSync(process.execPath,[cli,'--home',root,'profile','list','--json'],{encoding:'utf8'});
 expect(JSON.parse(list.stdout).data.profiles.some((profile:{name:string})=>profile.name==='plain-user')).toBe(true);
 expect(result.screen).not.toContain('\u001b');
 expect(result.screen).toContain('删除账号 plain-user');
},20_000);

it('presents Chinese help for every registered leaf command', async () => {
 const { createProgram } = await import('../src/program.js');
 const program = createProgram();
 const paths: string[][] = [];
 const visit = (command: typeof program, path: string[]) => {
  if (!command.commands.length) paths.push(path);
  for (const child of command.commands) visit(child,[...path,child.name()]);
 };
 for (const command of program.commands) visit(command,[command.name()]);
 expect(paths).toHaveLength(33);
 expect(paths.map(path=>path.join(' '))).toContain('exam draft');
 expect(paths.map(path=>path.join(' '))).toContain('operations reconcile');
 for (const path of paths) {
  const result = spawnSync(process.execPath,[cli,...path,'--help'],{encoding:'utf8'});
  expect(result.status,path.join(' ')).toBe(0);
  expect(result.stdout).toContain('用法');
 }
},20_000);

it('persists a real foreground pause on SIGINT and reports a canceled invocation', async () => {
 const { SqliteStateStore } = await import('@learning/sdk/node');
 const state = new SqliteStateStore(resolve(root,'state.db'));
 try {
  const profile = await state.get('cli:profile:plain-user');
  const scope = (profile!.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
  await state.commit({expected:[{key:'job:terminal-job',revision:null},{key:'job-meta:terminal-job',revision:null}],changes:[{key:'job:terminal-job',value:{id:'terminal-job',scope,kind:'export',status:'waiting',createdAtMs:1,updatedAtMs:1,nextRunAtMs:Date.now()+30_000,completed:0,total:1,items:[],warnings:[]}},{key:'job-meta:terminal-job',value:{inputDigest:'x',generation:1,cursor:null,pendingOperationId:null,running:false}}]});
 } finally {state.close();}
 const result = terminal(['jobs','resume','terminal-job','--output-format','jsonl'],[{wait:'"status":"waiting"',signal:'SIGINT'}]);
 expect(result.code).toBe(3);
 const events = result.screen.split('\n').map(line=>line.trim()).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
 expect(events.at(-1).data.status).toBe('canceled');
 const saved = spawnSync(process.execPath,[cli,'--home',root,'jobs','show','terminal-job','--json'],{encoding:'utf8'});
 expect(JSON.parse(saved.stdout).data.status).toBe('paused');
},20_000);

it('rejects an explicit nonexistent draft before asking which profile to use', () => {
 const result = terminal(['homework','apply',resolve(root,'missing.yaml'),'--yes','--output-format','plain'],[]);
 expect(result.code).toBe(2);
 expect(result.screen).not.toContain('选择账号');
},20_000);

it('accepts an existing select default with Enter in plain mode', () => {
 const script = `import {createPrompts} from ${JSON.stringify(resolve(import.meta.dirname,'../dist/prompts.js'))}; const value=await createPrompts({format:'plain',interactive:true,quiet:false,color:false,debug:false}).ask({name:'format',message:'输出格式',initialValue:'pdf',options:[{value:'pdf',label:'PDF'},{value:'images',label:'图片'}]}); console.log('default='+value);`;
 const result = spawnSync('python3',[driver,JSON.stringify({argv:[process.execPath,'--input-type=module','-e',script],steps:[{wait:'输出格式',send:'\n'},{wait:'请选择有效编号',send:'1\n'}]})],{encoding:'utf8',timeout:15_000});
 expect(result.status,result.stderr).toBe(0);
 const data=JSON.parse(result.stdout);
 expect(data.code).toBe(0);
 expect(data.screen).toContain('default=pdf');
 expect(data.screen).not.toContain('请选择有效编号');
},20_000);

it('cleans up the writer lock when SIGTERM interrupts a confirmation', () => {
 try {
  const result=terminal(['profile','remove','plain-user','--output-format','plain'],[{wait:'确认执行以上操作',signal:'SIGTERM'}]);
  expect(result.code).toBe(3);
  expect(existsSync(resolve(root,'learning.lock'))).toBe(false);
 } finally {rmSync(resolve(root,'learning.lock'),{force:true});}
},20_000);

it('prints the resolved profile name and platform in the equivalent command', async () => {
 const result=terminal(['profile','--output-format','plain'],[{wait:'请选择操作',send:'1\n'},{wait:'账号名称',send:'gamma\n'},{wait:'选择平台',send:'1\n'}]);
 expect(result.code).toBe(0);expect(result.screen).toContain("'--platform' 'ykt'");expect(result.screen).toContain("'gamma'");
},20_000);

it('retries an invalid interactively supplied draft path', () => {
 const retry=terminal(['homework','apply','--output-format','plain'],[{wait:'草稿文件路径',send:resolve(root,'missing-again.yaml')+'\n'},{wait:'请重新输入',send:'\u0003'}]);
 expect(retry.code).toBe(3);expect(retry.steps).toBe(2);
},20_000);

it('routes startup and mid-menu warnings without writing inside the active frame', () => {
 const result = spawnSync('python3', [driver, JSON.stringify({ argv: [process.execPath, '--import', resolve(import.meta.dirname,'helpers/menu-warnings.mjs'), cli, '--home', root], columns: 80, rows: 30, env: {NODE_OPTIONS:'',NODE_NO_WARNINGS:'0',NO_COLOR:'1'}, steps: [{wait:'Type:',send:'\u001b[B'},{wait:'Type:',occurrences:2,send:'\u0003'}] })], {encoding:'utf8',timeout:15_000});
 expect(result.status,result.stderr).toBe(0);
 const data = JSON.parse(result.stdout) as {code:number;steps:number;snapshots:string[];screen:string};
 expect(data.code).toBe(3);expect(data.steps).toBe(2);
 const trace = data.snapshots[1]!;
 expect(trace).toContain('● doctor');
 expect(trace).not.toContain('(node:');
 expect(trace.indexOf('警告 [ExperimentalWarning]')).toBeGreaterThanOrEqual(0);
 expect(trace.indexOf('警告 [ExperimentalWarning]')).toBeLessThan(trace.indexOf('\u001b[?25l'));
 expect(trace).not.toContain('方向键操作期间');
 expect(data.screen).toContain('警告 [MENU_RUNTIME]');
 expect(data.screen).toContain('警告 [CONSOLE_WARNING]');
 expect(data.screen).not.toContain('(node:');
},20_000);
