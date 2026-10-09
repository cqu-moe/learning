import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const fixturePath = process.env.LEARNING_FIXTURE_FILE;
if (!fixturePath) throw new Error('LEARNING_FIXTURE_FILE missing');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const interactions = fixture.interactions.slice();
let consumed = 0;
let socketOpened = false;
let socketHello = false;
let socketClosed = false;

if (fixture.websocket) {
  globalThis.WebSocket = class {
    listeners = new Map();
    constructor(url) {
      if (url !== fixture.websocket.url || socketOpened) throw new Error(`unexpected websocket ${url}`);
      socketOpened = true;
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(type, listener) {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(listener);
      this.listeners.set(type, handlers);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((handler) => handler !== listener));
    }
    emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    send(message) {
      const actual = JSON.parse(message);
      if (!matchesTemplate(actual, fixture.websocket.hello)) throw new Error('websocket hello mismatch');
      socketHello = true;
      for (const frame of fixture.websocket.frames) queueMicrotask(() => this.emit('message', { data: JSON.stringify(frame) }));
    }
    close() { socketClosed = true; this.emit('close', {}); }
  };
}

function matchesTemplate(actual, expected) {
  if (expected === '__NOW_MS__') return typeof actual === 'string' && /^\d+$/.test(actual) && Math.abs(Number(actual) - Date.now()) < 10_000;
  if (expected === '__NOW_NUMBER__') return typeof actual === 'number' && Math.abs(actual - Date.now()) < 10_000;
  if (expected === '__JOB_PG_502__') return typeof actual === 'string' && /^job-[0-9a-f-]+_502$/.test(actual);
  if (expected === '__JOB_PG_7__') return typeof actual === 'string' && /^job-[0-9a-f-]+_7$/.test(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matchesTemplate(actual[index], item));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && !Array.isArray(actual)
    && isDeepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
    && Object.entries(expected).every(([key, value]) => matchesTemplate(actual[key], value));
  return isDeepStrictEqual(actual, expected);
}

globalThis.fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const expected = interactions.shift();
  if (!expected) throw new Error(`undeclared request ${request.method} ${request.url}`);
  consumed += 1;
  const url = new URL(request.url);
  const match = expected.request;
  if (request.method !== match.method || url.hostname !== match.host || url.pathname !== match.path) {
    throw new Error(`request mismatch #${consumed}: ${request.method} ${url.hostname}${url.pathname}`);
  }
  const query = Object.fromEntries(url.searchParams);
  if (!matchesTemplate(query, match.query ?? {})) throw new Error(`query mismatch #${consumed}`);
  for (const [key, value] of Object.entries(match.headers ?? {})) {
    if (request.headers.get(key) !== value) throw new Error(`header ${key} mismatch #${consumed}`);
  }
  if (process.env.LEARNING_ASSERT_COOKIE && !request.headers.get('cookie')?.includes(process.env.LEARNING_ASSERT_COOKIE)) {
    throw new Error(`session cookie missing #${consumed}`);
  }
  const body = await request.text();
  if (match.body !== undefined) {
    const actual = typeof match.body === 'string' ? body : JSON.parse(body);
    if (!matchesTemplate(actual, match.body)) throw new Error(`body mismatch #${consumed}`);
  } else if (body !== '') throw new Error(`unexpected body #${consumed}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(expected.response.headers ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  let responseBody;
  if (Array.isArray(expected.response.chunks)) {
    let index = 0;
    responseBody = new ReadableStream({ pull(controller) {
      if (index < expected.response.chunks.length) { controller.enqueue(Buffer.from(expected.response.chunks[index], 'base64')); index += 1; return; }
      if (expected.response.failAfterChunks) controller.error(new Error('fixture stream interrupted'));
      else controller.close();
    } });
  } else responseBody = typeof expected.response.base64 === 'string'
    ? Buffer.from(expected.response.base64, 'base64')
    : typeof expected.response.body === 'string'
      ? expected.response.body
      : JSON.stringify(expected.response.body ?? {});
  return new Response(responseBody, { status: expected.response.status, headers });
};

process.on('exit', () => {
  if (interactions.length !== 0) {
    process.stderr.write(`fixture: ${interactions.length} interactions unused\n`);
    process.exitCode = 1;
  }
  if (fixture.websocket && (!socketOpened || !socketHello || !socketClosed)) {
    process.stderr.write('fixture: websocket handshake or cleanup was incomplete\n');
    process.exitCode = 1;
  }
});
