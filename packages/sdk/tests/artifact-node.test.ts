import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeArtifactStore } from '../src/runtime/node/artifacts.js';

const roots: string[] = [];
function temp() { const dir = mkdtempSync(resolve(tmpdir(), 'learning-artifacts-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('NodeArtifactStore', () => {
  it('resumes from a verified checkpoint and publishes once', async () => {
    const store = new NodeArtifactStore(temp());
    const writer = await store.create({ id: 'a:course/video', mimeType: 'video/mp4' });
    await writer.write(Buffer.from('hello'));
    const checkpoint = await writer.checkpoint();
    await writer.abort();
    const resumed = await store.resume({ id: 'a:course/video', checkpoint });
    await resumed.write(Buffer.from(' world'));
    const finished = await resumed.finish();
    expect(finished.bytes).toBe(11);
    expect(finished.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(await bytes(await store.open('a:course/video'))).toString()).toBe('hello world');
    await expect(store.create({ id: 'a:course/video', mimeType: 'video/mp4' })).rejects.toThrow();
  });

  it('rejects changed partial files and forged checkpoints', async () => {
    const store = new NodeArtifactStore(temp());
    const writer = await store.create({ id: '../escape', mimeType: 'text/plain' });
    await writer.write(Buffer.from('abc'));
    const checkpoint = await writer.checkpoint();
    await writer.abort();
    if (checkpoint === null || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new Error('checkpoint is not an object');
    await expect(store.resume({ id: '../escape', checkpoint: { ...checkpoint, sha256: '0'.repeat(64) } })).rejects.toThrow();
    await expect(store.open('../escape')).rejects.toThrow();
  });

  it('can explicitly roll back uncommitted segment bytes to a verified checkpoint', async () => {
    const store = new NodeArtifactStore(temp());
    const writer = await store.create({ id: 'hls-segments', mimeType: 'video/mp2t' });
    await writer.write(Buffer.from('AAA'));
    const checkpoint = await writer.checkpoint();
    await writer.write(Buffer.from('incomplete'));
    await writer.abort();
    await expect(store.resume({ id: 'hls-segments', checkpoint })).rejects.toThrow(/length/);
    const resumed = await store.resume({ id: 'hls-segments', checkpoint, truncateUncommitted: true });
    await resumed.write(Buffer.from('BBB'));
    expect((await resumed.finish()).bytes).toBe(6);
    expect(Buffer.from(await bytes(await store.open('hls-segments'))).toString()).toBe('AAABBB');
  });
});
