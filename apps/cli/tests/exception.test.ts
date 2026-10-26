import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LearningError, type Json } from '@learning/sdk/public';
import { buildException } from '../src/exception.js';

type ExceptionFrame = {
  platform: 'custom';
  lang: 'javascript';
  function: string;
  filename: string;
  lineno: number | null;
  colno: number | null;
  in_app: boolean;
};
type ExceptionEntry = {
  type: string;
  value: string;
  mechanism: { handled: boolean; synthetic: false };
  stacktrace?: { type: 'raw'; frames: ExceptionFrame[] };
};
type ExceptionList = ExceptionEntry[];

function stackError(message: string, stack: string): Error {
  const error = new Error(message);
  error.stack = stack;
  return error;
}

function realStackError(message: string): Error {
  const make = () => new Error(message);
  return make();
}

function firstException(properties: Record<string, Json>): ExceptionEntry {
  const list = properties.$exception_list;
  if (!Array.isArray(list) || list.length === 0 || typeof list[0] !== 'object') throw new Error('missing exception list');
  return list[0] as ExceptionEntry;
}

describe('buildException', () => {
  it('redacts credentials in unquoted colon-delimited diagnostic text', () => {
    const encoded = JSON.stringify(buildException(new Error('password: SECRET_PASSWORD token: SECRET_TOKEN api-key: SECRET_KEY')));
    expect(encoded).not.toMatch(/SECRET_PASSWORD|SECRET_TOKEN|SECRET_KEY/);
  });

  it('redacts ticket-like URL path values as well as query parameters', () => {
    const properties = buildException(new Error('request failed'), { context: { endpoint: 'https://user.zhihuishu.com/zhsuser/user/cache/SECRET_CACHE_ID?token=SECRET_QUERY' } });
    expect(properties.context).toMatchObject({ endpoint: 'https://user.zhihuishu.com/zhsuser/user/cache/:id' });
    expect(JSON.stringify(properties)).not.toContain('SECRET_');
  });

  it('emits PostHog raw exceptions from a real V8 stack', () => {
    const properties = buildException(realStackError('network request failed'), { handled: true });
    const exception = firstException(properties);
    expect(properties).toBeInstanceOf(Object);
    expect(exception).toMatchObject({
      type: 'Error',
      value: 'network request failed',
      mechanism: { handled: true, synthetic: false },
    });
    expect(exception.stacktrace).toMatchObject({ type: 'raw' });
    expect(exception.stacktrace?.frames.length).toBeGreaterThan(0);
    expect(exception.stacktrace?.frames.at(-1)).toMatchObject({
      platform: 'custom',
      lang: 'javascript',
      function: 'make',
      filename: 'apps/cli/tests/exception.test.ts',
      in_app: true,
    });
    expect(exception.stacktrace?.frames.at(-1)?.lineno as number).toBeGreaterThan(0);
    expect(exception.stacktrace?.frames.at(-1)?.colno as number).toBeGreaterThan(0);
  });

  it('redacts credentials, emails, URLs, and machine paths while retaining useful diagnostics', () => {
    const properties = buildException(
      stackError(
        'request failed Cookie: sid=SECRET_COOKIE Authorization: Bearer SECRET_BEARER token=SECRET_TOKEN password=SECRET_PASSWORD api_key=SECRET_API_KEY email=student@example.com https://user:secret@example.test/path?next=/private#fragment /Users/uu/Developer/cqu-moe/learning/apps/cli/src/example.ts /Users/uu/private.txt /var/folders/T/learning/answer.json C:\\Users\\secret\\AppData\\Local\\Temp\\response.json //server/private/share',
        'Error: request failed\n    at request (/Users/uu/Developer/cqu-moe/learning/apps/cli/src/example.ts:10:20)\n    at node (node:internal/process:1:1)',
      ),
      {
        context: {
          stage: 'submit',
          endpoint: 'https://example.test/path?token=SECRET_TOKEN',
          response_bytes: 123,
          body: 'SECRET_RAW_BODY',
        },
        secrets: ['SECRET_COOKIE', 'SECRET_BEARER', 'SECRET_TOKEN', 'SECRET_PASSWORD', 'SECRET_API_KEY'],
      },
    );
    const encoded = JSON.stringify(properties);
    expect(encoded).not.toContain('SECRET_COOKIE');
    expect(encoded).not.toContain('SECRET_BEARER');
    expect(encoded).not.toContain('SECRET_TOKEN');
    expect(encoded).not.toContain('SECRET_PASSWORD');
    expect(encoded).not.toContain('SECRET_API_KEY');
    expect(encoded).not.toContain('student@example.com');
    expect(encoded).not.toContain('user:secret');
    expect(encoded).not.toContain('next=/private');
    expect(encoded).not.toContain('#fragment');
    expect(encoded).not.toContain('/Users/uu/');
    expect(encoded).not.toContain('/var/folders/');
    expect(encoded).not.toContain('C:\\Users\\');
    expect(encoded).toContain('request failed');
    expect(encoded).toContain('https://example.test/path');
    expect(encoded).toContain('apps/cli/src/example.ts');
    expect(encoded).toContain('~/private.txt');
    expect(encoded).toContain('answer.json');
    expect(encoded).toContain('response.json');
    expect(encoded).not.toContain('//server/private');
    const context = properties.context as Record<string, Json>;
    expect(context).toMatchObject({ stage: 'submit', endpoint: 'https://example.test/path', response_bytes: 123 });
    expect(Object.keys(context)).toEqual(['stage', 'endpoint', 'response_bytes', 'context_filtered_count']);
    expect(firstException(properties).stacktrace?.frames).toMatchObject([
      { function: 'node', filename: 'node:internal/process', lineno: 1, colno: 1, in_app: false },
      { function: 'request', filename: 'apps/cli/src/example.ts', lineno: 10, colno: 20, in_app: true },
    ]);
  });

  it('parses only real Bun, Windows, file URI, and native V8 frames in oldest-to-newest order', () => {
    const stacks = [
      'Error: failed\n    at inner (/repo/apps/cli/src/inner.ts:5:6)\n    at outer (/repo/apps/cli/src/outer.ts:12:13)',
      'Error: failed\n    at inner (file:///Users/uu/Developer/cqu-moe/learning/apps/cli/src/inner.ts:5:6)\n    at outer (file:///Users/uu/Developer/cqu-moe/learning/apps/cli/src/outer.ts:12:13)',
      'Error: failed\n    at inner (C:\\Users\\secret\\Developer\\learning\\apps\\cli\\src\\inner.ts:5:6)\n    at outer (C:\\Users\\secret\\Developer\\learning\\apps\\cli\\src\\outer.ts:12:13)',
      'Error: failed\n    at inner (node:internal/modules/run_main:5:6)\n    at outer (node:internal/process/task_queues:12:13)\nnot a stack frame',
    ];
    for (const stack of stacks) {
      const frames = firstException(buildException(stackError('failed', stack))).stacktrace?.frames ?? [];
      expect(frames.map(frame => frame.function)).toEqual(['outer', 'inner']);
      expect(frames.at(-1)).toMatchObject({ lineno: 5, colno: 6 });
      expect(frames.every(frame => frame.platform === 'custom' && frame.lang === 'javascript')).toBe(true);
    }
    const projectFilenames = firstException(buildException(stackError('failed', stacks[0]!))).stacktrace?.frames.map(frame => frame.filename);
    expect(projectFilenames).toEqual(['apps/cli/src/outer.ts', 'apps/cli/src/inner.ts']);
    const native = firstException(buildException(stackError('failed', stacks[3]!))).stacktrace?.frames ?? [];
    expect(native.map(frame => frame.filename)).toEqual(['node:internal/process/task_queues', 'node:internal/modules/run_main']);
    const withoutPosition = firstException(buildException(stackError('failed', 'Error: failed\n    at native (node:internal/native_frame)'))).stacktrace?.frames ?? [];
    expect(withoutPosition).toEqual([{
      platform: 'custom', lang: 'javascript', function: 'native', filename: 'node:internal/native_frame',
      lineno: null, colno: null, in_app: false,
    }]);
  });

  it('preserves cause and AggregateError branches without inventing frames', () => {
    const leaf = realStackError('leaf failed');
    const aggregate = new AggregateError([new Error('branch one'), new Error('branch two')], 'aggregate failed', { cause: leaf });
    const error = new Error('outer failed', { cause: aggregate });
    const properties = buildException(error);
    const list = properties.$exception_list as ExceptionList;
    expect(list.map(exception => exception.type)).toEqual(['Error', 'AggregateError', 'Error', 'Error', 'Error']);
    expect(list.map(exception => exception.value)).toEqual([
      'outer failed', 'aggregate failed', 'branch one', 'branch two', 'leaf failed',
    ]);
    expect(list.every(exception => exception.stacktrace === undefined || exception.stacktrace.frames.every(frame => frame.function !== ''))).toBe(true);
  });

  it('keeps validation structure but not Zod issue inputs', () => {
    const parsed = z.object({ answer: z.number(), password: z.string().uuid() }).safeParse({
      answer: 'SECRET_QUESTION_TEXT',
      password: 'SECRET_MODEL_KEY',
    });
    expect(parsed.success).toBe(false);
    const properties = buildException(parsed.error, { secrets: ['SECRET_MODEL_KEY'] });
    const diagnostics = properties.$exception_diagnostics as Record<string, Json>;
    const validation = diagnostics.validation as Record<string, Json>;
    expect(firstException(properties).type).toBe('ZodError');
    expect(validation).toMatchObject({
      issue_count: 2,
      field_paths: ['answer', 'password'],
      issue_codes: ['invalid_type', 'invalid_format'],
    });
    expect(JSON.stringify(properties)).not.toContain('SECRET_QUESTION_TEXT');
    expect(JSON.stringify(properties)).not.toContain('SECRET_MODEL_KEY');
  });

  it('keeps SyntaxError shape and location without trusting its raw text', () => {
    const syntax = new SyntaxError("Unexpected token 'SECRET_RESPONSE' in JSON at position 12 (line 1 column 13)");
    syntax.stack = 'SyntaxError: Unexpected token while parsing response SECRET_RESPONSE\n    at parse (node:internal/deps/acorn:12:34)';
    const properties = buildException(syntax);
    const diagnostics = properties.$exception_diagnostics as Record<string, Json>;
    expect(firstException(properties).type).toBe('SyntaxError');
    expect(diagnostics.error_name).toBe('SyntaxError');
    expect(diagnostics.syntax).toEqual({ category: 'unexpected_token', line: 1, column: 13, position: 12 });
    expect(JSON.stringify(properties)).not.toContain('SECRET_RESPONSE');
    expect(firstException(properties).stacktrace?.frames[0]).toMatchObject({ filename: 'node:internal/deps/acorn', in_app: false });
  });

  it('classifies parse errors before display-name secret redaction', () => {
    const syntax = new SyntaxError("Unexpected token 'SECRET_JSON_DRAFT' in JSON at position 12 (line 1 column 13)");
    const syntaxProperties = buildException(syntax, { secrets: ['SyntaxError'] });
    expect(JSON.stringify(syntaxProperties)).not.toContain('SECRET_JSON_DRAFT');
    expect(firstException(syntaxProperties).value).toBe('syntax error: unexpected_token');
    expect(syntaxProperties.$exception_diagnostics).toMatchObject({
      syntax: { category: 'unexpected_token', line: 1, column: 13, position: 12 },
    });

    const yaml = Object.assign(new Error('Bad YAML: SECRET_DRAFT'), {
      name: 'YAMLParseError',
      code: 'UNEXPECTED_TOKEN',
      linePos: [{ line: 3, col: 7 }],
    });
    const yamlProperties = buildException(yaml);
    expect(JSON.stringify(yamlProperties)).not.toContain('SECRET_DRAFT');
    expect(firstException(yamlProperties).value).toBe('parse error');
    expect(yamlProperties.$exception_diagnostics).toMatchObject({
      parse: { code: 'UNEXPECTED_TOKEN', line: 3, column: 7 },
    });
  });

  it('marks missing stacks instead of manufacturing frames', () => {
    const properties = buildException(Object.create(Error.prototype));
    const exception = firstException(properties);
    expect(exception.stacktrace).toBeUndefined();
    expect(properties).toMatchObject({
      $exception_diagnostics: { stack_available: false, stack_note: 'Error.stack missing' },
    });
  });

  it('keeps a raw empty stacktrace and marks unparsable stacks', () => {
    const properties = buildException(stackError('failed', 'Error: failed\nnot a stack frame'));
    expect(firstException(properties).stacktrace).toEqual({ type: 'raw', frames: [] });
    expect(properties.$exception_diagnostics).toMatchObject({ stack_available: true, stack_note: 'No parsable stack frames' });
  });

  it('separates same-type internal failures by their innermost app frame', () => {
    const first = buildException(stackError('message one', 'Error: message one\n    at inner (/repo/apps/cli/src/a.ts:10:20)'));
    const second = buildException(stackError('message two', 'Error: message two\n    at inner (/repo/apps/cli/src/b.ts:30:40)'));
    const sameFrameDifferentMessage = buildException(stackError('message three', 'Error: message three\n    at inner (/repo/apps/cli/src/a.ts:10:20)'));
    expect(first.$exception_fingerprint).not.toBe(second.$exception_fingerprint);
    expect(first.$exception_fingerprint).toBe(sameFrameDifferentMessage.$exception_fingerprint);
    expect(JSON.stringify([first.$exception_fingerprint, second.$exception_fingerprint])).not.toContain('message one');
  });

  it('groups LearningErrors by chain sites and safe code rather than a shared factory', () => {
    const sharedFailure = (message: string, code: 'NETWORK' | 'PROTOCOL', cause?: Error) =>
      new LearningError({ code, message, retryAfterMs: null, operationId: null }, { cause });
    const callerA = (message = 'request failed') => sharedFailure(message, 'NETWORK', new TypeError('socket A'));
    const callerB = () => sharedFailure('request failed', 'NETWORK', new TypeError('socket B'));
    const captureA = (message = 'request failed', code: 'NETWORK' | 'PROTOCOL' = 'NETWORK') => {
      const error = callerA(message);
      return buildException(error, { context: { code } });
    };
    const captureB = () => buildException(callerB(), { context: { code: 'NETWORK' } });
    const second = captureB();
    const captures = ([
      { message: 'request failed', code: 'NETWORK' },
      { message: 'another message', code: 'NETWORK' },
      { message: 'request failed', code: 'PROTOCOL' },
    ] as const).map(variant => captureA(variant.message, variant.code));
    const first = captures[0]!;
    const sameSiteNewMessage = captures[1]!;
    const sameSiteNewCode = captures[2]!;
    expect(first.$exception_fingerprint).not.toBe(second.$exception_fingerprint);
    expect(first.$exception_fingerprint).toBe(sameSiteNewMessage.$exception_fingerprint);
    expect(first.$exception_fingerprint).not.toBe(sameSiteNewCode.$exception_fingerprint);
  });

  it('limits frames, chain width, and serialized exception properties to 24 KiB', () => {
    const frames = Array.from({ length: 100 }, (_, index) => `    at frame${index} (/repo/apps/cli/src/file-${index}.ts:${index + 1}:${index + 2})`).join('\n');
    let cause: Error | undefined;
    for (let index = 0; index < 20; index += 1) cause = new Error(`cause ${index} ${'x'.repeat(2048)}`, { cause });
    const properties = buildException(stackError(`large ${'x'.repeat(64 * 1024)}`, `Error: large\n${frames}`), {
      context: { stage: 'large', response_bytes: Number.MAX_SAFE_INTEGER },
    });
    const diagnostics = properties.$exception_diagnostics as Record<string, Json>;
    expect(Buffer.byteLength(JSON.stringify(properties))).toBeLessThanOrEqual(24 * 1024);
    expect(firstException(properties).stacktrace?.frames.length).toBeLessThan(100);
    expect((properties.$exception_list as ExceptionList).length).toBeLessThan(21);
    expect(diagnostics.truncated).toBe(true);
  });

  it('marks stacks truncated only when real frames exceed the retained limit', () => {
    const frames = Array.from({ length: 51 }, (_, index) => `    at frame${index} (/repo/apps/cli/src/file-${index}.ts:${index + 1}:${index + 2})`).join('\n');
    const properties = buildException(stackError('failed', `Error: failed\n${frames}`));
    expect(firstException(properties).stacktrace?.frames).toHaveLength(50);
    expect(properties.$exception_diagnostics).toMatchObject({ stack_truncated: true, truncated: true });
  });

  it('keeps bounded validation and syntax summaries for wrapped causes', () => {
    const fields: Record<string, z.ZodNumber> = {};
    for (let index = 0; index < 32; index += 1) fields[`field_${index}`] = z.number();
    const validation = z.object(fields).safeParse({});
    expect(validation.success).toBe(false);
    const syntax = new SyntaxError('Unexpected token in JSON at position 12 (line 1 column 13)');
    const wrapped = new AggregateError([
      new Error('validation wrapper', { cause: validation.error }),
      new Error('syntax wrapper', { cause: syntax }),
    ], 'wrapped failures');
    const properties = buildException(wrapped);
    const diagnostics = properties.$exception_diagnostics as Record<string, Json>;
    const summaries = diagnostics.exceptions as Json[];
    expect(summaries).toMatchObject([
      { index: 2, type: 'ZodError', validation: { issue_count: 32 } },
      { index: 4, type: 'SyntaxError', syntax: { category: 'unexpected_token', position: 12 } },
    ]);
  });

  it('enforces the absolute size limit for adversarial validation paths', () => {
    const fields: Record<string, z.ZodNumber> = {};
    for (let index = 0; index < 32; index += 1) fields[`${'path'.repeat(1500)}_${index}`] = z.number();
    const parsed = z.object(fields).safeParse({});
    expect(parsed.success).toBe(false);
    const properties = buildException(parsed.error);
    expect(Buffer.byteLength(JSON.stringify(properties))).toBeLessThanOrEqual(24 * 1024);
    expect(properties.$exception_diagnostics).toMatchObject({ truncated: true });
  });

  it('redacts a known secret before truncating the message boundary', () => {
    const properties = buildException(new Error(`${'a'.repeat(4090)}SECRET_MODEL_KEY`), { secrets: ['SECRET_MODEL_KEY'] });
    expect(JSON.stringify(properties)).not.toContain('SECRET_MODEL_KEY');
  });

  it('limits nested AggregateError branches to a shared depth budget', () => {
    let aggregate: AggregateError = new AggregateError([new Error('leaf')], 'depth 0');
    for (let index = 1; index < 20; index += 1) aggregate = new AggregateError([aggregate], `depth ${index}`);
    const properties = buildException(aggregate);
    const list = properties.$exception_list as ExceptionList;
    expect(list.length).toBeLessThan(20);
    expect(properties.$exception_diagnostics).toMatchObject({ aggregate_width_truncated: true });
  });

  it('keeps only bounded Node system error facts', () => {
    const error = Object.assign(new Error('write failed'), { errno: -13, syscall: 'write', code: 'SECRET_CODE' });
    const diagnostics = buildException(error).$exception_diagnostics as Record<string, Json>;
    expect(diagnostics.system_error).toEqual({ errno: -13, syscall: 'write' });
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_CODE');
  });

  it('never throws for hostile inputs and invalid context values', () => {
    const cyclic = new Error('cyclic');
    (cyclic as { cause?: unknown }).cause = cyclic;
    const throwingMessage = Object.create(Error.prototype) as Error;
    Object.defineProperty(throwingMessage, 'message', {
      get() { throw new Error('message getter failed'); },
      enumerable: true,
    });
    const context = new Proxy({ stage: 'ok' }, {
      ownKeys() { throw new Error('context keys failed'); },
      get() { throw new Error('context value failed'); },
    }) as Record<string, string | number | boolean | null>;
    for (const error of [undefined, null, 'plain failure', 42, cyclic, throwingMessage]) {
      expect(() => buildException(error, { context })).not.toThrow();
      expect(firstException(buildException(error, { context }))).toBeInstanceOf(Object);
    }
  });

  it('does not copy arbitrary custom Error properties', () => {
    const error = Object.assign(realStackError('custom failure'), {
      code: 'SECRET_CUSTOM_CODE',
      answer: 'SECRET_ANSWER',
      prompt: 'SECRET_PROMPT',
      errno: -13,
    });
    const encoded = JSON.stringify(buildException(error));
    expect(encoded).not.toContain('SECRET_CUSTOM_CODE');
    expect(encoded).not.toContain('SECRET_ANSWER');
    expect(encoded).not.toContain('SECRET_PROMPT');
  });
});
