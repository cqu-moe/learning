import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LearningError } from '../../types/errors.js';
import type { ModelClient } from '../types.js';
import { isCancellation, reportError, safeEndpoint } from '../diagnostics.js';
import type { DiagnosticLog } from '../diagnostics.js';

const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.unknown().optional(),
});
const MAX_RESPONSE_BYTES = 1024 * 1024;

function isSafeModelLabel(value: string): boolean {
  return value.length <= 128 &&
    /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*$/.test(value) &&
    !value.includes(':/') &&
    !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:$|\/)/.test(value);
}

export const ModelLabelSchema = z.string().refine(isSafeModelLabel);

const NonnegativeSafeInteger = z.number().refine(value => Number.isSafeInteger(value) && value >= 0);

function tokenFrom(value: unknown): number | undefined {
  return NonnegativeSafeInteger.safeParse(value).data;
}

function usageFrom(value: unknown): { promptTokens?: number; completionTokens?: number } {
  if (typeof value !== 'object' || value === null) return {};
  const promptTokens = tokenFrom(Reflect.get(value, 'prompt_tokens'));
  const completionTokens = tokenFrom(Reflect.get(value, 'completion_tokens'));
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
  };
}

function failure(code: 'INVALID_INPUT' | 'NETWORK' | 'PROTOCOL', message: string, options?: ErrorOptions): LearningError {
  return new LearningError({ code, message, retryAfterMs: null, operationId: null }, options);
}

function canceled(options?: ErrorOptions): LearningError {
  return new LearningError({ code: 'CANCELED', message: 'model request canceled', retryAfterMs: null, operationId: null }, options);
}

function responseBytesOf(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
}

async function boundedText(response: Response): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: '', bytes: 0 };
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
    return { text: text + decoder.decode(), bytes: total };
  } finally { reader.releaseLock(); }
}

