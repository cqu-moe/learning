import { describe, expect, it } from 'vitest';
import { AuthLifecycle, probeSession } from '../src/auth/flow.js';
import { importLegacyCookies } from '../src/auth/legacy.js';
import { NodeSocket } from '../src/runtime/node/transport.js';
import { createLearningClient, aggregateCourses } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import { FakeWebSocketLike, fakeWsPair } from './helpers/ws.js';
import type { SessionRecord } from '../src/session/store.js';
import type { Runtime } from '../src/runtime/types.js';
import type { AuthEvent, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'p1', platform: 'ykt' };
const masterKey = new Uint8Array(32).fill(3);

function record(generation: number, platformUserId = 'u' + generation): Omit<SessionRecord, 'scope'> {
  return {
    schemaVersion: 1,
    generation,
    platformUserId,
    identityVerified: true,
    cookieJar: {},
    displayName: null,
    checkedAtMs: 1000,
  };
}

function makeLifecycle() {
  const state = new MemoryStateStore();
  const clock = new FakeClock();
  const lifecycle = new AuthLifecycle({ scope, clock, state, masterKey });
  return { lifecycle, state, clock };
}

async function readFrom(state: MemoryStateStore) {
  const { readSession } = await import('../src/session/store.js');
  return readSession(state, masterKey, scope);
}

describe('auth lifecycle (T05, A051)', () => {
  it('emits events in order, writes the session, resolves the view', async () => {
    const { lifecycle, state } = makeLifecycle();
    const flow = lifecycle.begin((ctx) => {
      ctx.emit({ type: 'qr', generation: ctx.generation, qr: { type: 'text', value: 'https://qr' }, expiresAtMs: 60000 });
      ctx.emit({ type: 'waiting', generation: ctx.generation });
      return ctx.finish(record(ctx.generation));
    });
    const events: AuthEvent[] = [];
    for await (const event of flow.events) {
      events.push(event);
      if (event.type === 'authenticated') break;
    }
    expect(events.map((e) => e.type)).toEqual(['qr', 'waiting', 'authenticated']);
    expect((await flow.result).generation).toBe(1);
    expect((await readFrom(state))?.generation).toBe(1);
  });

  it('cancel destroys the flow; a late WS success writes nothing (A051)', async () => {
    const { lifecycle, state } = makeLifecycle();
    const pair = fakeWsPair();
    const flow = lifecycle.begin(async (ctx) => {
      ctx.emit({ type: 'waiting', generation: ctx.generation });
      for await (const message of pair.client.messages) {
        if (message === 'late-success') {
          await ctx.finish(record(ctx.generation, 'late'));
          return;
        }
      }
    });
    await flow.cancel();
    pair.server.push('late-success');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await readFrom(state)).toBeNull();
    await expect(flow.result).rejects.toMatchObject({ data: { code: 'CANCELED' } });
  });

  it('a superseded generation cannot overwrite the newer one (A051)', async () => {
    const { lifecycle, state } = makeLifecycle();
    let staleFinish: (() => Promise<void>) | undefined;
    lifecycle.begin((ctx) => {
      staleFinish = () => ctx.finish(record(ctx.generation, 'stale'));
      return new Promise(() => {});
    });
    const flow2 = lifecycle.begin((ctx) => ctx.finish(record(ctx.generation, 'fresh')));
    expect((await flow2.result).generation).toBe(2);
    await staleFinish?.();
    const stored = await readFrom(state);
    expect(stored?.platformUserId).toBe('fresh');
    expect(stored?.generation).toBe(2);
  });

  it('enforces the 10-minute total budget lazily', async () => {
    const { lifecycle, clock } = makeLifecycle();
    const flow = lifecycle.begin(async (ctx) => {
      await clock.sleep(601000, ctx.signal);
      await ctx.finish(record(ctx.generation));
    });
    await expect(flow.result).rejects.toMatchObject({ data: { code: 'TIMEOUT' } });
  });
});

describe('probe wrapper (A052)', () => {
  it('maps provider network errors to indeterminate without touching the session', async () => {
    const state = new MemoryStateStore();
    const { writeSession } = await import('../src/session/store.js');
    await writeSession(state, masterKey, { scope, ...record(4) });
    const probe = await probeSession({
      scope,
      state,
      masterKey,
      provider: {
        async probe() {
          throw new Error('dns gone');
        },
      },
    });
    expect(probe.state).toBe('indeterminate');
    expect((await readFrom(state))?.generation).toBe(4);
  });

  it('returns expired when the provider rejects the session', async () => {
    const state = new MemoryStateStore();
    const probe = await probeSession({
      scope,
      state,
      masterKey,
      provider: { probe: async () => null },
    });
    expect(probe.state).toBe('expired');
  });
});

