import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import { replay } from './helpers/replay.js';
import { createHash } from 'node:crypto';
import type { Runtime } from '../src/runtime/types.js';
import type { Scope } from '../src/types/refs.js';

const scope: Scope = { userId: 'local', profileId: 'one', platform: 'ykt' };
const other: Scope = { userId: 'local', profileId: 'two', platform: 'ykt' };

function runtime(): Runtime {
  return {
    transport: new FakeTransport(), state: new MemoryStateStore(), clock: new FakeClock(), masterKey: new Uint8Array(32),
    artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
    heavy: null, model: null, log: () => {}, wake: async () => {},
  };
}

describe('client jobs facade', () => {
  it('creates, lists, cancels and reads a saved export in its profile', async () => {
    const shared = runtime();
    const client = createLearningClient({ scope, runtime: shared });
    const ref = { course: { scope, key: 'course-one', native: { kind: 'ykt' as const, classroomId: '1' } }, key: 'resource-one', native: { kind: 'ykt' as const, leafId: '2', leafInfoId: null } };
    const job = await client.jobs.createExport({ type: 'media', resources: [ref], quality: 'best', subtitles: false });
    expect(job.kind).toBe('export');
    expect((await createLearningClient({ scope, runtime: shared }).jobs.get(job.id)).id).toBe(job.id);
    expect((await client.jobs.list()).items.map((item) => item.id)).toEqual([job.id]);
    expect((await client.jobs.cancel(job.id)).status).toBe('canceled');
    expect((await client.jobs.events(job.id, 0)).at(-1)?.type).toBe('state');
    const foreign = createLearningClient({ scope: other, runtime: shared });
    expect((await foreign.jobs.list()).items).toEqual([]);
    await expect(foreign.jobs.get(job.id)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  });

  it('rejects mixed-profile export input before storing a job', async () => {
    const client = createLearningClient({ scope, runtime: runtime() });
    const ref = { course: { scope: other, key: 'course-two', native: { kind: 'ykt' as const, classroomId: '1' } }, key: 'resource-two', native: { kind: 'ykt' as const, leafId: '2', leafInfoId: null } };
    await expect(client.jobs.createExport({ type: 'media', resources: [ref], quality: 'best', subtitles: false })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
    expect((await client.jobs.list()).items).toEqual([]);
  });

  it('advances a read-only assessment export into a verified local artifact', async () => {
    await replay('ykt/exam-read', async ({ transport }) => {
      const shared = runtime();
      shared.transport = transport;
      const bytes = new Map<string, Uint8Array>();
      shared.artifacts.create = async ({ id }) => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (chunk) => { chunks.push(chunk); }, checkpoint: async () => null, abort: async () => {},
          finish: async () => {
            const data = Buffer.concat(chunks);
            bytes.set(id, data);
            return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
          },
        };
      };
      const scoped: Scope = { ...scope, profileId: 'p1' };
      const client = createLearningClient({ scope: scoped, runtime: shared });
      const resource = { course: { scope: scoped, key: 'course', native: { kind: 'ykt' as const, classroomId: '28930736' } }, key: 'resource', native: { kind: 'ykt' as const, leafId: '510', leafInfoId: null } };
      const [ref] = await client.assessments.resolve(resource);
      expect(ref).toBeDefined();
      const job = await client.jobs.createExport({ type: 'assessments', refs: [ref!], format: 'json' });
      const done = await client.jobs.advance(job.id);
      expect(done.status).toBe('succeeded');
      expect(done.items[0]?.artifacts).toHaveLength(1);
      const artifact = done.items[0]!.artifacts[0]!;
      const data = bytes.get(artifact.id);
      expect(data?.byteLength).toBe(artifact.bytes);
      expect(JSON.parse(Buffer.from(data!).toString('utf8')).questions).toHaveLength(2);
      return done;
    });
  });
});
