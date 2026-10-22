import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fillMissing } from '../src/prompts.js';

describe('missing input resolution', () => {
  const schema = z.object({ name: z.string().min(1), platform: z.enum(['ykt', 'xuetang', 'zhs']) });
  it('only asks for the missing field', async () => {
    const asked: string[] = [];
    const prompts = { interactive: true, ask: async (field: { name: string }) => { asked.push(field.name); return 'alpha'; } };
    expect(await fillMissing(schema, { platform: 'ykt' }, [{ name: 'name', message: '账号名' }, { name: 'platform', message: '平台' }], prompts)).toEqual({ name: 'alpha', platform: 'ykt' });
    expect(asked).toEqual(['name']);
  });
  it('rejects an explicit wrong value before asking anything', async () => {
    let called = false;
    const prompts = { interactive: true, ask: async () => { called = true; return 'alpha'; } };
    await expect(fillMissing(schema, { platform: 'bad' }, [{ name: 'name', message: '账号名' }], prompts)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(called).toBe(false);
  });
  it('reports all required fields without prompting in automation', async () => {
    await expect(fillMissing(schema, {}, [], { interactive: false, ask: async () => { throw new Error('must not prompt'); } })).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['name', 'platform'] });
  });
  it('preserves explicitly supplied false and zero', async () => {
    const prompts = { interactive: false, ask: async () => { throw new Error('must not prompt'); } };
    expect(await fillMissing(z.object({ enabled: z.boolean(), count: z.number() }), { enabled: false, count: 0 }, [], prompts)).toEqual({ enabled: false, count: 0 });
  });
});

describe('text prompt default submission', () => {
  it('validates empty submissions against the default value', async () => {
    const { submittedText } = await import('../src/prompts.js');
    expect(submittedText(undefined, '5')).toBe('5');
    expect(submittedText('', '1')).toBe('1');
    expect(submittedText('3', '1')).toBe('3');
    expect(submittedText(undefined)).toBeUndefined();
  });
});

describe('course selection', () => {
 it.each([false, true])('loads another page and keeps duplicate titles unambiguous, guided=%s', async guided => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { vi } = await import('vitest');
  const { createCliRuntime } = await import('../src/runtime.js');
  const { createLearningClient } = await import('@learning/sdk');
  const { chooseCourse } = await import('../src/commands/catalog.js');
  const dir = mkdtempSync(join(tmpdir(), 'learning-select-'));
  const runtime = createCliRuntime(dir);
  const scope = { userId: 'local', profileId: 'one', platform: 'ykt' as const };
  const course = (key: string) => ({ ref: { scope, key, native: { kind: 'ykt' as const, classroomId: key } }, title: '同名课程', system: null, term: null, teachers: [], locked: null });
  const client = createLearningClient({ scope, runtime });
  const first = 'a'.repeat(64), second = 'b'.repeat(64), third = 'c'.repeat(64);
  const courses = vi.spyOn(client.catalog, 'courses').mockResolvedValueOnce({ items: [course(first)], nextCursor: 'next', completeness: 'more', warnings: [] }).mockResolvedValueOnce({ items: [course(second), { ...course(third), term: '2026 秋', teachers: ['示例教师'] }], nextCursor: null, completeness: 'complete', warnings: [] });
  const labels: string[] = [];
  let step = 0;
  try {
   const ref = await chooseCourse(client, runtime, { interactive: true, guided, ask: async field => { labels.push(...(field.options ?? []).map(option => option.label)); return step++ === 0 ? '__more__' : second; } });
   expect(ref.key).toBe(second);
   expect(courses).toHaveBeenNthCalledWith(2, { cursor: 'next' });
   if (guided) {
    expect(labels).toContain('同名课程（1）');
    expect(labels).toContain('同名课程（2）');
    expect(labels).toContain('同名课程 · 2026 秋 · 示例教师');
    expect(labels.join(' ')).not.toMatch(/[a-f0-9]{64}/);
   } else { expect(labels.join(' ')).toContain(first); expect(labels.join(' ')).toContain(second); }
   expect(await runtime.state.get(`cli:course:${second}`)).not.toBe(null);
  } finally { await client.close(); runtime.state.close(); rmSync(dir, { recursive: true, force: true }); }
 });
});

it('keeps full identifiers on narrow terminals and strips terminal controls', async () => {
 const { formatTable } = await import('../src/output.js');
 for (const width of [32, 80, 120]) {
  const text = formatTable(['课程','key'], [['\u001b]0;injected\u0007中文标题','course-123']], width);
  expect(text).toContain('中文标题');
  expect(text).toContain('course-123');
  expect(text).not.toContain('\u001b');
 }
});

it('parses a learning draft through the SDK before selecting its owner', async () => {
 const sdk = await import('@learning/sdk');
 expect(typeof sdk.parseLearningDraft).toBe('function');
 expect(() => sdk.parseLearningDraft('{"schemaVersion":1}')).toThrow();
});

it('does not prepare or send an answer after a live question deadline', async () => {
 const { confirmCurrentAnswer } = await import('../src/commands/live.js');
 expect(typeof confirmCurrentAnswer).toBe('function');
 const { mkdtempSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { vi } = await import('vitest');
 const { createCliRuntime } = await import('../src/runtime.js');
 const { createLearningClient } = await import('@learning/sdk');
 const { createOutput, resolveOutputMode } = await import('../src/output.js');
 const { Writable } = await import('node:stream');
 const directory = mkdtempSync(join(tmpdir(),'learning-deadline-'));
 const runtime = createCliRuntime(directory);
 runtime.transport.fetch = async () => { throw new Error('network not registered'); };
 const client = createLearningClient({scope:{userId:'local',profileId:'one',platform:'ykt'},runtime});
 const prepare = vi.spyOn(client.actions,'prepare');
 const execute = vi.spyOn(client.actions,'execute');
 const sink = new Writable({write(_chunk,_encoding,callback){callback();}});
 const output = createOutput(resolveOutputMode({}, {stdin:true,stdout:true,stderr:true,term:'dumb',ci:undefined,noColor:undefined}),{stdout:sink,stderr:sink});
 try {
  await confirmCurrentAnswer(client,'job',{type:'question',sequence:1,jobId:'job',phaseId:'phase',closesAtMs:Date.now()-1,question:{id:'question',kind:'judgement',rawType:'judge',body:{plainText:'题干',markdown:'题干',decodeState:'not-needed',sourceHash:'hash'},options:[],fingerprint:'hash',attemptsUsed:null,maxAttempts:null,myAnswer:null,feedback:null}},output);
  expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
 } finally {output.close();await client.close();runtime.state.close();rmSync(directory,{recursive:true,force:true});}
});
