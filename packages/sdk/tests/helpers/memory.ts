import type { Json } from '../../src/types/errors.js';

export interface StoredValue {
  revision: number;
  value: Json;
}

export interface StateStore {
  get(key: string): Promise<StoredValue | null>;
  list(
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: { key: string; record: StoredValue }[]; nextCursor: string | null }>;
  commit(input: {
    expected: { key: string; revision: number | null }[];
    changes: { key: string; value: Json | null }[];
  }): Promise<boolean>;
}

/** In-memory StateStore for tests: atomic optimistic-concurrency commits. */
export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, StoredValue>();

  async get(key: string): Promise<StoredValue | null> {
    return this.records.get(key) ?? null;
  }

  async list(
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: { key: string; record: StoredValue }[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('limit must be a positive integer');
    }
    const keys = [...this.records.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const remaining = cursor === null ? keys : keys.filter((key) => key > cursor);
    const page = remaining.slice(0, limit);
    const nextCursor = remaining.length > page.length ? (page[page.length - 1] ?? null) : null;
    const items = page.map((key) => {
      const record = this.records.get(key);
      if (record === undefined) throw new Error(`key disappeared: ${key}`);
      return { key, record };
    });
    return { items, nextCursor };
  }

  async commit(input: {
    expected: { key: string; revision: number | null }[];
    changes: { key: string; value: Json | null }[];
  }): Promise<boolean> {
    for (const expected of input.expected) {
      const current = this.records.get(expected.key);
      const currentRevision = current?.revision ?? null;
      if (currentRevision !== expected.revision) return false;
    }
    for (const change of input.changes) {
      const current = this.records.get(change.key);
      const nextRevision = (current?.revision ?? 0) + 1;
      if (change.value === null) {
        this.records.delete(change.key);
      } else {
        this.records.set(change.key, { revision: nextRevision, value: change.value });
      }
    }
    return true;
  }
}
