import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStateStore } from './helpers/memory.js';
import { SqliteStateStore } from '../src/runtime/node/state.js';
import { decryptJson, encryptJson } from '../src/session/crypto.js';
import { readSession, revokeSession, writeSession } from '../src/session/store.js';
import type { StateStore } from './helpers/memory.js';
import type { Scope, SessionView } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'p1', platform: 'ykt' };
const masterKey = new Uint8Array(32).fill(7);

function stateStoreContract(name: string, make: () => Promise<StateStore>) {
  describe(`state store contract: ${name}`, () => {
    it('creates on expected-null then rejects stale expected (T03 snippet)', async () => {
      const store = await make();
      await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 1 }] });
      expect(
        await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 2 }] }),
      ).toBe(false);
      expect((await store.get('a'))?.value).toBe(1);
    });

    it('one stale expectation rolls back the whole batch (A031)', async () => {
      const store = await make();
      await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 1 }] });
      const ok = await store.commit({
        expected: [
          { key: 'a', revision: 1 },
          { key: 'b', revision: 5 },
        ],
        changes: [
          { key: 'a', value: 2 },
          { key: 'b', value: 3 },
        ],
      });
      expect(ok).toBe(false);
      expect((await store.get('a'))?.value).toBe(1);
      expect(await store.get('b')).toBeNull();
    });

    it('multi-key change is atomic and revisions increment', async () => {
      const store = await make();
      const ok = await store.commit({
        expected: [
          { key: 'a', revision: null },
          { key: 'b', revision: null },
        ],
        changes: [
          { key: 'a', value: 'x' },
          { key: 'b', value: 'y' },
        ],
      });
      expect(ok).toBe(true);
      expect((await store.get('a'))?.revision).toBe(1);
      expect((await store.get('b'))?.revision).toBe(1);
    });

    it('delete via null value follows the convention', async () => {
      const store = await make();
      await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 1 }] });
      const ok = await store.commit({
        expected: [{ key: 'a', revision: 1 }],
        changes: [{ key: 'a', value: null }],
      });
      expect(ok).toBe(true);
      expect(await store.get('a')).toBeNull();
      const recreated = await store.commit({
        expected: [{ key: 'a', revision: null }],
        changes: [{ key: 'a', value: 9 }],
      });
      expect(recreated).toBe(true);
      expect((await store.get('a'))?.revision).toBe(1);
    });

    it('lists by prefix with cursor pagination in key order', async () => {
      const store = await make();
      for (const key of ['job:1', 'job:2', 'job:3', 'profile:1']) {
        await store.commit({ expected: [{ key, revision: null }], changes: [{ key, value: key }] });
      }
      const page1 = await store.list('job:', null, 2);
      expect(page1.items.map((x) => x.key)).toEqual(['job:1', 'job:2']);
      expect(page1.nextCursor).toBe('job:2');
      const page2 = await store.list('job:', page1.nextCursor, 2);
      expect(page2.items.map((x) => x.key)).toEqual(['job:3']);
      expect(page2.nextCursor).toBeNull();
    });
  });
}

stateStoreContract('memory', async () => new MemoryStateStore());

const tempDir = mkdtempSync(resolve(tmpdir(), 'learning-store-'));
const sqliteStores: SqliteStateStore[] = [];
stateStoreContract('sqlite', async () => {
  const store = new SqliteStateStore(resolve(tempDir, `state-${sqliteStores.length}.db`));
  sqliteStores.push(store);
  return store;
});

