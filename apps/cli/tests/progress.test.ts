import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createOutput } from '../src/output.js';

afterEach(() => { vi.useRealTimers(); process.exitCode = 0; });

function terminal(columns = 80) {
  let text = '';
  let result = '';
  const stderr = Object.assign(new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }), { columns, isTTY: true });
  const stdout = new Writable({ write(chunk, _encoding, done) { result += String(chunk); done(); } });
  return { stderr, stdout, read: () => text, readResult: () => result, clear: () => { text = ''; } };
}

const progress = { jobId: 'job-one', resourceKey: 'a'.repeat(64), status: 'waiting', completed: 2, total: 95, serverFraction: 0.2, estimatedSeconds: null, title: '1.1 心理与健康', durationSeconds: 100, serverSeconds: 20, sourceSequence: 3 };
const study = { courseTitle: '大学生心理健康', profileName: '测试账号', speed: 2, targetFraction: 1, nextRunAtMs: 5000 };

describe('live progress display', () => {
  it.each([20, null])('redraws the same bars while waiting with server seconds %s and labels local estimates separately', async serverSeconds => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const receiver = terminal();
    const output = createOutput({ format: 'pretty', interactive: true, quiet: false, color: false, debug: false }, receiver);
    try {
      await output.progress({ ...progress, serverSeconds }, study);
      expect(receiver.read()).toContain('大学生心理健康');
      expect(receiver.read()).toContain('2/95');
      expect(receiver.read()).toContain('整课');
      expect(receiver.read()).toContain('视频');
      expect(receiver.read()).toContain('█');
      receiver.clear();
      await vi.advanceTimersByTimeAsync(1000);
      const updates = receiver.read();
      expect(stripVTControlCharacters(updates).match(/0:2[012]\/1:40/g)?.length).toBeGreaterThanOrEqual(8);
      expect(stripVTControlCharacters(updates)).toContain('0:22/1:40');
      expect(stripVTControlCharacters(updates)).toContain('平台已确认 20.0%');
      expect(updates).not.toContain(progress.resourceKey);
      expect(updates).not.toContain('等待下一阶段');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stripVTControlCharacters(receiver.read())).not.toContain('1:00/1:40');
      await output.progress({ ...progress, status: 'uncertain' }, study);
      expect(receiver.read()).toContain('写入结果待核对');
      receiver.clear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(receiver.read()).toBe('');
    } finally { output.close(); }
    receiver.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(receiver.read()).toBe('');
  });

  it.each([true, false])('keeps unknown progress honest and respects color=%s across narrow terminal resizing', async color => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const receiver = terminal();
    const output = createOutput({ format: 'pretty', interactive: true, quiet: false, color, debug: false }, receiver);
    try {
      await output.progress({ ...progress, total: null, serverFraction: null, serverSeconds: null, durationSeconds: null }, study);
      const initial = receiver.read();
      expect(stripVTControlCharacters(initial)).toContain('整课');
      expect(stripVTControlCharacters(initial)).toContain('视频');
      expect(stripVTControlCharacters(initial)).toContain('进度未知');
      expect(stripVTControlCharacters(initial)).not.toContain('░');
      expect(stripVTControlCharacters(initial)).not.toContain('100.0%');
      expect(initial.includes('\u001b[32m')).toBe(color);
      expect(initial.includes('\u001b[36m')).toBe(color);
      receiver.clear();
      receiver.stderr.columns = 24;
      receiver.stderr.emit('resize');
      await output.progress(progress, study);
      await vi.advanceTimersByTimeAsync(1000);
      const narrow = stripVTControlCharacters(receiver.read());
      expect(narrow).toContain('2/95');
      expect(narrow).toContain('0:22/1:40');
      expect(narrow).toContain('平台已确认 20.0%');
      await output.finish();
      expect(receiver.read().lastIndexOf('\u001b[?25h')).toBeGreaterThan(receiver.read().lastIndexOf('\u001b[?25l'));
      receiver.clear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(receiver.read()).toBe('');
    } finally { output.close(); }
  });

  it('suspends drawing for prompts, restores it after warnings and stops on stream failure', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const receiver = terminal(32);
    const output = createOutput({ format: 'pretty', interactive: true, quiet: false, color: false, debug: false }, receiver);
    try {
      await output.progress({ ...progress, title: ' \n\t' }, study);
      expect(receiver.read()).toContain('当前 学习资源');
      receiver.clear();
      await output.progress({ ...progress, title: '\u001b[31m第一讲\n伪造新行\t🙂'.repeat(8) }, study);
      expect(receiver.read()).not.toContain('\u001b[31m');
      expect(receiver.read()).not.toContain('\n伪造新行');
      expect(receiver.read()).toContain('…');
      await output.warning('READBACK', '平台同步较慢');
      expect(receiver.read()).toContain('警告 [READBACK]');
      receiver.clear();
      await vi.advanceTimersByTimeAsync(100);
      expect(receiver.read()).toContain('大学生心理健康');
      await output.beginPrompt(); receiver.clear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(receiver.read()).toBe('');
      await output.endPrompt();
      await output.progress(progress, study);
      receiver.stderr.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
      receiver.clear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(output.signal.aborted).toBe(true);
      expect(receiver.read()).toBe('');
    } finally { output.close(); }
  });

  it.each(['plain', 'jsonl'] as const)('keeps %s output static without animation or invented progress events', async format => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const receiver = terminal();
    const output = createOutput({ format, interactive: false, quiet: false, color: false, debug: false }, receiver);
    try {
      await output.progress(progress, study);
      const original = receiver.read();
      const machine = receiver.readResult();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(receiver.read()).toBe(original);
      expect(receiver.readResult()).toBe(machine);
      expect(original).not.toContain('\u001b');
      if (format === 'plain') expect(original).toContain('大学生心理健康');
      else {
        expect(original).toBe('');
        expect(machine.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['start', 'progress']);
        expect(JSON.parse(machine.trim().split('\n')[1]!).data.serverFraction).toBe(0.2);
      }
    } finally { output.close(); }
  });

  it('bounds buffered frames under backpressure and resumes after drain', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let release = () => {};
    let writes = 0;
    const stderr = Object.assign(new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { writes++; release = done; } }), { isTTY: true, columns: 80 });
    const output = createOutput({ format: 'pretty', interactive: true, quiet: false, color: true, debug: false }, { stdout: terminal().stdout, stderr });
    try {
      await output.progress(progress, study);
      const buffered = stderr.writableLength;
      expect(buffered).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(stderr.writableLength).toBe(buffered);
      release();
      await vi.advanceTimersByTimeAsync(100);
      expect(writes).toBeGreaterThan(1);
    } finally { stderr.destroy(); output.close(); }
  });
});

