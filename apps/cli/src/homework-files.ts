import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AssessmentSchema, CourseSchema, HOMEWORK_MANIFEST_MIME, ResourceRefSchema, safeFilename } from '@learning/sdk';
import type { Artifact, Assessment, Course, Job, Scope } from '@learning/sdk/public';
import type { CliRuntime } from './context.js';
import { CliError } from './output.js';

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ITEM_BYTES = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

interface VerifiedArtifact {
  artifact: Artifact;
  bytes: Uint8Array;
}

interface HomeworkArtifacts {
  manifest: VerifiedArtifact;
  markdown: VerifiedArtifact;
  draft: VerifiedArtifact;
  images: VerifiedArtifact[];
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.userId === right.userId && left.profileId === right.profileId && left.platform === right.platform;
}

function shortHash(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 12);
}

function segment(value: string, fallback: string): string {
  const safe = safeFilename(value).split('').filter(char => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f).join('').trim().slice(0, 64);
  return safe === '' ? fallback : safe;
}

function isRealDirectory(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return info.isDirectory() && !info.isSymbolicLink();
}

function isRealFile(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return info.isFile() && !info.isSymbolicLink();
}

async function ensureRealDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!isRealDirectory(info)) throw new Error(`output path is not a real directory: ${current}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
  for (const part of missing.reverse()) {
    const next = join(current, part);
    await mkdir(next, { mode: 0o700 });
    const info = await lstat(next);
    if (!isRealDirectory(info)) throw new Error(`output path changed while creating directory: ${next}`);
    current = next;
  }
}

function artifactLimit(mimeType: string): number {
  if (mimeType === HOMEWORK_MANIFEST_MIME) return MAX_MANIFEST_BYTES;
  if (mimeType === 'text/markdown') return MAX_MARKDOWN_BYTES;
  if (mimeType === 'application/yaml') return MAX_DRAFT_BYTES;
  if (IMAGE_EXTENSIONS[mimeType] !== undefined) return MAX_IMAGE_BYTES;
  throw new Error('homework item contains an unsupported artifact type');
}

async function readArtifact(runtime: CliRuntime, job: Job, artifact: Artifact, remainingBytes: number): Promise<VerifiedArtifact> {
  if (!sameScope(artifact.scope, job.scope)) throw new Error('homework artifact scope differs from job scope');
  if (!/^[^/\\]+$/.test(artifact.filename) || artifact.filename === '.' || artifact.filename === '..') throw new Error('unsafe homework artifact filename');
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error('invalid homework artifact length');
  const limit = artifactLimit(artifact.mimeType);
  if (artifact.bytes > limit) throw new Error(`homework artifact exceeds ${Math.floor(limit / 1024 / 1024)}MiB limit`);
  if (artifact.bytes > remainingBytes) throw new Error('homework item exceeds 64MiB limit');

  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let bytes = 0;
  const signal = runtime.output?.signal;
  checkCanceled(runtime);
  const reader = (await runtime.artifacts.open(artifact.id, signal === undefined ? undefined : { signal })).getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new CliError('CANCELED', '已取消作业文件导出。', 3);
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > artifact.bytes) throw new Error(`homework artifact length mismatch: ${artifact.id}`);
      chunks.push(value);
      hash.update(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new Error(`homework artifact digest mismatch: ${artifact.id}`);
  const total = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { artifact, bytes: total };
}

function classify(artifacts: VerifiedArtifact[]): HomeworkArtifacts {
  const manifests = artifacts.filter(item => item.artifact.mimeType === HOMEWORK_MANIFEST_MIME);
  const markdown = artifacts.filter(item => item.artifact.mimeType === 'text/markdown');
  const drafts = artifacts.filter(item => item.artifact.mimeType === 'application/yaml');
  const images = artifacts.filter(item => item.artifact.mimeType.startsWith('image/'));
  if (manifests.length !== 1 || markdown.length !== 1 || drafts.length !== 1) {
    throw new Error('homework item must contain one manifest, one markdown file, and one draft');
  }
  for (const image of images) {
    const extension = IMAGE_EXTENSIONS[image.artifact.mimeType];
    if (extension === undefined || image.artifact.filename !== `${image.artifact.sha256}.${extension}`) {
      throw new Error(`invalid homework image artifact: ${image.artifact.id}`);
    }
  }
  return { manifest: manifests[0]!, markdown: markdown[0]!, draft: drafts[0]!, images };
}

function parseManifest(item: VerifiedArtifact, job: Job): Assessment {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(item.bytes));
  } catch (error) {
    throw new Error('homework manifest is not valid UTF-8 JSON', { cause: error });
  }
  const assessment = AssessmentSchema.parse(value);
  const owner = assessment.ref.resource.course.scope;
  if (assessment.ref.kind !== 'homework' || owner.platform !== 'ykt' || !sameScope(owner, job.scope)) {
    throw new Error('homework manifest identity differs from job scope');
  }
  return assessment;
}

async function cachedCourse(runtime: CliRuntime, key: string, scope: Scope): Promise<Course | null> {
  const stored = await runtime.state.get(`cli:course:${key}`);
  if (stored === null) return null;
  const course = CourseSchema.parse(stored.value);
  if (!sameScope(course.ref.scope, scope)) throw new Error('course cache scope differs from homework');
  return course;
}

async function layout(runtime: CliRuntime, assessment: Assessment): Promise<string[]> {
  const courseRef = assessment.ref.resource.course;
  const course = await cachedCourse(runtime, courseRef.key, courseRef.scope);
  const resource = ResourceRefSchema.parse((await runtime.state.get(`cli:resource:${assessment.ref.resource.key}`))?.value ?? assessment.ref.resource);
  if (!sameScope(resource.course.scope, courseRef.scope) || resource.course.key !== courseRef.key) throw new Error('resource cache identity differs from homework');

  const title = (await runtime.state.get(`cli:resource-title:${assessment.ref.resource.key}`))?.value;
  const rawPath = (await runtime.state.get(`cli:resource-path:${assessment.ref.resource.key}`))?.value;
  const path = Array.isArray(rawPath) && rawPath.every(item => typeof item === 'string') ? rawPath as string[] : [];
  const courseName = course === null
    ? `course-${shortHash(courseRef.key)}`
    : `${segment(course.title, 'course')}-${shortHash(courseRef.key)}`;
  const homework = `${segment(typeof title === 'string' && title !== '' ? title : assessment.title, assessment.ref.assessmentId)}-${shortHash(courseRef.scope.profileId, courseRef.key, assessment.ref.resource.key, assessment.ref.assessmentId)}`;
  return [
    `account-${shortHash(courseRef.scope.userId, courseRef.scope.profileId, courseRef.scope.platform)}`,
    courseName,
    ...path.map((item, index) => `${segment(item, `chapter-${index + 1}`)}-${shortHash(courseRef.key, String(index), path.slice(0, index + 1).join('\n'))}`),
    homework,
  ];
}

async function readBoundedRealFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!isRealFile(info) || info.size > maxBytes) throw new Error(`unsafe or oversized homework file: ${path}`);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead <= 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) throw new Error(`incomplete homework file: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readPreviousManifest(path: string, assessment: Assessment): Promise<Assessment | null> {
  const hiddenInfo = await lstat(join(path, '.hidden')).catch(() => null);
  if (hiddenInfo === null) return null;
  if (!isRealDirectory(hiddenInfo)) throw new Error('homework version directory is a symbolic link');
  const manifestPath = join(path, '.hidden', 'manifest.json');
  const receiptPath = join(path, '.hidden', 'manifest.sha256');
  const [manifestInfo, receiptInfo] = await Promise.all([
    lstat(manifestPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }),
    lstat(receiptPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    }),
  ]);
  if (manifestInfo === null || receiptInfo === null) return null;
  if (!isRealFile(manifestInfo) || manifestInfo.size > MAX_MANIFEST_BYTES) return null;
  if (!isRealFile(receiptInfo) || receiptInfo.size > 100) return null;
  const [manifest, receiptBuffer] = await Promise.all([readBoundedRealFile(manifestPath, MAX_MANIFEST_BYTES), readBoundedRealFile(receiptPath, 100)]);
  const receipt = receiptBuffer.toString('utf8');
  if (receipt.trim() !== createHash('sha256').update(manifest).digest('hex')) return null;
  let previous: unknown;
  try {
    previous = JSON.parse(new TextDecoder().decode(manifest));
  } catch {
    return null;
  }
  const old = AssessmentSchema.parse(previous).ref;
  const next = assessment.ref;
  return old.assessmentId === next.assessmentId && old.resource.key === next.resource.key && sameScope(old.resource.course.scope, next.resource.course.scope) ? AssessmentSchema.parse(previous) : null;
}