/** Explicitly configured, Node-only Chat Completions compatible adapter. */
export function createCompatibleModelClient(config: {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  aiSessionId?: string;
  captureAiGeneration?: (properties: Record<string, unknown>) => void;
  log?: DiagnosticLog;
}): ModelClient {
  let base: URL;
  try { base = new URL(config.baseUrl); }
  catch (error) {
    const invalid = failure('INVALID_INPUT', 'model base URL is invalid', { cause: error });
    reportError(config.log, 'model.config', invalid, { code: invalid.data.code });
    throw invalid;
  }
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') throw failure('INVALID_INPUT', 'model base URL must be HTTPS without credentials, query or fragment');
  if (config.model.trim() === '' || config.apiKey.trim() === '') throw failure('INVALID_INPUT', 'model name and API key are required');
  const endpoint = new URL('chat/completions', `${base.toString().replace(/\/$/, '')}/`);
  const fetchFn = config.fetchFn ?? fetch;
  return {
    propose: async ({ purpose, content, signal }) => {
      const instruction = purpose === 'answers'
        ? 'Return only JSON with a suggestions array of questionId and option keys. Do not invent unavailable text. These are editable suggestions, not submissions.'
        : 'Return only JSON with one nonempty text field containing an editable discussion reply. Do not submit it.';
      const messages = [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(content) }];
      const startedAt = Date.now();
      const traceId = randomUUID();
      const telemetryModel = ModelLabelSchema.safeParse(config.model).success ? config.model : 'custom';
      const capture = (outcome: {
        httpStatus?: number;
        isError: boolean;
        error?: 'network_error' | 'http_error' | 'response_too_large' | 'response_read_error' | 'invalid_json_response' | 'invalid_response_structure' | 'invalid_proposal_json' | 'canceled';
        usage?: { promptTokens?: number; completionTokens?: number };
      }) => {
        try {
          config.captureAiGeneration?.({
            $ai_trace_id: traceId,
            $ai_session_id: config.aiSessionId ?? null,
            $ai_span_id: randomUUID(),
            $ai_span_name: `model_${purpose}_proposal`,
            $ai_model: telemetryModel,
            $ai_provider: 'openai-compatible',
            $ai_latency: Math.max(0, Date.now() - startedAt) / 1000,
            $ai_stream: false,
            $ai_is_error: outcome.isError,
            ...(outcome.httpStatus === undefined ? {} : { $ai_http_status: outcome.httpStatus }),
            ...(outcome.error === undefined ? {} : { $ai_error: outcome.error }),
            ...(outcome.usage?.promptTokens === undefined ? {} : {
              $ai_input_tokens: outcome.usage.promptTokens,
            }),
            ...(outcome.usage?.completionTokens === undefined ? {} : {
              $ai_output_tokens: outcome.usage.completionTokens,
            }),
          });
        } catch { return; }
      };
      const request = new Request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages, stream: false }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: 'omit', redirect: 'error' });
      const report = (stage: string, error: unknown, fields: Record<string, string | number | boolean | null> = {}) => {
        reportError(config.log, stage, error, {
          method: 'POST',
          endpoint: safeEndpoint(endpoint.toString()),
          ...fields,
        });
      };
      let response: Response;
      try { response = await fetchFn(request); }
      catch (error) {
        const callerCanceled = signal.aborted && isCancellation(error, signal);
        capture({ isError: true, error: callerCanceled ? 'canceled' : 'network_error' });
        if (callerCanceled) throw canceled({ cause: error });
        report(`model.request.${purpose}`, error, { code: 'NETWORK' });
        throw failure('NETWORK', 'model request failed', { cause: error });
      }
      if (!response.ok) {
        capture({ httpStatus: response.status, isError: true, error: 'http_error' });
        const error = failure('PROTOCOL', `model returned HTTP ${response.status}`);
        report(`model.response.${purpose}`, error, {
          status: response.status,
          code: error.data.code,
          content_type: response.headers.get('content-type'),
          response_bytes: responseBytesOf(response),
        });
        throw error;
      }
      let payload: unknown;
      let text: string;
      let responseBytes: number;
      try { ({ text, bytes: responseBytes } = await boundedText(response)); }
      catch (error) {
        const callerCanceled = signal.aborted && isCancellation(error, signal);
        capture({ httpStatus: response.status, isError: true, error: callerCanceled ? 'canceled' : error instanceof LearningError ? 'response_too_large' : 'response_read_error' });
        if (callerCanceled) throw canceled({ cause: error });
        {
          report(`model.response.${error instanceof LearningError ? 'size' : 'read'}.${purpose}`, error, {
            status: response.status,
            code: error instanceof LearningError ? error.data.code : 'PROTOCOL',
            content_type: response.headers.get('content-type'),
          });
        }
        if (error instanceof LearningError) throw error;
        throw failure('PROTOCOL', 'model response is not JSON', { cause: error });
      }
      try { payload = JSON.parse(text); }
      catch (error) {
        capture({ httpStatus: response.status, isError: true, error: 'invalid_json_response' });
        report(`model.response.json.${purpose}`, error, {
          status: response.status,
          code: 'PROTOCOL',
          content_type: response.headers.get('content-type'),
          response_bytes: responseBytes,
        });
        throw failure('PROTOCOL', 'model response is not JSON', { cause: error });
      }
      const parsed = ChatResponse.safeParse(payload);
      if (!parsed.success) {
        capture({ httpStatus: response.status, isError: true, error: 'invalid_response_structure' });
        const error = failure('PROTOCOL', 'model completion has no text choice', { cause: parsed.error });
        report(`model.response.schema.${purpose}`, error, {
          status: response.status,
          code: 'PROTOCOL',
          content_type: response.headers.get('content-type'),
          response_bytes: responseBytes,
        });
        throw error;
      }
      const output = parsed.data.choices[0]!.message.content;
      const usage = usageFrom(parsed.data.usage);
      let proposal: unknown;
      try { proposal = JSON.parse(output); }
      catch (error) {
        capture({ httpStatus: response.status, isError: true, error: 'invalid_proposal_json', usage });
        report(`model.proposal.json.${purpose}`, error, {
          status: response.status,
          code: 'PROTOCOL',
          content_type: response.headers.get('content-type'),
          response_bytes: responseBytes,
        });
        throw failure('PROTOCOL', 'model returned invalid proposal JSON', { cause: error });
      }
      capture({ httpStatus: response.status, isError: false, usage });
      return proposal;
    },
  };
}