it('releases the redraw timer when a terminal closes without an error', () => {
  const script = `
    import {Writable} from 'node:stream';
    import {createOutput} from ${JSON.stringify(resolve(import.meta.dirname, '../dist/output.js'))};
    const stderr=Object.assign(new Writable({write(_chunk,_encoding,done){done();}}),{isTTY:true,columns:80});
    const output=createOutput({format:'pretty',interactive:true,quiet:false,color:false,debug:false},{stdout:process.stdout,stderr});
    await output.progress(${JSON.stringify(progress)},${JSON.stringify(study)});
    setTimeout(()=>stderr.destroy(),100);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it.each([32, 80])('redraws in a real %i-column terminal and restores the cursor on Ctrl+C', columns => {
  const script = `
    import {createOutput,resolveOutputMode} from ${JSON.stringify(resolve(import.meta.dirname, '../dist/output.js'))};
    const output=createOutput(resolveOutputMode({color:false}));
    const keepAlive=setTimeout(()=>{throw new Error('signal not received')},10000);
    process.once('SIGINT',async()=>{
      clearTimeout(keepAlive);
      output.markCanceled();
      output.set({},'已暂停');
      await output.finish();
      output.close();
    });
    await output.progress(${JSON.stringify(progress)},{...${JSON.stringify(study)},nextRunAtMs:Date.now()+5000});
    setTimeout(()=>output.warning('SYNC','平台同步较慢'),200);
  `;
  const result = spawnSync('python3', [resolve(import.meta.dirname, 'helpers/terminal-driver.py'), JSON.stringify({ argv: [process.execPath, '--input-type=module', '-e', script], columns, steps: [{ wait: '0:21/1:40', signal: 'SIGINT' }] })], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0);
  const actual = JSON.parse(result.stdout) as { code: number; screen: string; steps: number };
  expect(actual.code).toBe(3);
  expect(actual.steps).toBe(1);
  expect(actual.screen).toContain('大学生心理健康');
  expect(actual.screen).toContain('警告 [SYNC]');
  expect(actual.screen).toContain('█');
  expect(actual.screen).toContain('已暂停');
  expect(actual.screen.lastIndexOf('\u001b[?25h')).toBeGreaterThan(actual.screen.lastIndexOf('\u001b[?25l'));
}, 20_000);
