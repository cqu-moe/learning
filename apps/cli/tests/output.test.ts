import { describe, expect, it, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const home = mkdtempSync(resolve(tmpdir(), 'learning-output-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const run = (args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), '--home', home, ...args], { encoding: 'utf8', env: { ...process.env, CI: '1' } });
describe('machine output contract', () => {
  it('prints one result for init and doctor', () => {
    for (const command of ['init', 'doctor']) {
      const result = run([command, '--json']);
      expect(result.status).toBe(0);
      expect(result.stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, '')).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, command, ok: true, exitCode: 0, error: null });
    }
  });
  it('keeps parsing errors structured even when the output flag is after the error', () => {
    const result = run(['--bogus', '--json']);
    expect(result.status).toBe(2);
    expect(result.stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, '')).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 2, error: { code: 'INVALID_INPUT' } });
  });
  it('rejects conflicting formats with a structured error', () => {
    const result = run(['doctor', '--json', '--output-format', 'plain']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('INVALID_INPUT');
  });
  it('formats help and version as successful results', () => {
    for (const option of ['--help', '--version']) {
      const result = run([option, '--json']);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
    }
  });
  it('retains JSONL events in quiet mode and ends with one result', () => {
    const result = run(['doctor', '--output-format=jsonl', '--quiet']);
    expect(result.status).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(e => e.type)).toEqual(['start', 'result']);
    expect(events.map(e => e.sequence)).toEqual([1, 2]);
    expect(events[1].data.exitCode).toBe(result.status);
    expect(result.stdout).not.toContain('\u001b');
  });
  it('does not create a home when just asking for help', () => {
    const target = resolve(home, 'never-created');
    const result = run(['--home', target, '--help', '--json']);
    expect(result.status).toBe(0);
    expect(existsSync(target)).toBe(false);
  });
});

describe('output streams and terminal mode', () => {
  it('waits for the writer and handles a broken pipe without rejection', async () => {
    const { Writable } = await import('node:stream');
    const { createOutput, resolveOutputMode } = await import('../src/output.js');
    let flushed = false;
    const slow = new Writable({ write(_chunk, _encoding, callback) { setTimeout(() => { flushed = true; callback(); }, 20); } });
    const output = createOutput(resolveOutputMode({ json: true }), { stdout: slow, stderr: slow });
    output.set({}, '');
    await output.finish();
    expect(flushed).toBe(true);
    output.close();
    const broken = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })); } });
    const second = createOutput(resolveOutputMode({ json: true }), { stdout: broken, stderr: slow });
    await second.finish();
    expect(second.signal.aborted).toBe(true);
    second.close();
  });
  it('disables prompts for CI and redirected output, without treating CI=false as enabled', async () => {
    const { resolveOutputMode, cleanText } = await import('../src/output.js');
    const terminal = { stdin: true, stdout: true, stderr: true, term: 'xterm', ci: 'false', noColor: undefined };
    expect(resolveOutputMode({}, terminal).interactive).toBe(true);
    expect(resolveOutputMode({}, { ...terminal, stdout: false }).interactive).toBe(false);
    expect(resolveOutputMode({}, { ...terminal, ci: '1' }).interactive).toBe(false);
    expect(resolveOutputMode({ outputFormat: 'jsonl' }, terminal).interactive).toBe(false);
    expect(cleanText('\u001b]0;attack\u0007中文\r标题')).toBe('中文标题');
  });
});

it('reports all missing draft inputs before opening a platform client', () => {
 const result = run(['homework','draft','--json']);
 expect(result.status).toBe(2);
 expect(JSON.parse(result.stdout).error.fields).toEqual(['resource', 'output']);
});