async function safelyUpdatable(path: string): Promise<boolean> {
  try {
    for (const name of ['题面.md', 'answers.yaml']) {
      const target = join(path, name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) return false;
    }
    const assets = join(path, 'assets');
    const info = await lstat(assets);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const entries = await readdir(assets, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory() && !await safelyUpdatable(join(assets, entry.name))) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function targetDirectory(runtime: CliRuntime, base: string, assessment: Assessment): Promise<{ path: string; changed: boolean }> {
  let changed = false;
  let conflict = false;
  for (let version = 1; ; version++) {
    const path = version === 1 ? base : `${base}.v${version}`;
    let exists = true;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('homework output path is not a real directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) {
      if (conflict) await runtime.output?.warning('HOMEWORK_PUBLISH_CONFLICT', '本地作业文件缺少可验证版本记录，已改用新的安全目录。');
      if (changed) await runtime.output?.warning('HOMEWORK_VERSION_CHANGED', '作业题目或选项已变化，已保留旧答案并写入新版本。');
      return { path, changed };
    }
    const previous = await readPreviousManifest(path, assessment);
    if (previous !== null && previous.fingerprint === assessment.fingerprint && await safelyUpdatable(path)) {
      if (changed) await runtime.output?.warning('HOMEWORK_VERSION_CHANGED', '作业题目或选项已变化，已保留旧答案并写入新版本。');
      return { path, changed };
    }
    if (previous !== null && previous.fingerprint !== assessment.fingerprint) changed = true;
    else conflict = true;
  }
}

async function writeAtomic(path: string, bytes: Uint8Array, replace: boolean): Promise<boolean> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
      const result = await handle.write(chunk);
      if (result.bytesWritten <= 0) throw new Error('homework file write made no progress');
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    const info = await lstat(path).catch(() => null);
    if (info === null) {
      try {
        await link(temporary, path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return false;
      }
    }
    if (!replace || info.isSymbolicLink() || !info.isFile()) return false;
    await rename(temporary, path);
    return true;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function existingFileMatches(path: string, expected: VerifiedArtifact): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!isRealFile(info)) return false;
    if (info.size !== expected.artifact.bytes) return false;
    const bytes = await readBoundedRealFile(path, expected.artifact.bytes);
    return bytes.length === expected.artifact.bytes && createHash('sha256').update(bytes).digest('hex') === expected.artifact.sha256;
  } catch {
    return false;
  }
}

