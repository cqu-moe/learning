import { z } from 'zod';
import { LearningError } from '../../types/errors.js';
import type { ModelClient } from '../types.js';

const ChatResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });
const MAX_RESPONSE_BYTES = 1024 * 1024;

function failure(code: 'INVALID_INPUT' | 'NETWORK' | 'PROTOCOL', message: string): LearningError {
  return new LearningError({ code, message, retryAfterMs: null, operationId: null });
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw failure('PROTOCOL', 'model response exceeds 1 MiB');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Explicitly configured, Node-only Chat Completions compatible adapter. */
export function createCompatibleModelClient(config: { baseUrl: string; model: string; apiKey: string; fetchFn?: typeof fetch }): ModelClient {
  let base: URL;
  try { base = new URL(config.baseUrl); }
  catch { throw failure('INVALID_INPUT', 'model base URL is invalid'); }
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') throw failure('INVALID_INPUT', 'model base URL must be HTTPS without credentials, query or fragment');
  if (config.model.trim() === '' || config.apiKey.trim() === '') throw failure('INVALID_INPUT', 'model name and API key are required');
  const endpoint = new URL('chat/completions', `${base.toString().replace(/\/$/, '')}/`);
  const fetchFn = config.fetchFn ?? fetch;
  return {
    propose: async ({ purpose, content, signal }) => {
      const instruction = purpose === 'answers'
        ? 'Return only JSON with a suggestions array of questionId and option keys. Do not invent unavailable text. These are editable suggestions, not submissions.'
        : 'Return only JSON with one nonempty text field containing an editable discussion reply. Do not submit it.';
      const request = new Request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(content) }], stream: false }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit', redirect: 'error' });
      let response: Response;
      try { response = await fetchFn(request); }
      catch { throw failure('NETWORK', 'model request failed'); }
      if (!response.ok) throw failure('PROTOCOL', `model returned HTTP ${response.status}`);
      let payload: unknown;
      try { payload = JSON.parse(await boundedText(response)); }
      catch (error) { if (error instanceof LearningError) throw error; throw failure('PROTOCOL', 'model response is not JSON'); }
      const parsed = ChatResponse.safeParse(payload);
      if (!parsed.success) throw failure('PROTOCOL', 'model completion has no text choice');
      try { return JSON.parse(parsed.data.choices[0]!.message.content) as unknown; }
      catch { throw failure('PROTOCOL', 'model returned invalid proposal JSON'); }
    },
  };
}
