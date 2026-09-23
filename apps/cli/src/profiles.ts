import { ScopeSchema } from '@learning/sdk/public';
import type { Platform, Scope } from '@learning/sdk/public';
import type { SqliteStateStore } from '@learning/sdk/node';
import { randomUUID } from 'node:crypto';

export interface LocalProfile { name: string; scope: Scope }

function key(name: string): string {
  return `cli:profile:${encodeURIComponent(name)}`;
}

function parse(value: unknown): LocalProfile {
  if (value === null || typeof value !== 'object') throw new Error('invalid profile record');
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) throw new Error('invalid profile name');
  const scope = ScopeSchema.parse(record.scope);
  if (scope.userId !== 'local') throw new Error('invalid profile scope');
  return { name: record.name, scope };
}

export function validName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && name === name.trim() && [...name].every((char) => {
    const code = char.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}

export async function getProfile(state: SqliteStateStore, name: string): Promise<LocalProfile | null> {
  const record = await state.get(key(name));
  return record === null ? null : parse(record.value);
}

export async function listProfiles(state: SqliteStateStore): Promise<LocalProfile[]> {
  const profiles: LocalProfile[] = [];
  let cursor: string | null = null;
  do {
    const page = await state.list('cli:profile:', cursor, 100);
    for (const entry of page.items) profiles.push(parse(entry.record.value));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function addProfile(state: SqliteStateStore, name: string, platform: Platform): Promise<LocalProfile | null> {
  const profile: LocalProfile = { name, scope: { userId: 'local', profileId: randomUUID(), platform } };
  const ok = await state.commit({ expected: [{ key: key(name), revision: null }], changes: [{ key: key(name), value: { name: profile.name, scope: { ...profile.scope } } }] });
  return ok ? profile : null;
}

export async function removeProfile(state: SqliteStateStore, name: string): Promise<LocalProfile | null> {
  const stored = await state.get(key(name));
  if (stored === null) return null;
  const profile = parse(stored.value);
  const ok = await state.commit({ expected: [{ key: key(name), revision: stored.revision }], changes: [{ key: key(name), value: null }] });
  if (!ok) throw new Error('profile changed while removing it');
  return profile;
}
