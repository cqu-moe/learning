import { describe, expect, it } from 'vitest';
import { createCompatibleModelClient } from '../src/runtime/node/model.js';

describe('Node compatible model adapter', () => {
  it('sends only selected content with the configured model and parses JSON output', async () => {
    let request: Request | null = null;
    const fetchFn: typeof fetch = async (input) => {
      request = input as Request;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[{"questionId":"11","keys":["B"]}]}' } }] }), { status: 200 });
    };
    const client = createCompatibleModelClient({ baseUrl: 'https://model.example.test/v1', model: 'fixture-model', apiKey: 'fixture-key', fetchFn });
    const result = await client.propose({ purpose: 'answers', content: [{ questionId: '11', body: '已解码题干', options: [{ key: 'B', body: '选项' }] }], signal: new AbortController().signal });
    expect(result).toEqual({ suggestions: [{ questionId: '11', keys: ['B'] }] });
    expect(request).not.toBeNull();
    const captured = request!;
    expect(captured.url).toBe('https://model.example.test/v1/chat/completions');
    expect(captured.method).toBe('POST');
    expect(captured.headers.get('authorization')).toBe('Bearer fixture-key');
    const body = JSON.parse(await captured.text()) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('fixture-model');
    expect(JSON.stringify(body)).toContain('已解码题干');
    expect(JSON.stringify(body)).not.toContain('sessionid');
  });

  it('refuses insecure endpoints and does not expose keys in errors', async () => {
    expect(() => createCompatibleModelClient({ baseUrl: 'http://model.example.test/v1', model: 'm', apiKey: 'fixture-key' })).toThrow(/HTTPS/);
    const client = createCompatibleModelClient({ baseUrl: 'https://model.example.test/v1', model: 'm', apiKey: 'fixture-key', fetchFn: async () => new Response('server rejected fixture-key', { status: 403 }) });
    await expect(client.propose({ purpose: 'discussion', content: { topic: 'x' }, signal: new AbortController().signal })).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
    try { await client.propose({ purpose: 'discussion', content: { topic: 'x' }, signal: new AbortController().signal }); }
    catch (error) { expect(String(error)).not.toContain('fixture-key'); }
  });
});
