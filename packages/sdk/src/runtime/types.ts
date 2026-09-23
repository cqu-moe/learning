import type { Json } from '../types/errors.js';

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
