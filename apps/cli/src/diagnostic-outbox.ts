import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { JsonSchema, type Json } from '@learning/sdk/public';

export type OutboxEvent = {
  uuid: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, Json | undefined>;
};

const OutboxEventSchema = z.object({
  uuid: z.string().uuid(),
  event: z.literal('$exception'),
  distinct_id: z.string().min(1).max(256),
  timestamp: z.iso.datetime(),
  properties: z.record(z.string(), z.union([JsonSchema, z.undefined()])),
}).strict();

const DIRECTORY_NAME = 'diagnostic-outbox';
const MAX_EVENTS = 256;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_BYTES = 32 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_FILE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;
const TEMP_FILE = /^\.tmp-[0-9a-fA-F-]{36}-[0-9a-fA-F-]{36}\.json$/;

type ValidOutboxEvent = z.infer<typeof OutboxEventSchema>;
type StoredEvent = ValidOutboxEvent & { path: string; size: number; fileTimeMs: number };

function ensureDirectory(path: string): void {
  let existed = true;
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existed = false;
  }
  if (!existed) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`diagnostic outbox path must be an ordinary directory: ${dirname(path)}`);
  }
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function readEventFile(path: string, size: number): unknown | undefined {
  if (size > MAX_EVENT_BYTES) return undefined;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_EVENT_BYTES || stats.size !== size) return undefined;
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytes === 0) throw new Error('diagnostic outbox entry changed while being read');
      offset += bytes;
    }
    try {
      return JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
  } finally {
    closeSync(descriptor);
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export class DiagnosticOutbox {
  private readonly directory: string;
  private dropped = 0;

  constructor(dataDir: string, destination: string) {
    if (destination.length === 0) throw new Error('diagnostic outbox destination is empty');
    const destinationHash = createHash('sha256').update(destination, 'utf8').digest('hex').slice(0, 16);
    const parent = resolve(dataDir, DIRECTORY_NAME);
    this.directory = join(parent, destinationHash);
    ensureDirectory(parent);
    ensureDirectory(this.directory);
  }

  get droppedCount(): number {
    return this.dropped;
  }

  add(input: OutboxEvent): void {
    const event = OutboxEventSchema.parse(input);
    const contents = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(contents, 'utf8');
    if (size > MAX_EVENT_BYTES) throw new Error('diagnostic event exceeds 32 KiB');
    this.ensure();

    const finalPath = join(this.directory, `${event.uuid}.json`);
    const temporaryPath = join(this.directory, `.tmp-${event.uuid}-${randomUUID()}.json`);
    const buffer = Buffer.from(contents, 'utf8');
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      linkSync(temporaryPath, finalPath);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      remove(temporaryPath);
    }
    this.loadAndClean();
  }

  pending(limit: number): OutboxEvent[] {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError('diagnostic outbox limit must be a non-negative integer');
    return this.loadAndClean().slice(0, limit).map(({ path: _path, size: _size, fileTimeMs: _fileTimeMs, ...event }) => event);
  }

  acknowledge(uuid: string): void {
    if (!z.string().uuid().safeParse(uuid).success) throw new Error('diagnostic outbox acknowledgment UUID is invalid');
    this.ensure();
    const path = join(this.directory, `${uuid}.json`);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('diagnostic outbox acknowledgment target is invalid');
    remove(path);
  }

  private ensure(): void {
    ensureDirectory(dirname(this.directory));
    ensureDirectory(this.directory);
  }

  private loadAndClean(): StoredEvent[] {
    this.ensure();
    const cutoff = Date.now() - RETENTION_MS;
    const events: StoredEvent[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      let stats;
      try {
        stats = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (stats.isSymbolicLink()) {
        remove(path);
        this.dropped += 1;
        continue;
      }
      if (TEMP_FILE.test(entry.name)) {
        if (stats.mtimeMs < Date.now() - 60_000) remove(path);
        continue;
      }
      if (!stats.isFile()) throw new Error('diagnostic outbox contains an unexpected directory entry');

      let event: ValidOutboxEvent | null = null;
      try {
        if (UUID_FILE.test(entry.name)) {
          const parsed = OutboxEventSchema.safeParse(readEventFile(path, stats.size));
          event = parsed.success ? parsed.data : null;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        remove(path);
        this.dropped += 1;
        continue;
      }
      const uuid = entry.name.slice(0, -'.json'.length);
      if (event === null || event.uuid !== uuid || stats.size > MAX_EVENT_BYTES || Date.parse(event.timestamp) < cutoff) {
        remove(path);
        this.dropped += 1;
        continue;
      }
      events.push({ ...event, path, size: stats.size, fileTimeMs: stats.mtimeMs });
    }

    events.sort((first, second) =>
      Date.parse(first.timestamp) - Date.parse(second.timestamp)
      || first.fileTimeMs - second.fileTimeMs
      || first.uuid.localeCompare(second.uuid));
    let totalBytes = events.reduce((total, event) => total + event.size, 0);
    while (events.length > MAX_EVENTS || totalBytes > MAX_TOTAL_BYTES) {
      const oldest = events.shift();
      if (oldest === undefined) break;
      totalBytes -= oldest.size;
      remove(oldest.path);
      this.dropped += 1;
    }
    return events;
  }
}
