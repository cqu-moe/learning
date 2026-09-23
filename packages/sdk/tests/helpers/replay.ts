import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from '../../src/types/errors.js';
import type { Clock, Transport } from '../../src/runtime/types.js';

const testsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));

export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: Json | string;
}

export interface FixtureInteraction {
  request: {
    method: string;
    host: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Json;
  };
  response: ScriptedResponse;
}

export interface Fixture {
  id: string;
  platform: 'ykt' | 'xuetang' | 'zhs';
  source: { repo: string; ref: string; path: string; symbol: string };
  synthetic: boolean;
  interactions: FixtureInteraction[];
  entry: { service: string; method: string; input: Json };
  expected?: Json;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

function headersInit(headers?: Record<string, string | string[]>): Headers | undefined {
  if (headers === undefined) return undefined;
  const list: [string, string][] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) list.push([key, item]);
    } else {
      list.push([key, value]);
    }
  }
  const result = new Headers();
  for (const [key, value] of list) result.append(key, value);
  return result;
}

/** Deterministic clock: sleep() records waits and advances virtual time. */
export class FakeClock implements Clock {
  private now = 1_728_000_000_000;
  readonly waits: number[] = [];
  private sleepHook: (() => void) | undefined;

  nowMs(): number {
    return this.now;
  }

  onSleep(hook: () => void): void {
    this.sleepHook = hook;
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.waits.push(ms);
    this.sleepHook?.();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    this.now += ms;
  }
}

function mismatch(detail: string): never {
  throw new Error(`fixture mismatch: ${detail}`);
}

/** Transport double: scripts responses, records requests, validates fixture order. */
export class FakeTransport implements Transport {
  readonly requests: Request[] = [];
  readonly calls: RecordedCall[] = [];
  private queue: ScriptedResponse[] = [];
  private validatedQueue: FixtureInteraction[] = [];
  private failures: Error[] = [];

  script(responses: ScriptedResponse[]): void {
    this.queue = [...responses];
  }

  scriptInteractions(interactions: FixtureInteraction[]): void {
    this.validatedQueue = [...interactions];
    this.queue = interactions.map((x) => x.response);
  }

  failNext(error: Error): void {
    this.failures.push(error);
  }

  unconsumedScripts(): number {
    return this.queue.length;
  }

  assertNoExtraScripts(): void {
    if (this.queue.length > 0) {
      throw new Error(`${this.queue.length} scripted responses were never consumed`);
    }
  }

  async fetch(input: Request): Promise<Response> {
    const bodyText = input.body === null ? null : await input.clone().text();
    const headers: Record<string, string> = {};
    for (const [key, value] of input.headers.entries()) headers[key] = value;
    this.requests.push(input);
    this.calls.push({ method: input.method, url: input.url, headers, bodyText });

    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;

    const interaction = this.validatedQueue.length > 0 ? this.validatedQueue[0] : undefined;
    const response = this.queue.shift();
    if (response === undefined) {
      throw new Error(`unregistered request: ${input.method} ${input.url}`);
    }
    if (interaction !== undefined) {
      this.validatedQueue.shift();
      this.validateAgainst(input, bodyText, interaction.request);
    }
    const scriptedHeaders = headersInit(response.headers);
    return new Response(
      response.body === undefined
        ? null
        : typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body),
      scriptedHeaders === undefined ? { status: response.status } : { status: response.status, headers: scriptedHeaders },
    );
  }

  async connect(): Promise<never> {
    throw new Error('FakeTransport does not support connect(); use tests/helpers/ws.ts');
  }

  private validateAgainst(
    request: Request,
    bodyText: string | null,
    expected: FixtureInteraction['request'],
  ): void {
    const url = new URL(request.url);
    if (request.method !== expected.method) {
      mismatch(`${url.pathname}: method ${request.method} != ${expected.method}`);
    }
    if (url.hostname !== expected.host) {
      mismatch(`${url.pathname}: host ${url.hostname} != ${expected.host}`);
    }
    if (url.pathname !== expected.path) {
      mismatch(`path ${url.pathname} != ${expected.path}`);
    }
    for (const [key, value] of Object.entries(expected.query ?? {})) {
      if (url.searchParams.get(key) !== value) {
        mismatch(`query ${key}=${url.searchParams.get(key)} != ${value}`);
      }
    }
    for (const [key, value] of Object.entries(expected.headers ?? {})) {
      const actual = request.headers.get(key);
      if (actual !== value) {
        mismatch(`header ${key}=${actual ?? '<missing>'} != ${value}`);
      }
    }
    if (expected.body !== undefined) {
      const actualBody = bodyText === null ? '' : bodyText;
      const expectedBody =
        typeof expected.body === 'string' ? expected.body : JSON.stringify(expected.body);
      let matches = actualBody === expectedBody;
      if (!matches) {
        try {
          matches = JSON.stringify(JSON.parse(actualBody)) === JSON.stringify(expected.body);
        } catch {
          matches = false;
        }
      }
      if (!matches) mismatch(`body ${actualBody} != ${expectedBody}`);
    }
  }
}

export interface ReplayContext {
  transport: FakeTransport;
  clock: FakeClock;
  fixture: Fixture;
}

/** Loads tests/fixtures/<name>.json, scripts the transport, runs, and asserts full consumption. */
export async function replay<T>(
  name: string,
  run: (context: ReplayContext) => Promise<T>,
): Promise<T> {
  const fixture = JSON.parse(
    readFileSync(resolve(testsDir, 'fixtures', `${name}.json`), 'utf8'),
  ) as Fixture;
  const transport = new FakeTransport();
  transport.scriptInteractions(fixture.interactions);
  const clock = new FakeClock();
  const result = await run({ transport, clock, fixture });
  if (transport.unconsumedScripts() > 0) {
    throw new Error(`fixture ${name}: ${transport.unconsumedScripts()} interactions never consumed`);
  }
  return result;
}