afterAll(() => {
  for (const store of sqliteStores) store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AES-GCM session crypto (A032)', () => {
  it('round-trips with matching AAD', async () => {
    const payload = await encryptJson(masterKey, '{"a":1}', 'test-aad');
    expect(await decryptJson(masterKey, payload, 'test-aad')).toBe('{"a":1}');
  });

  it('rejects wrong key', async () => {
    const payload = await encryptJson(masterKey, 'secret', 'test-aad');
    await expect(decryptJson(new Uint8Array(32).fill(8), payload, 'test-aad')).rejects.toThrow();
  });

  it('rejects wrong AAD (scope/recordKind tampering)', async () => {
    const payload = await encryptJson(masterKey, 'secret', '["1","session","local","p1","ykt"]');
    await expect(decryptJson(masterKey, payload, '["1","session","local","p2","ykt"]')).rejects.toThrow();
    await expect(decryptJson(masterKey, payload, '["1","preview","local","p1","ykt"]')).rejects.toThrow();
  });

  it('uses a fresh random IV per call', async () => {
    const a = await encryptJson(masterKey, 'same', 'aad');
    const b = await encryptJson(masterKey, 'same', 'aad');
    expect(a).not.toBe(b);
  });
});

describe('session store', () => {
  const makeStore = () => new MemoryStateStore();
  const view: SessionView = {
    scope,
    generation: 3,
    displayName: 'fixture user',
    platformUserId: 'u1',
    identityVerified: true,
    checkedAtMs: 1000,
  };

  it('write/read roundtrip keeps cookies and generation', async () => {
    const state = makeStore();
    await writeSession(state, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 3,
      platformUserId: 'u1',
      identityVerified: true,
      cookieJar: { stores: { 'yuketang.cn': { sessionid: 'abc' } } },
      displayName: 'fixture user',
      checkedAtMs: 1000,
    });
    const record = await readSession(state, masterKey, scope);
    expect(record?.generation).toBe(3);
    expect(record?.cookieJar).toEqual({ stores: { 'yuketang.cn': { sessionid: 'abc' } } });
  });

  it('same profile key under different user/platform fails AAD (A032)', async () => {
    const state = makeStore();
    await writeSession(state, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 1,
      platformUserId: null,
      identityVerified: false,
      cookieJar: {},
      displayName: null,
      checkedAtMs: 0,
    });
    await expect(
      readSession(state, masterKey, { userId: 'other', profileId: 'p1', platform: 'ykt' }),
    ).rejects.toThrow();
    await expect(
      readSession(state, masterKey, { userId: 'local', profileId: 'p1', platform: 'xuetang' }),
    ).rejects.toThrow();
  });

  it('tombstone stops old generations from reviving (A032)', async () => {
    const state = makeStore();
    await writeSession(state, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 5,
      platformUserId: 'u1',
      identityVerified: true,
      cookieJar: {},
      displayName: null,
      checkedAtMs: 0,
    });
    await revokeSession(state, masterKey, scope, 5);
    await expect(
      writeSession(state, masterKey, {
        schemaVersion: 1,
        scope,
        generation: 4,
        platformUserId: 'late',
        identityVerified: true,
        cookieJar: {},
        displayName: null,
        checkedAtMs: 0,
      }),
    ).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
    expect(await readSession(state, masterKey, scope)).toBeNull();
  });

  it('higher generation may write after a tombstone', async () => {
    const state = makeStore();
    await writeSession(state, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 1,
      platformUserId: null,
      identityVerified: false,
      cookieJar: {},
      displayName: null,
      checkedAtMs: 0,
    });
    await revokeSession(state, masterKey, scope, 1);
    await writeSession(state, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 2,
      platformUserId: 'fresh',
      identityVerified: true,
      cookieJar: {},
      displayName: null,
      checkedAtMs: 1,
    });
    const record = await readSession(state, masterKey, scope);
    expect(record?.platformUserId).toBe('fresh');
    expect(record?.generation).toBe(2);
  });

  it('sqlite store serves sessions too', async () => {
    const store = new SqliteStateStore(resolve(tempDir, 'session.db'));
    sqliteStores.push(store);
    await writeSession(store, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 1,
      platformUserId: 'u1',
      identityVerified: true,
      cookieJar: {},
      displayName: null,
      checkedAtMs: 0,
    });
    expect((await readSession(store, masterKey, scope))?.generation).toBe(1);
    expect(view.generation).toBe(3);
  });
});