function checkCanceled(runtime: CliRuntime): void {
  if (runtime.output?.signal.aborted) throw new CliError('CANCELED', '已取消作业文件导出。', 3);
}

export function isHomeworkBundle(job: Job): boolean {
  return job.items.some(item => item.artifacts.some(artifact => artifact.mimeType === HOMEWORK_MANIFEST_MIME));
}

export async function publishHomeworkFiles(runtime: CliRuntime, job: Job, outputRoot: string): Promise<string[]> {
  if (!isHomeworkBundle(job)) return [];
  const root = resolve(outputRoot);
  let rootReady = false;
  const paths: string[] = [];
  for (const item of job.items) {
    checkCanceled(runtime);
    if (item.artifacts.length === 0) continue;
    let remainingBytes = MAX_ITEM_BYTES;
    const verified: VerifiedArtifact[] = [];
    for (const artifact of item.artifacts) {
      const value = await readArtifact(runtime, job, artifact, remainingBytes);
      verified.push(value);
      remainingBytes -= value.artifact.bytes;
    }
    const files = classify(verified);
    const assessment = parseManifest(files.manifest, job);
    if (!rootReady) {
      await ensureRealDirectory(root);
      rootReady = true;
    }
    const target = (await targetDirectory(runtime, join(root, ...(await layout(runtime, assessment))), assessment)).path;
    await ensureRealDirectory(target);
    await ensureRealDirectory(join(target, '.hidden'));
    await ensureRealDirectory(join(target, 'assets'));

    const manifestPath = join(target, '.hidden', 'manifest.json');
    if (await readPreviousManifest(target, assessment)?.then(value => value === null || value.fingerprint !== assessment.fingerprint)) {
      const manifest = files.manifest.bytes;
      await writeAtomic(manifestPath, manifest, true);
      await writeAtomic(join(target, '.hidden', 'manifest.sha256'), new TextEncoder().encode(`${createHash('sha256').update(manifest).digest('hex')}\n`), true);
    }

    const draftPath = join(target, 'answers.yaml');
    if (!await writeAtomic(draftPath, files.draft.bytes, false) && !isRealFile(await lstat(draftPath))) throw new Error('existing homework draft is not a regular file');
    const markdownPath = join(target, '题面.md');
    if (!await writeAtomic(markdownPath, files.markdown.bytes, true) && !await existingFileMatches(markdownPath, files.markdown)) throw new Error('existing homework markdown conflicts with verified artifact');
    paths.push(markdownPath, draftPath);
    for (const image of files.images) {
      checkCanceled(runtime);
      const extension = IMAGE_EXTENSIONS[image.artifact.mimeType]!;
      const imagePath = join(target, 'assets', `${image.artifact.sha256}.${extension}`);
      if (!await writeAtomic(imagePath, image.bytes, true) && !await existingFileMatches(imagePath, image)) throw new Error('existing homework image conflicts with verified artifact');
      if (!paths.includes(imagePath)) paths.push(imagePath);
    }
  }
  return paths;
}
