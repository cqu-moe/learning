import { createHash } from 'node:crypto';
import type { Json } from '@learning/sdk/public';

type ContextValue = string | number | boolean | null;
type RawFrame = {
  platform: 'custom';
  lang: 'javascript';
  function: string;
  filename: string;
  lineno: number | null;
  colno: number | null;
  in_app: boolean;
};
type ExceptionItem = {
  type: string;
  value: string;
  mechanism: { handled: boolean; synthetic: false };
  stacktrace?: { type: 'raw'; frames: RawFrame[] };
};

interface BuildExceptionOptions {
  handled?: boolean;
  context?: Record<string, ContextValue>;
  secrets?: readonly string[];
}

const MAX_EXCEPTION_PROPERTIES_BYTES = 24 * 1024;
const MAX_EXCEPTIONS = 16;
const MAX_CHAIN_DEPTH = 8;
const MAX_AGGREGATE_ERRORS = 8;
const MAX_FRAMES = 50;
const MAX_MESSAGE_CHARS = 4096;
const MAX_FRAME_TEXT_CHARS = 512;
const MAX_VALIDATION_FIELDS = 16;
const MAX_VALIDATION_PATH_CHARS = 128;
const MAX_VALIDATION_CODE_CHARS = 64;
const MAX_CHAIN_SUMMARIES = 4;
const CONTEXT_KEYS = [
  'stage', 'method', 'status', 'endpoint', 'job_id', 'attempt_id', 'platform',
  'recovered', 'code', 'response_bytes', 'content_type', 'response_shape',
  'response_keys', 'result_type', 'warning_codes', 'resource_key_hash',
] as const;
const STACK_FRAME_WITH_POSITION = /^\s*at\s+(?:async\s+)?(?:([\w$.<>[\]-]+)\s+\()?(.+?):(\d+):(\d+)\)?$/;
const STACK_FRAME = /^\s*at\s+(?:async\s+)?(?:([\w$.<>[\]-]+)\s+\()?(.+?)\)?$/;

function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

function redactUrls(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, match => {
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      const parts = url.pathname.split('/');
      url.pathname = parts.map((part, index) => /^(?:cache|isNewUser|token|ticket|session|password|secret|authorization|access[_-]?token)$/i.test(parts[index - 1] ?? '') || /^(?:\d+|[A-Za-z0-9_-]{24,})$/.test(part) ? ':id' : part).join('/');
      return url.toString();
    } catch {
      return '[redacted-url]';
    }
  });
}

