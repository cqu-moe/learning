import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Artifact, Assessment, Job } from '@learning/sdk/public';
import { CourseSchema } from '@learning/sdk/public';
import { createCliRuntime } from '../src/runtime.js';
import type { CliRuntime } from '../src/context.js';
import { isHomeworkBundle, publishHomeworkFiles } from '../src/homework-files.js';

const roots: string[] = [];
const runtimes: CliRuntime[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'homework-files-'));
  roots.push(dir);
  return dir;
}

function runtime(): CliRuntime {
  const value = createCliRuntime(temp());
  runtimes.push(value);
  return value;
}

function scope(profileId: string) {
  return { userId: `user-${profileId}`, profileId, platform: 'ykt' as const };
}

function assessment(profileId: string, fingerprint: string): Assessment {
  const owner = scope(profileId);
  return {
    ref: {
      resource: {
        course: { scope: owner, key: `course-${profileId}`, native: { kind: 'ykt', classroomId: '100' } },
        key: `resource-${profileId}`,
        native: { kind: 'ykt', leafId: '200', leafInfoId: null },
      },
      kind: 'homework',
      assessmentId: '300',
    },
    title: '同名作业',
    state: 'not-started',
    timed: null,
    fingerprint,
    questions: [{
      id: 'q1',
      kind: 'single-choice',
      rawType: '1',
      body: { markdown: '题面', plainText: '题面', decodeState: 'not-needed', sourceHash: 'a'.repeat(64) },
      options: [{ key: 'A', body: { markdown: 'A', plainText: 'A', decodeState: 'not-needed', sourceHash: 'b'.repeat(64) } }],
      fingerprint: 'q1',
      attemptsUsed: null,
      maxAttempts: null,
      myAnswer: null,
      feedback: null,
    }],
  };
}

async function artifact(runtime: CliRuntime, id: string, mimeType: string, data: Uint8Array | string, filename: string): Promise<Artifact> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const writer = await runtime.artifacts.create({ id, mimeType });
  await writer.write(bytes);
  const result = await writer.finish();
  return { id, scope: { userId: 'user-p1', profileId: 'p1', platform: 'ykt' }, filename, mimeType, bytes: result.bytes, sha256: result.sha256, createdAtMs: 0 };
}

async function bundle(
  runtime: CliRuntime,
  jobId: string,
  value: Assessment,
  markdown: string,
  answer: string,
  image = new Uint8Array([1, 2, 3]),
): Promise<Job> {
  const imageSha = createHash('sha256').update(image).digest('hex');
  const owner = value.ref.resource.course.scope;
  const metadata = <T extends Artifact>(item: T): T => ({ ...item, scope: owner });
  const [manifest, surface, draft, asset] = await Promise.all([
    artifact(runtime, `${jobId}:manifest`, 'application/vnd.learning.homework+json', JSON.stringify(value), 'manifest.json'),
    artifact(runtime, `${jobId}:markdown`, 'text/markdown', markdown, 'homework.md'),
    artifact(runtime, `${jobId}:draft`, 'application/yaml', answer, 'answers.yaml'),
    artifact(runtime, `${jobId}:image`, 'image/png', image, `${imageSha}.png`),
  ]);
  return {
    id: jobId,
    scope: owner,
    kind: 'export',
    status: 'succeeded',
    createdAtMs: 0,
    updatedAtMs: 0,
    nextRunAtMs: null,
    completed: 1,
    total: 1,
    items: [{ key: value.ref.resource.key, state: 'succeeded', message: null, artifacts: [metadata(manifest), metadata(surface), metadata(draft), metadata(asset)] }],
    warnings: [],
  };
}

async function cacheLayout(runtime: CliRuntime, value: Assessment, path: string[]): Promise<void> {
  const owner = value.ref.resource.course.scope;
  const course = CourseSchema.parse({ ref: value.ref.resource.course, title: '同名课程', system: null, term: null, teachers: [], locked: null });
  const values: Array<[string, unknown]> = [
    [`cli:course:${course.ref.key}`, course],
    [`cli:resource-title:${value.ref.resource.key}`, '第三章'],
    [`cli:resource-path:${value.ref.resource.key}`, path],
  ];
  for (const [key, stored] of values) {
    const existing = await runtime.state.get(key);
    expect(await runtime.state.commit({ expected: [{ key, revision: existing?.revision ?? null }], changes: [{ key, value: stored as never }] })).toBe(true);
  }
  void owner;
}

