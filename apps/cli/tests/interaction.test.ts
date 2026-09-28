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