function sanitizeText(value: string, secrets: readonly string[], limit = MAX_MESSAGE_CHARS): string {
  let text = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      const replacement = secret.length >= 8 ? '[secret]' : '*'.repeat(secret.length);
      text = text.split(secret).join(replacement);
    }
  }
  text = text
    .replace(/\b(cookie\s*[:=]\s*)[^\r\n]*?(?=\s+authorization\s*[:=]|[\r\n]|$)/gi, '$1[redacted]')
    .replace(/\b(authorization\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,\r\n}\]]+)/gi, '$1[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/(["'])(cookie|authorization|token|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\1\s*:\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,}\]]+)/gi, '$1$2$1:[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;}\]]+)/gi, '$1[redacted]');
  text = redactUrls(text)
    // Consume non-email runs too, so a long mismatch is scanned only once.
    .replace(/[A-Z0-9._%+-]+(@[A-Z0-9.-]+\.[A-Z]{2,})?/gi, (match, domain: string | undefined) => domain === undefined ? match : '[email]')
    .replace(/(?<![A-Za-z0-9:/])(?:file:\/\/)?(?:[A-Za-z]:)?[\\/]+[^\s"'<>]+/gi, match => normalizeLocation(match));
  return truncate(text, limit);
}

function normalizeLocation(location: string): string {
  let value = location.replace(/\\/g, '/');
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch {
      return '[redacted-file-uri]';
    }
  }
  if (value.startsWith('node:') || value === 'native' || value.startsWith('internal/')) return truncate(value, MAX_FRAME_TEXT_CHARS);
  if (value.startsWith('http://') || value.startsWith('https://')) return redactUrls(value);

  const project = value.match(/(?:^|\/)(apps\/cli\/.+|packages\/sdk\/.+)$/i);
  if (project !== null) return project[1]!.replace(/[?#].*$/, '');
  const home = value.match(/^(?:[A-Za-z]:)?[\\/]+(?:Users|home)[\\/]+[^\\/]+/i);
  if (home !== null) return truncate(value.replace(home[0]!, '~'), MAX_FRAME_TEXT_CHARS);
  const basename = value.match(/[\\/]([^\\/?#]+)(?:[?#].*)?$/);
  return truncate(basename?.[1] ?? '[path]', MAX_FRAME_TEXT_CHARS);
}

function parseStack(stack: string, secrets: readonly string[]): { frames: RawFrame[]; truncated: boolean } {
  const frames: RawFrame[] = [];
  const lines = stack.split('\n');
  let frameCount = 0;
  for (const line of lines) {
    const match = STACK_FRAME_WITH_POSITION.exec(line) ?? STACK_FRAME.exec(line);
    if (match === null) continue;
    frameCount += 1;
    if (frames.length === MAX_FRAMES) continue;
    const filename = sanitizeText(normalizeLocation(match[2]!), secrets);
    frames.push({
      platform: 'custom',
      lang: 'javascript',
      function: sanitizeText(match[1] ?? '<anonymous>', secrets, MAX_FRAME_TEXT_CHARS),
      filename,
      lineno: match[3] === undefined ? null : Number(match[3]),
      colno: match[4] === undefined ? null : Number(match[4]),
      in_app: filename.startsWith('apps/cli/') || filename.startsWith('packages/sdk/'),
    });
  }
  // PostHog's raw frame convention is most recent call last; V8 emits newest first.
  return { frames: frames.reverse(), truncated: frameCount > MAX_FRAMES };
}

function rawErrorName(error: unknown): string {
  const candidate = safeRead(() => {
    const value = (error as { name?: unknown })?.name;
    return typeof value === 'string' ? value : (error as { constructor?: { name?: unknown } })?.constructor?.name;
  }, '');
  return typeof candidate === 'string' && /^[A-Za-z_$][A-Za-z0-9_$.]{0,127}$/.test(candidate) ? candidate : 'Unknown';
}

function safeErrorName(error: unknown, secrets: readonly string[]): string {
  return sanitizeText(rawErrorName(error), secrets);
}

function errorValue(error: unknown, name: string, secrets: readonly string[]): string {
  if (name === 'SyntaxError') return `syntax error: ${syntaxSummary(error).category}`;
  if (name === 'ZodError') return 'validation failed';
  if (name === 'YAMLParseError' || name === 'YAMLException') return 'parse error';
  if (typeof error === 'string') return sanitizeText(error, secrets);
  if (typeof error === 'number' || typeof error === 'boolean' || error === null) return String(error);
  const message = safeRead(() => (error as { message?: unknown })?.message, '');
  if (typeof message !== 'string' || message.length === 0) return '';
  return sanitizeText(message, secrets);
}

function yamlSummary(error: unknown): Json {
  const code = safeRead(() => (error as { code?: unknown }).code, undefined);
  const linePosition = safeRead(() => (error as { linePos?: unknown }).linePos, undefined);
  const position = Array.isArray(linePosition) && typeof linePosition[0] === 'object' && linePosition[0] !== null
    ? linePosition[0] as { line?: unknown; col?: unknown }
    : undefined;
  const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
  const line = typeof position?.line === 'number' && Number.isInteger(position.line) && position.line >= 0 ? position.line : undefined;
  const column = typeof position?.col === 'number' && Number.isInteger(position.col) && position.col >= 0 ? position.col : undefined;
  if (safeCode === undefined && line === undefined && column === undefined) return { code: 'UNKNOWN' };
  return {
    ...(safeCode !== undefined ? { code: safeCode } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

function syntaxSummary(error: unknown): { category: string; line: number | null; column: number | null; position: number | null } {
  const message = safeRead(() => (error as { message?: unknown })?.message, '');
  const text = typeof message === 'string' ? message.toLowerCase() : '';
  const position = text.match(/(?:position|offset)\s+(\d+)/);
  const lineColumn = text.match(/line\s+(\d+)(?:,)?\s+column\s+(\d+)/);
  const category = text.includes('unexpected end')
    ? 'unexpected_end'
    : text.includes('unexpected token') || text.includes('unexpected identifier')
      ? 'unexpected_token'
      : text.includes('invalid escape') ? 'invalid_escape'
        : text.includes('unterminated') ? 'unterminated'
          : text.includes('json') ? 'invalid_json'
            : 'syntax_error';
  return {
    category,
    line: lineColumn === null ? null : Number(lineColumn[1]),
    column: lineColumn === null ? null : Number(lineColumn[2]),
    position: position === null ? null : Number(position[1]),
  };
}

function validationSummary(error: unknown, secrets: readonly string[]): Json | undefined {
  const issues = safeRead(() => (error as { issues?: unknown })?.issues, undefined);
  if (!Array.isArray(issues)) return undefined;
  const fieldPaths: string[] = [];
  const issueCodes: string[] = [];
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const path = (issue as { path?: unknown }).path;
    if (Array.isArray(path)) {
      const field = truncate(path.slice(0, 8).map(part => typeof part === 'number' || typeof part === 'symbol'
        ? String(part)
        : sanitizeText(String(part), secrets, MAX_VALIDATION_PATH_CHARS / 8)).join('.'), MAX_VALIDATION_PATH_CHARS);
      if (field.length > 0) fieldPaths.push(field);
    }
    const code = safeRead(() => String((issue as { code?: unknown }).code ?? ''), '');
    if (code.length > 0) issueCodes.push(sanitizeText(code, secrets, MAX_VALIDATION_CODE_CHARS));
  }
  return {
    issue_count: issues.length,
    field_paths: fieldPaths.slice(0, MAX_VALIDATION_FIELDS),
    issue_codes: issueCodes.slice(0, MAX_VALIDATION_FIELDS),
    truncated: fieldPaths.length > MAX_VALIDATION_FIELDS || issueCodes.length > MAX_VALIDATION_FIELDS,
  };
}

function systemSummary(error: unknown): Json | undefined {
  const errno = safeRead(() => (error as { errno?: unknown }).errno, undefined);
  const syscall = safeRead(() => (error as { syscall?: unknown }).syscall, undefined);
  const safeErrno = typeof errno === 'number' && Number.isInteger(errno) && errno >= -4095 && errno <= 4095 ? errno : undefined;
  const safeSyscall = typeof syscall === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(syscall) ? syscall : undefined;
  if (safeErrno === undefined && safeSyscall === undefined) return undefined;
  return {
    ...(safeErrno !== undefined ? { errno: safeErrno } : {}),
    ...(safeSyscall !== undefined ? { syscall: safeSyscall } : {}),
  };
}

function safeContext(context: BuildExceptionOptions['context'], secrets: readonly string[]): Record<string, Json> | undefined {
  let filtered: number;
  const result: Record<string, Json> = {};
  for (const key of CONTEXT_KEYS) {
    const raw = safeRead(() => context?.[key], undefined);
    if (raw === undefined) continue;
    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) result[key] = raw;
    } else if (typeof raw === 'boolean' || raw === null) {
      result[key] = raw;
    } else if (typeof raw === 'string') {
      result[key] = truncate(sanitizeText(raw, secrets), 512);
    }
  }
  try {
    filtered = context === undefined ? 0 : Math.max(0, Object.keys(context).length - Object.keys(result).length);
  } catch {
    filtered = CONTEXT_KEYS.length;
  }
  if (filtered > 0) result.context_filtered_count = filtered;
  return Object.keys(result).length > 0 ? result : undefined;
}

function exceptionFingerprint(exceptions: ExceptionItem[], contextCode: Json | undefined): string {
  const sites = exceptions.map(exception => [
    `type:${exception.type}`,
    ...(exception.stacktrace?.frames.filter(frame => frame.in_app).slice(-3).reverse() ?? []),
  ].map(part => typeof part === 'string' ? part : `${part.filename}:${part.lineno ?? 'line'}:${part.colno ?? 'column'}:${part.function}`).join('\n')).join('\n---\n');
  const code = typeof contextCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(contextCode) ? contextCode : '';
  const digest = createHash('sha256').update(`${sites}\n---\ncode:${code}`).digest('hex').slice(0, 24);
  return `learning:exception:${exceptions[0]?.type ?? 'Unknown'}:${digest}`;
}

function jsonBytes(value: Record<string, Json>): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return MAX_EXCEPTION_PROPERTIES_BYTES + 1;
  }
}

export function buildException(error: unknown, options: BuildExceptionOptions = {}): Record<string, Json> {
  try {
    const secrets = Array.isArray(options.secrets) ? options.secrets : [];
    const handled = options.handled ?? true;
    const exceptions: ExceptionItem[] = [];
    const seen = new WeakSet<object>();
    const diagnostics: Record<string, Json> = {};
    let causeTruncated = false;
    let aggregateTruncated = false;
    let messageTruncated = false;
    let frameTruncated = false;
    let exceptionChainTruncated = false;
    const chainSummaries: Json[] = [];

    const append = (candidate: unknown, depth: number): void => {
      if (exceptions.length === MAX_EXCEPTIONS) {
        exceptionChainTruncated = true;
        return;
      }
      if (typeof candidate === 'object' && candidate !== null) {
        if (seen.has(candidate)) return;
        seen.add(candidate);
      }
      const rawName = rawErrorName(candidate);
      const name = safeErrorName(candidate, secrets);
      const stack = safeRead(() => (candidate as { stack?: unknown })?.stack, undefined);
      const originalMessage = safeRead(() => (candidate as { message?: unknown })?.message, undefined);
      if (typeof originalMessage === 'string' && originalMessage.length > MAX_MESSAGE_CHARS) messageTruncated = true;
      const validation = validationSummary(candidate, secrets);
      const syntax = rawName === 'SyntaxError' ? syntaxSummary(candidate) : undefined;
      const parse = rawName === 'YAMLParseError' || rawName === 'YAMLException' ? yamlSummary(candidate) : undefined;
      const item: ExceptionItem = {
        type: name,
        value: errorValue(candidate, rawName, secrets),
        mechanism: { handled, synthetic: false },
      };
      if (typeof stack === 'string' && stack.length > 0) {
        const parsed = parseStack(stack, secrets);
        item.stacktrace = { type: 'raw', frames: parsed.frames };
        if (parsed.truncated) frameTruncated = true;
      }
      exceptions.push(item);
      if (validation !== undefined || syntax !== undefined || parse !== undefined) {
        chainSummaries.push({
          index: exceptions.length - 1,
          type: name,
          ...(validation !== undefined ? { validation } : {}),
          ...(syntax !== undefined ? { syntax } : {}),
          ...(parse !== undefined ? { parse } : {}),
        });
      }

      if (typeof candidate !== 'object' || candidate === null) return;
      const aggregateErrors = safeRead(() => (candidate as AggregateError).errors, undefined);
      if (Array.isArray(aggregateErrors)) {
        if (depth >= MAX_CHAIN_DEPTH) aggregateTruncated = true;
        else {
          for (const child of aggregateErrors.slice(0, MAX_AGGREGATE_ERRORS)) append(child, depth + 1);
          if (aggregateErrors.length > MAX_AGGREGATE_ERRORS) aggregateTruncated = true;
        }
      }
      const cause = safeRead(() => (candidate as { cause?: unknown }).cause, undefined);
      if (cause !== undefined && cause !== null) {
        if (depth < MAX_CHAIN_DEPTH) append(cause, depth + 1);
        else causeTruncated = true;
      }
    };

    append(error, 0);
    const first = exceptions[0];
    const stackAvailable = safeRead(() => typeof (error as { stack?: unknown })?.stack === 'string', false);
    diagnostics.stack_available = stackAvailable;
    if (!stackAvailable) diagnostics.stack_note = 'Error.stack missing';
    else if (first?.stacktrace?.frames.length === 0) diagnostics.stack_note = 'No parsable stack frames';
    if (causeTruncated) diagnostics.cause_chain_truncated = true;
    if (aggregateTruncated) diagnostics.aggregate_width_truncated = true;
    if (messageTruncated || frameTruncated) diagnostics.truncated = true;
    if (frameTruncated) diagnostics.stack_truncated = true;
    if (exceptionChainTruncated) diagnostics.exception_chain_truncated = true;
    if (chainSummaries.length > 0) diagnostics.exceptions = chainSummaries.slice(0, MAX_CHAIN_SUMMARIES);
    if (chainSummaries.length > MAX_CHAIN_SUMMARIES) diagnostics.chain_summaries_truncated = true;

    const rootValidation = validationSummary(error, secrets);
    if (rootValidation !== undefined) diagnostics.validation = rootValidation;
    const rawName = rawErrorName(error);
    if (rawName === 'SyntaxError') diagnostics.syntax = syntaxSummary(error);
    if (rawName === 'YAMLParseError' || rawName === 'YAMLException') diagnostics.parse = yamlSummary(error);
    const system = systemSummary(error);
    if (system !== undefined) diagnostics.system_error = system;
    if (rawName === 'SyntaxError') diagnostics.error_name = 'SyntaxError';

    const context = safeContext(options.context, secrets);
    let properties: Record<string, Json> = {
      $exception_list: exceptions,
      $exception_fingerprint: exceptionFingerprint(exceptions, context?.code),
      $exception_diagnostics: diagnostics,
    };
    if (context !== undefined) properties.context = context;

    if (jsonBytes(properties) > MAX_EXCEPTION_PROPERTIES_BYTES) {
      for (const exception of exceptions) exception.value = truncate(exception.value, 1024);
      diagnostics.truncated = true;
    }
    if (jsonBytes(properties) > MAX_EXCEPTION_PROPERTIES_BYTES) {
      for (const exception of exceptions) if (exception.stacktrace !== undefined) exception.stacktrace.frames = exception.stacktrace.frames.slice(-20);
      diagnostics.stack_truncated = true;
    }
    if (jsonBytes(properties) > MAX_EXCEPTION_PROPERTIES_BYTES && exceptions.length > 1) {
      properties.$exception_list = exceptions.slice(0, 8);
      diagnostics.exception_chain_truncated = true;
    }
    if (jsonBytes(properties) > MAX_EXCEPTION_PROPERTIES_BYTES) {
      for (const exception of exceptions) exception.value = truncate(exception.value, 256);
      diagnostics.truncated = true;
    }
    if (jsonBytes(properties) > MAX_EXCEPTION_PROPERTIES_BYTES) {
      const only = exceptions[0] ?? { type: 'Unknown', value: '', mechanism: { handled, synthetic: false } };
      properties = {
        $exception_list: [only],
        $exception_fingerprint: exceptionFingerprint([only], context?.code),
        $exception_diagnostics: { ...diagnostics, truncated: true },
      };
      only.value = truncate(only.value, 128);
      if (only.stacktrace !== undefined) only.stacktrace.frames = only.stacktrace.frames.slice(-8);
    }
    if (jsonBytes(properties) > MAX_EXCEPTION_PROPERTIES_BYTES) {
      const only = exceptions[0] ?? { type: 'Unknown', value: '', mechanism: { handled, synthetic: false } };
      only.value = '';
      if (only.stacktrace !== undefined) only.stacktrace.frames = only.stacktrace.frames.slice(-2);
      properties = {
        $exception_list: [only],
        $exception_fingerprint: exceptionFingerprint([only], context?.code),
        $exception_diagnostics: {
          stack_available: diagnostics.stack_available,
          ...(diagnostics.stack_note !== undefined ? { stack_note: diagnostics.stack_note } : {}),
          truncated: true,
          absolute_size_truncated: true,
        },
      };
    }
    return properties;
  } catch {
    return {
      $exception_list: [{
        type: 'Unknown',
        value: 'exception serialization failed',
        mechanism: { handled: options.handled ?? true, synthetic: false },
      }],
      $exception_diagnostics: { stack_available: false, stack_note: 'Exception diagnostics could not be read safely', truncated: true },
    };
  }
}
