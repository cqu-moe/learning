import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { LearningError } from '../../types/errors.js';
import type { Json } from '../../types/errors.js';
import type { StateStore, StoredValue } from '../types.js';

const SUPPORTED_SCHEMA_VERSION = 1;

function asJson(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map((x) => asJson(x));
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = asJson(v);
    return out;
  }
  throw new LearningError({ code: 'STORAGE', message: 'record is not JSON', retryAfterMs: null, operationId: null });
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Local SQLite StateStore (SDK S04): one records table, optimistic transactions, no ORM. */
export class SqliteStateStore implements StateStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);',
    );
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);');
    const row = this.db.prepare('SELECT version FROM schema_meta LIMIT 1;').get() as
      | { version: number }
      | undefined;
    if (row === undefined) {
      this.db.prepare('INSERT INTO schema_meta (version) VALUES (?);').run(SUPPORTED_SCHEMA_VERSION);
    } else if (row.version !== SUPPORTED_SCHEMA_VERSION) {
      throw new LearningError({
        code: 'VERSION',
        message: `unsupported state schema ${row.version}`,
        retryAfterMs: null,
        operationId: null,
      });
    }
  }

  async get(key: string): Promise<StoredValue | null> {
    this.assertOpen();
    const row = this.db.prepare('SELECT revision, value FROM records WHERE key = ?;').get(key) as
      | { revision: number; value: string }
      | undefined;
    if (row === undefined) return null;
    return { revision: row.revision, value: asJson(JSON.parse(row.value)) };
  }

  async list(
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: { key: string; record: StoredValue }[]; nextCursor: string | null }> {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 1) {
      throw new LearningError({
        code: 'INVALID_INPUT',
        message: 'limit must be a positive integer',
        retryAfterMs: null,
        operationId: null,
      });
    }
    const rows = this.db
      .prepare(
        "SELECT key, revision, value FROM records WHERE key LIKE ? ESCAPE '\\' AND key > ? ORDER BY key LIMIT ?;",
      )
      .all(`${escapeLike(prefix)}%`, cursor ?? '', limit + 1) as unknown as {
      key: string;
      revision: number;
      value: string;
    }[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > page.length ? (page[page.length - 1]?.key ?? null) : null;
    return {
      items: page.map((row) => ({
        key: row.key,
        record: { revision: row.revision, value: asJson(JSON.parse(row.value)) },
      })),
      nextCursor,
    };
  }

  async commit(input: {
    expected: { key: string; revision: number | null }[];
    changes: { key: string; value: Json | null }[];
  }): Promise<boolean> {
    this.assertOpen();
    for (const { key } of [...input.expected, ...input.changes]) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new LearningError({
          code: 'INVALID_INPUT',
          message: 'record keys must be non-empty strings',
          retryAfterMs: null,
          operationId: null,
        });
      }
    }
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const expected of input.expected) {
        const row = this.db.prepare('SELECT revision FROM records WHERE key = ?;').get(expected.key) as
          | { revision: number }
          | undefined;
        const current = row?.revision ?? null;
        if (current !== expected.revision) {
          this.db.exec('ROLLBACK;');
          return false;
        }
      }
      for (const change of input.changes) {
        if (change.value === null) {
          this.db.prepare('DELETE FROM records WHERE key = ?;').run(change.key);
          continue;
        }
        const row = this.db.prepare('SELECT revision FROM records WHERE key = ?;').get(change.key) as
          | { revision: number }
          | undefined;
        const nextRevision = (row?.revision ?? 0) + 1;
        this.db
          .prepare(
            'INSERT INTO records (key, revision, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, value = excluded.value;',
          )
          .run(change.key, nextRevision, JSON.stringify(change.value));
      }
      this.db.exec('COMMIT;');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new LearningError({
        code: 'STORAGE',
        message: 'state store is closed',
        retryAfterMs: null,
        operationId: null,
      });
    }
  }
}
