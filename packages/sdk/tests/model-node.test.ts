import { describe, expect, it } from 'vitest';
import { createCompatibleModelClient } from '../src/runtime/node/model.js';

const commonEventKeys = [
  '$ai_is_error',
  '$ai_latency',
  '$ai_model',
  '$ai_provider',
  '$ai_session_id',
  '$ai_span_id',
  '$ai_span_name',
  '$ai_stream',
  '$ai_trace_id',
].sort();

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

  it('captures one safe metadata event for every model outcome', async () => {
    const cases = [
      {
        name: 'network failure',
        fetchFn: async () => { throw new Error('offline'); },
        result: { data: { code: 'NETWORK' } },
        error: 'network_error',
      },
      {
        name: 'HTTP failure',
        fetchFn: async () => new Response('failed', { status: 500 }),
        result: { data: { code: 'PROTOCOL', message: 'model returned HTTP 500' } },
        error: 'http_error',
        status: 500,
      },
      {
        name: 'oversized body',
        fetchFn: async () => new Response('x'.repeat(1024 * 1024 + 1)),
        result: { data: { code: 'PROTOCOL', message: 'model response exceeds 1 MiB' } },
        error: 'response_too_large',
        status: 200,
      },
      {
        name: 'body read failure',
        fetchFn: async () => new Response(new ReadableStream({
          start(controller) { controller.error(new Error('body lost')); },
        })),
        result: { data: { code: 'PROTOCOL', message: 'model response is not JSON' } },
        error: 'response_read_error',
        status: 200,
      },
      {
        name: 'invalid JSON',
        fetchFn: async () => new Response('{'),
        result: { data: { code: 'PROTOCOL', message: 'model response is not JSON' } },
        error: 'invalid_json_response',
        status: 200,
      },
      {
        name: 'invalid response structure',
        fetchFn: async () => new Response(JSON.stringify({ choices: [] })),
        result: { data: { code: 'PROTOCOL', message: 'model completion has no text choice' } },
        error: 'invalid_response_structure',
        status: 200,
      },
      {
        name: 'invalid proposal JSON',
        fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{' } }] })),
        result: { data: { code: 'PROTOCOL', message: 'model returned invalid proposal JSON' } },
        error: 'invalid_proposal_json',
        status: 200,
      },
      {
        name: 'success',
        fetchFn: async () => new Response(JSON.stringify({
          choices: [{ message: { content: '{"text":"PRIVATE COMPLETION"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        })),
        result: { text: 'PRIVATE COMPLETION' },
        status: 200,
        tokens: [3, 5],
      },
    ];

    for (const testCase of cases) {
      const events: Array<Record<string, unknown>> = [];
      const client = createCompatibleModelClient({
        baseUrl: 'https://model.example.test/v1',
        model: 'fixture-model',
        apiKey: 'fixture-key',
        fetchFn: testCase.fetchFn as typeof fetch,
        aiSessionId: 'session-fixture',
        captureAiGeneration: properties => { events.push(properties); },
      });

      const proposal = client.propose({
        purpose: 'discussion',
        content: { topic: 'PRIVATE PROMPT' },
        signal: new AbortController().signal,
      });
      if ('data' in testCase.result) await expect(proposal).rejects.toMatchObject(testCase.result);
      else await expect(proposal).resolves.toEqual(testCase.result);

      expect(events, testCase.name).toHaveLength(1);
      const event = events[0]!;
      expect(Object.keys(event).sort(), testCase.name).toEqual([
        ...commonEventKeys,
        ...('status' in testCase ? ['$ai_http_status'] : []),
        ...('error' in testCase ? ['$ai_error'] : []),
        ...('tokens' in testCase ? ['$ai_input_tokens', '$ai_output_tokens'] : []),
      ].sort());
      expect(event.$ai_trace_id, testCase.name).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.$ai_session_id, testCase.name).toBe('session-fixture');
      expect(event.$ai_span_id, testCase.name).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.$ai_span_name, testCase.name).toBe('model_discussion_proposal');
      expect(event.$ai_model, testCase.name).toBe('fixture-model');
      expect(event.$ai_provider, testCase.name).toBe('openai-compatible');
      expect(event.$ai_latency, testCase.name).toEqual(expect.any(Number));
      expect(event.$ai_stream, testCase.name).toBe(false);
      if ('status' in testCase) expect(event.$ai_http_status, testCase.name).toBe(testCase.status);
      if ('error' in testCase) expect(event.$ai_error, testCase.name).toBe(testCase.error);
      expect(event.$ai_is_error, testCase.name).toBe('error' in testCase);
      if ('tokens' in testCase) {
        expect(event.$ai_input_tokens, testCase.name).toBe(testCase.tokens[0]);
        expect(event.$ai_output_tokens, testCase.name).toBe(testCase.tokens[1]);
      }
      const serialized = JSON.stringify(event);
      expect(serialized, testCase.name).not.toContain('PRIVATE PROMPT');
      expect(serialized, testCase.name).not.toContain('PRIVATE COMPLETION');
      expect(serialized, testCase.name).not.toContain('fixture-key');
      expect(serialized, testCase.name).not.toContain('model.example.test');
    }
  });

  it('uses a fresh trace per proposal, reuses the session, and ignores capture callback failures', async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = createCompatibleModelClient({
      baseUrl: 'https://model.example.test/v1',
      model: 'fixture-model',
      apiKey: 'fixture-key',
      fetchFn: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"ok"}' } }] })),
      aiSessionId: 'session-fixture',
      captureAiGeneration: properties => {
        events.push(properties);
        throw new Error('capture failed');
      },
    });
    const input = { purpose: 'discussion' as const, content: { topic: 'PRIVATE PROMPT' }, signal: new AbortController().signal };

    await expect(client.propose(input)).resolves.toEqual({ text: 'ok' });
    await expect(client.propose(input)).resolves.toEqual({ text: 'ok' });

    expect(events).toHaveLength(2);
    expect(events[0]!.$ai_trace_id).not.toBe(events[1]!.$ai_trace_id);
    expect(events[0]!.$ai_span_id).not.toBe(events[1]!.$ai_span_id);
    expect(events[0]!.$ai_session_id).toBe('session-fixture');
    expect(events[1]!.$ai_session_id).toBe('session-fixture');
  });

  it('keeps successful proposal behavior when usage is null or incomplete', async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = createCompatibleModelClient({
      baseUrl: 'https://model.example.test/v1',
      model: 'fixture-model',
      apiKey: 'fixture-key',
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"text":"PRIVATE COMPLETION"}' } }],
        usage: null,
      })),
      aiSessionId: 'session-fixture',
      captureAiGeneration: properties => { events.push(properties); },
    });

    await expect(client.propose({
      purpose: 'discussion',
      content: { topic: 'PRIVATE PROMPT' },
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: 'PRIVATE COMPLETION' });

    expect(events).toHaveLength(1);
    expect(events[0]!.$ai_is_error).toBe(false);
    expect('$ai_error' in events[0]!).toBe(false);
    expect('$ai_input_tokens' in events[0]!).toBe(false);
    expect('$ai_output_tokens' in events[0]!).toBe(false);
  });
});
