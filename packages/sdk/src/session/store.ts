import { LearningError } from '../types/errors.js';
import type { Json } from '../types/errors.js';
import type { Scope } from '../types/refs.js';
import type { StateStore, StoredValue } from '../runtime/types.js';
import { decryptJson, encryptJson } from './crypto.js';

export interface SessionRecord {
  schemaVersion: 1;
  revoked?: false;
  scope: Scope;
  generation: number;
  platformUserId: string | null;
  identityVerified: boolean;
  cookieJar: Json;
  displayName: string | null;
  checkedAtMs: number;
}

interface RevocationTombstone {
  revoked: true;
  generation: number;
}

function sessionKey(scope: Scope): string {
  return `session:${scope.profileId}`;
}

function aadFor(scope: Scope): string {
  return JSON.stringify([1, 'session', scope.userId, scope.profileId, scope.platform]);
}

async function readRaw(
  state: StateStore,
  masterKey: Uint8Array,
  scope: Scope,
): Promise<{ stored: StoredValue; record: SessionRecord | RevocationTombstone } | null> {
  const stored = await state.get(sessionKey(scope));
  if (stored === null) return null;
  if (typeof stored.value !== 'string') {
    throw new LearningError({ code: 'STORAGE', message: 'session record is not encrypted text', retryAfterMs: null, operationId: null });
  }
  const plaintext = await decryptJson(masterKey, stored.value, aadFor(scope));
  const parsed = JSON.parse(plaintext) as SessionRecord | RevocationTombstone;
  return { stored, record: parsed };
}

export async function readSession(
  state: StateStore,
  masterKey: Uint8Array,
  scope: Scope,
): Promise<SessionRecord | null> {
  const raw = await readRaw(state, masterKey, scope);
  if (raw === null || raw.record.revoked === true) return null;
  if (raw.record.schemaVersion !== 1) {
    throw new LearningError({ code: 'VERSION', message: 'unsupported session schema', retryAfterMs: null, operationId: null });
  }
  return raw.record;
}

/** Includes revocation tombstones so a replacement login always advances generation. */
export async function readSessionGeneration(
  state: StateStore,
  masterKey: Uint8Array,
  scope: Scope,
): Promise<number> {
  const raw = await readRaw(state, masterKey, scope);
  return raw?.record.generation ?? 0;
}

export async function writeSession(
  state: StateStore,
  masterKey: Uint8Array,
  record: SessionRecord,
): Promise<void> {
  if (record.schemaVersion !== 1) {
    throw new LearningError({ code: 'VERSION', message: 'unsupported session schema', retryAfterMs: null, operationId: null });
  }
  const current = await readRaw(state, masterKey, record.scope);
  if (current !== null && current.record.revoked === true && record.generation <= current.record.generation) {
    throw new LearningError({
      code: 'CONFLICT',
      message: 'session was revoked; a newer generation is required',
      retryAfterMs: null,
      operationId: null,
    });
  }
  if (current !== null && current.record.revoked !== true && record.generation < current.record.generation) {
    throw new LearningError({
      code: 'CONFLICT',
      message: 'cannot rewrite an older session generation',
      retryAfterMs: null,
      operationId: null,
    });
  }
  const encrypted = await encryptJson(masterKey, JSON.stringify(record), aadFor(record.scope));
  const ok = await state.commit({
    expected: [{ key: sessionKey(record.scope), revision: current?.stored.revision ?? null }],
    changes: [{ key: sessionKey(record.scope), value: encrypted }],
  });
  if (!ok) {
    throw new LearningError({
      code: 'CONFLICT',
      message: 'session record changed concurrently',
      retryAfterMs: null,
      operationId: null,
    });
  }
}

export async function revokeSession(
  state: StateStore,
  masterKey: Uint8Array,
  scope: Scope,
  atGeneration: number,
): Promise<void> {
  const current = await readRaw(state, masterKey, scope);
  const generation = Math.max(atGeneration, current?.record.generation ?? 0);
  const tombstone: RevocationTombstone = { revoked: true, generation };
  const encrypted = await encryptJson(masterKey, JSON.stringify(tombstone), aadFor(scope));
  const ok = await state.commit({
    expected: [{ key: sessionKey(scope), revision: current?.stored.revision ?? null }],
    changes: [{ key: sessionKey(scope), value: encrypted }],
  });
  if (!ok) {
    throw new LearningError({
      code: 'CONFLICT',
      message: 'session record changed concurrently',
      retryAfterMs: null,
      operationId: null,
    });
  }
}