describe('NodeSocket bounded mailbox (256 frames, 1MiB each)', () => {
  it('relays text frames both ways', async () => {
    const fake = new FakeWebSocketLike();
    const opening = NodeSocket.fromWebSocket(fake, new AbortController().signal);
    fake.serverOpen();
    const socket = await opening;
    await socket.send('hello');
    expect(fake.sent).toEqual(['hello']);
    fake.serverPush('hi');
    const iterator = socket.messages[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('hi');
    await socket.close();
  });

  it('rejects oversized frames', async () => {
    const fake = new FakeWebSocketLike();
    const opening = NodeSocket.fromWebSocket(fake, new AbortController().signal);
    fake.serverOpen();
    const socket = await opening;
    fake.serverPush('x'.repeat(1024 * 1024 + 1));
    const iterator = socket.messages[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
  });

  it('rejects mailbox overflow beyond 256 frames', async () => {
    const fake = new FakeWebSocketLike();
    const opening = NodeSocket.fromWebSocket(fake, new AbortController().signal);
    fake.serverOpen();
    const socket = await opening;
    for (let i = 0; i < 257; i += 1) fake.serverPush('m' + i);
    const iterator = socket.messages[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
  });
});

function stubArtifacts(): Runtime['artifacts'] {
  return {
    create: async () => {
      throw new Error('not needed in this test');
    },
    resume: async () => {
      throw new Error('not needed in this test');
    },
    open: async () => {
      throw new Error('not needed in this test');
    },
    remove: async () => {},
  };
}

function makeRuntime(transport: FakeTransport): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    artifacts: stubArtifacts(),
    clock: new FakeClock(),
    masterKey,
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

describe('SDK factory (A052)', () => {
  it('makes no network requests on construction or capabilities()', () => {
    const transport = new FakeTransport();
    const client = createLearningClient({ scope, runtime: makeRuntime(transport) });
    expect(client.capabilities().length).toBeGreaterThan(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('unimplemented provider methods throw UNSUPPORTED, never empty lists', async () => {
    const zhsScope: Scope = { userId: 'local', profileId: 'p3', platform: 'zhs' };
    const client = createLearningClient({ scope: zhsScope, runtime: makeRuntime(new FakeTransport()) });
    await expect(client.discussions.get({ resource: { course: { scope: zhsScope, key: 'k', native: { kind: 'zhs-hike', courseId: 'c1' } }, key: 'r', native: { kind: 'zhs-hike', fileId: 'f1' } }, topicId: 't1' })).rejects.toMatchObject({ data: { code: 'UNSUPPORTED' } });
    await expect(client.actions.prepare({ kind: 'exam.start', ref: { resource: { course: { scope: zhsScope, key: 'k', native: { kind: 'zhs-hike', courseId: 'c1' } }, key: 'r', native: { kind: 'zhs-hike', fileId: 'f1' } }, kind: 'exam', assessmentId: 'a1' } })).rejects.toMatchObject({ data: { code: 'UNSUPPORTED' } });
  });

  it('importLegacy cookie-array writes a session offline', async () => {
    const transport = new FakeTransport();
    const runtime = makeRuntime(transport);
    const result = await importLegacyCookies(runtime, scope, [
      { name: 'sessionid', value: 'abc', domain: 'yuketang.cn', path: '/' },
    ]);
    expect(result.value.identityVerified).toBe(false);
    expect(transport.requests).toHaveLength(0);
    expect((await readFrom(runtime.state as MemoryStateStore))?.generation).toBe(1);
  });

  it('disconnect tombstones the session so stale generations cannot revive', async () => {
    const runtime = makeRuntime(new FakeTransport());
    await importLegacyCookies(runtime, scope, []);
    const client = createLearningClient({ scope, runtime });
    await client.auth.disconnect();
    expect(await readFrom(runtime.state as MemoryStateStore)).toBeNull();
  });

  it('aggregateCourses keeps per-profile errors separate and ordered', async () => {
    const zhsScope: Scope = { userId: 'local', profileId: 'p3', platform: 'zhs' };
    const client = createLearningClient({ scope: zhsScope, runtime: makeRuntime(new FakeTransport()) });
    const results = await aggregateCourses([client]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ scope: zhsScope, error: { code: 'NETWORK' } });
  });
});
