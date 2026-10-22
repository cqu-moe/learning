import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { captureWarnings } from '../src/warnings.js';
import { bindOutput, createOutput, resolveOutputMode } from '../src/output.js';
import { withCliRuntime } from '../src/context.js';
import { createCliRuntime } from '../src/runtime.js';
afterEach(() => { process.exitCode = 0; });
function streams() {
 let stdout='';let stderr='';
 return { stdout: new Writable({write(chunk,_encoding,callback){stdout+=String(chunk);callback();}}), stderr: new Writable({write(chunk,_encoding,callback){stderr+=String(chunk);callback();}}), read:()=>({stdout,stderr}) };
}
describe('unified warnings', () => {
 it('captures runtime, console and result warnings without losing other warning observers', async () => {
  const receiver=streams();const original=console.warn;const observer=vi.fn();
  process.on('warning',observer);
  const capture=captureWarnings();const output=createOutput(resolveOutputMode({outputFormat:'jsonl',quiet:true}),receiver);
  try {
   capture.attach(output.recordWarning);
   process.emitWarning('运行时警告',{code:'NODE_TEST',type:'CustomWarning'});
   console.warn('控制台%s','警告');
   output.set({warnings:[{code:'SDK_RESULT',message:'结果警告'}]},'');
   await capture.drain();await output.finish();
   const {stdout,stderr}=receiver.read();expect(stderr).toBe('');
   const events=stdout.trim().split('\n').map(line=>JSON.parse(line));
   expect(events.filter(event=>event.type==='warning').map(event=>event.data.code)).toEqual(expect.arrayContaining(['NODE_TEST','CONSOLE_WARNING','SDK_RESULT']));
   expect(events.at(-1).type).toBe('result');
   expect(events.at(-1).data.warnings).toHaveLength(3);
   expect(observer).toHaveBeenCalledWith(expect.objectContaining({code:'NODE_TEST'}));
  } finally {capture.close();output.close();process.off('warning',observer);}
  expect(console.warn).toBe(original);
 });
 it('routes SDK runtime warnings through the same channel without logging private fields', async () => {
  const directory=mkdtempSync(resolve(tmpdir(),'learning-warning-'));
  const runtime=createCliRuntime(directory);runtime.state.close();
  const program=new Command().option('--home <dir>');program.setOptionValue('home',directory);
  const receiver=streams();const output=createOutput(resolveOutputMode({json:true}),receiver);bindOutput(program,output);
  try {
   await withCliRuntime(program,false,async active=>{active.log({level:'warn',message:'字幕不可用，已保留视频',fields:{authorization:'DO_NOT_LOG'}});});
   await output.finish();const result=receiver.read();
   expect(JSON.parse(result.stdout).warnings).toEqual([{code:'SDK_WARNING',message:'字幕不可用，已保留视频'}]);
   expect(result.stdout+result.stderr).not.toContain('DO_NOT_LOG');
  } finally {output.close();rmSync(directory,{recursive:true,force:true});}
 });
});

it('preserves SDK warnings when a command unwraps only the result value', async () => {
 const { unwrapResult } = await import('../src/context.js');
 const program=new Command();const receiver=streams();
 const output=createOutput(resolveOutputMode({json:true}),receiver);bindOutput(program,output);
 try {
  expect(unwrapResult(program,{value:42,warnings:[{code:'PARTIAL_CATALOG',message:'目录可能不完整',resourceKey:null}]})).toBe(42);
  await output.finish();
  expect(JSON.parse(receiver.read().stdout).warnings).toEqual([{code:'PARTIAL_CATALOG',message:'目录可能不完整'}]);
 } finally {output.close();}
});

it.each([false, true])('only hides the SQLite experimental notice in the guided home, guided=%s', async guided => {
 const receiver = streams();
 const output = createOutput({ format: 'plain', interactive: true, quiet: false, color: false, debug: false, guided }, receiver);
 try {
  output.recordWarning('ExperimentalWarning', 'SQLite is an experimental feature and might change at any time');
  output.recordWarning('ExperimentalWarning', 'Another experimental API');
  output.recordWarning('SKIPPED_UNKNOWN_DURATION', '未能读取视频时长，本次暂不处理。');
  await output.finish();
  const { stderr } = receiver.read();
  expect(stderr.includes('SQLite is an experimental')).toBe(!guided);
  expect(stderr).toContain('Another experimental API');
  expect(stderr).toContain('未能读取视频时长');
 } finally { output.close(); }
});
