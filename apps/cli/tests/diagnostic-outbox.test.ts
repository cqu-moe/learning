import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  lstatSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticOutbox, type OutboxEvent } from '../src/diagnostic-outbox.js';

const roots: string[] = [];
const destination = 'https://example.invalid/batch phc_example_public_token';
const now = Date.now();

function tempRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'learning-diagnostic-outbox-'));
  roots.push(root);
  return root;
}

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    uuid: crypto.randomUUID(),
    event: '$exception',
    distinct_id: 'cli:00000000-0000-0000-0000-000000000001',
    timestamp: new Date(now).toISOString(),
    properties: { code: 'INTERNAL' },
    ...overrides,
  };
}

function outboxDirectory(root: string): string {
  const parent = resolve(root, 'diagnostic-outbox');
  const destination = readdirSync(parent, { withFileTypes: true }).find(entry => entry.isDirectory());
  if (destination === undefined) throw new Error('test outbox destination directory is missing');
  return join(destination.parentPath, destination.name);
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('diagnostic outbox', () => {
  it('persists unacknowledged events across instances without changing their UUID', () => {
    const root = tempRoot();
    const item = event();
    new DiagnosticOutbox(root, destination).add(item);

    const restored = new DiagnosticOutbox(root, destination).pending(10);
    expect(restored).toEqual([item]);
    expect(new DiagnosticOutbox(root, destination).pending(10)).toEqual([item]);

    new DiagnosticOutbox(root, destination).acknowledge(item.uuid);
    expect(new DiagnosticOutbox(root, destination).pending(10)).toEqual([]);
  });

  it('keeps destinations isolated and never stores the destination or token', () => {
    const root = tempRoot();
    const first = event();
    const second = event();
    new DiagnosticOutbox(root, destination).add(first);
    new DiagnosticOutbox(root, 'https://other.invalid/batch phc_other_token').add(second);

    expect(new DiagnosticOutbox(root, destination).pending(10)).toEqual([first]);
    expect(new DiagnosticOutbox(root, 'https://other.invalid/batch phc_other_token').pending(10)).toEqual([second]);
    expect(readdirSync(root, { recursive: true })).not.toContain('phc_other_token');
  });

  it('rejects malformed, non-exception, and oversized events', () => {
    const root = tempRoot();
    const outbox = new DiagnosticOutbox(root, destination);
    expect(() => outbox.add(event({ event: 'cli_command_completed' }))).toThrow();
    expect(() => outbox.add(event({ uuid: '../escape' }))).toThrow();
    expect(() => outbox.add(event({ properties: { body: 'x'.repeat(33 * 1024) } }))).toThrow();
    expect(outbox.pending(10)).toEqual([]);
  });

  it('removes expired and corrupted entries instead of returning them', () => {
    const root = tempRoot();
    const expired = event({ timestamp: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() });
    const valid = event();
    const outbox = new DiagnosticOutbox(root, destination);
    outbox.add(expired);
    outbox.add(valid);
    const directory = outboxDirectory(root);
    const invalidPath = join(directory, `${crypto.randomUUID()}.json`);
    writeFileSync(invalidPath, '{not json', { mode: 0o600 });

    expect(outbox.pending(10)).toEqual([valid]);
    expect(new DiagnosticOutbox(root, destination).pending(10)).toEqual([valid]);
    expect(exists(invalidPath)).toBe(false);
    expect(outbox.droppedCount).toBe(2);
  });

  it('evicts oldest events at the count and byte limits', () => {
    const root = tempRoot();
    const outbox = new DiagnosticOutbox(root, destination);
    const oldest = event({ timestamp: new Date(now - 1).toISOString(), properties: { value: 'old' } });
    outbox.add(oldest);
    for (let index = 0; index < 255; index += 1) outbox.add(event());

    expect(outbox.pending(256)).toHaveLength(256);
    const newest = event({ timestamp: new Date(now + 1).toISOString() });
    outbox.add(newest);
    const pending = outbox.pending(256);
    expect(pending.map(item => item.uuid)).not.toContain(oldest.uuid);
    expect(pending.map(item => item.uuid)).toContain(newest.uuid);
    expect(outbox.droppedCount).toBeGreaterThanOrEqual(1);

    const largeRoot = tempRoot();
    const largeOutbox = new DiagnosticOutbox(largeRoot, destination);
    const payload = 'x'.repeat(30 * 1024);
    for (let index = 0; index < 170; index += 1) largeOutbox.add(event({ properties: { payload } }));
    const largePending = largeOutbox.pending(256);
    expect(largePending.length).toBeLessThanOrEqual(169);
    expect(largePending.every(item => Buffer.byteLength(JSON.stringify(item)) <= 32 * 1024)).toBe(true);
    expect(largeOutbox.droppedCount).toBeGreaterThanOrEqual(1);
  });

  it('ignores and removes a symlinked event without following it', () => {
    const root = tempRoot();
    const outbox = new DiagnosticOutbox(root, destination);
    const item = event();
    outbox.add(item);
    const directory = outboxDirectory(root);
    const target = resolve(root, 'target.json');
    writeFileSync(target, JSON.stringify(event()), { mode: 0o600 });
    symlinkSync(target, join(directory, `${crypto.randomUUID()}.json`));

    expect(outbox.pending(10)).toEqual([item]);
    expect(exists(target)).toBe(true);
  });

  it('rejects a non-directory or linked outbox and preserves other data', () => {
    const root = tempRoot();
    writeFileSync(resolve(root, 'diagnostic-outbox'), 'not a directory', { mode: 0o600 });
    expect(() => new DiagnosticOutbox(root, destination).pending(1)).toThrow(/ordinary directory/);

    const linkedRoot = tempRoot();
    const realDirectory = resolve(linkedRoot, 'real');
    mkdirSync(realDirectory, { mode: 0o700 });
    symlinkSync(realDirectory, resolve(linkedRoot, 'diagnostic-outbox'));
    expect(() => new DiagnosticOutbox(linkedRoot, destination).add(event())).toThrow(/ordinary directory/);
    expect(exists(resolve(linkedRoot, 'diagnostic-outbox'))).toBe(true);
  });

  it('creates private files and preserves concurrent additions across instances', async () => {
    const root = tempRoot();
    const writers = Array.from({ length: 8 }, async () => {
      const item = event();
      new DiagnosticOutbox(root, destination).add(item);
      return item;
    });
    const items = await Promise.all(writers);
    const pending = new DiagnosticOutbox(root, destination).pending(items.length);
    expect(new Set(pending.map(item => item.uuid))).toEqual(new Set(items.map(item => item.uuid)));
    for (const item of items) new DiagnosticOutbox(root, destination).acknowledge(item.uuid);
    expect(new DiagnosticOutbox(root, destination).pending(items.length)).toEqual([]);
    expect(readdirSync(outboxDirectory(root))).toEqual([]);
  });

  it('uses event timestamps for retention and file metadata remains private', () => {
    vi.useFakeTimers({ now });
    const root = tempRoot();
    const stale = event({ timestamp: new Date(now - 7 * 24 * 60 * 60 * 1000 + 1).toISOString() });
    const fresh = event();
    const outbox = new DiagnosticOutbox(root, destination);
    outbox.add(stale);
    outbox.add(fresh);
    const stalePath = resolve(outboxDirectory(root), `${stale.uuid}.json`);
    utimesSync(stalePath, new Date(now), new Date(now));

    vi.advanceTimersByTime(2);
    expect(outbox.pending(10)).toEqual([fresh]);
    expect(outbox.droppedCount).toBe(1);
    const directory = outboxDirectory(root);
    const entry = readdirSync(directory, { withFileTypes: true }).find(candidate => candidate.isFile())!;
    const path = join(entry.parentPath, entry.name);
    expect(path).toBe(resolve(directory, `${fresh.uuid}.json`));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
