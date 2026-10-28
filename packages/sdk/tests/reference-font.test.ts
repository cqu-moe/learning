import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReferenceFont } from '../src/runtime/node/reference-font.js';

const source = vi.hoisted(() => ({ url: 'https://raw.githubusercontent.com/example/pinned/font.otf', filename: 'reference.otf', bytes: 14, sha256: '' }));
vi.mock('../src/runtime/node/reference-font-source.js', () => ({ REFERENCE_FONT: source }));
const bytes = Buffer.from('reference-font');
source.sha256 = createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'font-cache-')); roots.push(path); return path; }

it('downloads a pinned reference without credentials, verifies it, and reuses the cache offline', async () => {
  const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
  const dir = await directory();
  expect(await loadReferenceFont({ directory: dir })).toEqual(bytes);
  expect(fetch).toHaveBeenCalledWith(source.url, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  expect(await readFile(join(dir, source.filename))).toEqual(bytes);
  fetch.mockRejectedValue(new Error('offline'));
  expect(await loadReferenceFont({ directory: dir })).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not use a corrupt cache or publish an unverified response, and can retry', async () => {
  const dir = await directory();
  await writeFile(join(dir, source.filename), 'invalid');
  const fetch = vi.fn(async () => new Response('tampered-font!')); vi.stubGlobal('fetch', fetch);
  await expect(loadReferenceFont({ directory: dir })).rejects.toMatchObject({ data: { code: 'INTEGRITY' } });
  expect(await readFile(join(dir, source.filename), 'utf8')).toBe('invalid');
  fetch.mockImplementation(async () => new Response(bytes));
  expect(await loadReferenceFont({ directory: dir })).toEqual(bytes);
});

it('rejects a cache symlink and cancellation before any network request', async () => {
  const dir = await directory(); const target = join(dir, 'external');
  await writeFile(target, bytes); await symlink(target, join(dir, source.filename));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(loadReferenceFont({ directory: dir })).rejects.toMatchObject({ data: { code: 'INTEGRITY' } });
  await expect(loadReferenceFont({ directory: dir, signal: AbortSignal.abort() })).rejects.toMatchObject({ data: { code: 'CANCELED' } });
  expect(fetch).not.toHaveBeenCalled();
});