function visibleFiles(files: string[]): string[] {
  return files.map(file => basename(file)).sort();
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.state.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('homework file publishing', () => {
  it('publishes a course bundle, updates content, and preserves the edited draft', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const first = assessment('p1', 'a'.repeat(64));
    await cacheLayout(runtimeValue, first, ['第一章', '第二章']);
    const firstImageName = `${createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex')}.png`;
    const secondImageName = `${createHash('sha256').update(new Uint8Array([4, 5])).digest('hex')}.png`;
    const files = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-1', first, '# one\n', 'answers: []\n'), output);
    expect(visibleFiles(files)).toEqual([firstImageName, 'answers.yaml', '题面.md']);
    const homeworkDir = resolve(files[0]!, '..');
    const draft = join(homeworkDir, 'answers.yaml');
    writeFileSync(draft, 'answers: [A]\n');

    const second = await bundle(runtimeValue, 'job-2', { ...first, fingerprint: 'a'.repeat(64) }, '# one updated\n', 'answers: []\n', new Uint8Array([4, 5]));
    const updated = await publishHomeworkFiles(runtimeValue, second, output);
    expect(visibleFiles(updated)).toEqual([secondImageName, 'answers.yaml', '题面.md']);
    expect(updated.every(path => path.startsWith(homeworkDir))).toBe(true);
    await expect(readFile(draft, 'utf8')).resolves.toBe('answers: [A]\n');
  });

  it('keeps the old draft when the assessment fingerprint changes', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const first = assessment('p1', 'a'.repeat(64));
    await cacheLayout(runtimeValue, first, ['第一章']);
    const firstFiles = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-1', first, '# one\n', 'answers: old\n'), output);
    const firstDir = resolve(firstFiles.find(path => basename(path) === 'answers.yaml')!, '..');
    const second = { ...first, fingerprint: 'b'.repeat(64) };
    const files = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-2', second, '# two\n', 'answers: new\n'), output);
    const secondDir = resolve(files.find(path => basename(path) === 'answers.yaml')!, '..');
    const versions = new Set([firstDir, secondDir]);
    expect(versions.size).toBe(2);
    const drafts = await Promise.all([...versions].map(dir => readFile(join(dir, 'answers.yaml'), 'utf8')));
    expect(drafts.sort()).toEqual(['answers: new\n', 'answers: old\n']);
  });

  it('keeps unversioned local drafts and reuses a matching version directory', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const value = assessment('p1', 'a'.repeat(64));
    await cacheLayout(runtimeValue, value, ['第一章']);
    const first = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-1', value, '# one\n', 'answers: old\n'), output);
    const oldDir = resolve(first.find(path => basename(path) === 'answers.yaml')!, '..');
    rmSync(join(oldDir, '.hidden'), { recursive: true, force: true });
    writeFileSync(join(oldDir, 'answers.yaml'), 'answers: edited\n');

    const conflict = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-2', value, '# one\n', 'answers: retry\n'), output);
    const conflictDir = resolve(conflict.find(path => basename(path) === 'answers.yaml')!, '..');
    expect(conflictDir).not.toBe(oldDir);
    await expect(readFile(join(oldDir, 'answers.yaml'), 'utf8')).resolves.toBe('answers: edited\n');

    const changed = { ...value, fingerprint: 'b'.repeat(64) };
    const versioned = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-3', changed, '# two\n', 'answers: v2\n'), output);
    const versionDir = resolve(versioned.find(path => basename(path) === 'answers.yaml')!, '..');
    writeFileSync(join(versionDir, 'answers.yaml'), 'answers: edited v2\n');
    const repeated = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-4', changed, '# two\n', 'answers: v2\n'), output);
    expect(resolve(repeated.find(path => basename(path) === 'answers.yaml')!, '..')).toBe(versionDir);
    await expect(readFile(join(versionDir, 'answers.yaml'), 'utf8')).resolves.toBe('answers: edited v2\n');
  });

  it('separates profiles that share titles and resource IDs', async () => {
    const output = temp();
    const left = assessment('p1', 'a'.repeat(64));
    const right = { ...assessment('p2', 'a'.repeat(64)) };
    right.ref = { ...right.ref, resource: { ...right.ref.resource, course: { ...right.ref.resource.course, key: 'course-p2' }, key: 'resource-p2' } };
    const leftRuntime = runtime();
    const rightRuntime = runtime();
    await cacheLayout(leftRuntime, left, ['第一章']);
    await cacheLayout(rightRuntime, right, ['第一章']);
    const leftFiles = await publishHomeworkFiles(leftRuntime, await bundle(leftRuntime, 'job-left', left, '# left\n', 'answers: left\n'), output);
    const rightFiles = await publishHomeworkFiles(rightRuntime, await bundle(rightRuntime, 'job-right', right, '# right\n', 'answers: right\n'), output);
    expect(resolve(leftFiles[0]!, '..', '..')).not.toBe(resolve(rightFiles[0]!, '..', '..'));
  });

  it('puts homework in the same chapter directory while keeping distinct homework directories', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const first = assessment('p1', 'a'.repeat(64));
    const second = { ...first, ref: { ...first.ref, resource: { ...first.ref.resource, key: 'resource-other', native: { ...first.ref.resource.native, leafId: '201' } } } };
    await cacheLayout(runtimeValue, first, ['第一章', '第二节']);
    await cacheLayout(runtimeValue, second, ['第一章', '第二节']);
    const firstFiles = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-one', first, '# one\n', 'answers: one\n'), output);
    const secondFiles = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-two', second, '# two\n', 'answers: two\n'), output);
    const firstHomework = resolve(firstFiles[0]!, '..');
    const secondHomework = resolve(secondFiles[0]!, '..');
    expect(resolve(firstHomework, '..')).toBe(resolve(secondHomework, '..'));
    expect(firstHomework).not.toBe(secondHomework);
  });

  it('rejects a forged artifact digest before publishing', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const value = assessment('p1', 'a'.repeat(64));
    const job = await bundle(runtimeValue, 'job-bad', value, '# bad\n', 'answers: bad\n');
    job.items[0]!.artifacts[0] = { ...job.items[0]!.artifacts[0]!, sha256: '0'.repeat(64) };
    await expect(publishHomeworkFiles(runtimeValue, job, output)).rejects.toThrow(/digest/);
    await expect(readdir(output)).resolves.toEqual([]);
  });

  it('rejects an oversized draft before creating bundle files', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const job = await bundle(runtimeValue, 'job-large', assessment('p1', 'a'.repeat(64)), '# large\n', 'answers: large\n');
    const draft = job.items[0]!.artifacts.find(artifact => artifact.mimeType === 'application/yaml')!;
    job.items[0]!.artifacts = job.items[0]!.artifacts.map(artifact => artifact === draft ? { ...artifact, bytes: 4 * 1024 * 1024 + 1 } : artifact);
    await expect(publishHomeworkFiles(runtimeValue, job, output)).rejects.toThrow(/4MiB/);
    await expect(readdir(output)).resolves.toEqual([]);
  });

  it('confines unsafe chapter names and refuses an existing symlink in the path', async () => {
    const runtimeValue = runtime();
    const output = temp();
    const value = assessment('p1', 'a'.repeat(64));
    await cacheLayout(runtimeValue, value, ['../../outside']);
    const files = await publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-safe', value, '# safe\n', 'answers: safe\n'), output);
    expect(files.every(path => resolve(path).startsWith(resolve(output)))).toBe(true);

    const blocked = { ...value, ref: { ...value.ref, resource: { ...value.ref.resource, key: 'resource-blocked' } } };
    await cacheLayout(runtimeValue, blocked, ['chapter']);
    const outside = join(output, 'outside-target');
    mkdirSync(outside);
    const linkedOutput = join(output, 'root-link');
    symlinkSync(outside, linkedOutput, 'dir');
    await expect(publishHomeworkFiles(runtimeValue, await bundle(runtimeValue, 'job-link', blocked, '# link\n', 'answers: link\n'), linkedOutput)).rejects.toThrow(/real directory/);
  });

  it('detects homework bundles by manifest mime type', async () => {
    const runtimeValue = runtime();
    const job = await bundle(runtimeValue, 'job-type', assessment('p1', 'a'.repeat(64)), '# x\n', 'answers: []\n');
    expect(isHomeworkBundle(job)).toBe(true);
    expect(isHomeworkBundle({ ...job, items: job.items.map(item => ({ ...item, artifacts: [] })) })).toBe(false);
  });
});
