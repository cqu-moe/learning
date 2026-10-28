import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeArtifactStore, SqliteStateStore } from '@learning/sdk/node';
import type { Json } from '@learning/sdk/public';

const cli = resolve(import.meta.dirname, '../dist/index.js');
const homes: string[] = [];

function home(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'learning-profile-'));
  homes.push(dir);
  return dir;
}

function run(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, '--home', dir, ...args], {
    cwd: dir,
    env: { ...process.env, LEARNING_HOME: resolve(dir, 'ignored-env') },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

describe('local profiles', () => {
  it('reopens an initialized directory without replacing its master key', () => {
    const dir = home();
    expect(run(dir, 'init').code).toBe(0);
    const key = readFileSync(resolve(dir, 'master.key'));
    expect(run(dir, 'init').code).toBe(0);
    expect(readFileSync(resolve(dir, 'master.key')).equals(key)).toBe(true);
    const listed = run(dir, 'profile', 'list', '--json');
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).data).toEqual({ profiles: [] });
  });

  it('requires initialization before adding a profile', () => {
    const dir = home();
    const add = run(dir, 'profile', 'add', 'alpha', '--platform', 'ykt', '--json');
    expect(add.code).toBe(3);
    expect(existsSync(resolve(dir, 'master.key'))).toBe(false);
  });

  it('requires explicit profile creation inputs without creating storage', () => {
    const dir = home();
    expect(run(dir, 'init').code).toBe(0);
    expect(run(dir, 'profile', 'add', '--json').code).toBe(2);
    expect(run(dir, 'profile', 'add', 'alpha', '--json').code).toBe(2);
    expect(run(dir, 'profile', 'add', 'alpha', '--platform', 'ykt', '--json').code).toBe(0);
  });

  it('adds, lists and removes a stable profile without leaking sessions', () => {
    const dir = home();
    expect(run(dir, 'init').code).toBe(0);
    const add = run(dir, 'profile', 'add', 'alpha', '--platform', 'ykt', '--json');
    expect(add.code).toBe(0);
    const created = JSON.parse(add.stdout).data as { name: string; scope: { profileId: string; platform: string; userId: string } };
    expect(created.name).toBe('alpha');
    expect(created.scope).toMatchObject({ platform: 'ykt', userId: 'local' });
    expect(created.scope.profileId).toBeTruthy();
    expect(run(dir, 'profile', 'add', 'alpha', '--platform', 'zhs').code).toBe(2);
    const listed = run(dir, 'profile', 'list', '--json');
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).data).toEqual({ profiles: [created] });
    expect(listed.stdout).not.toContain('cookie');
    expect(run(dir, 'profile', 'remove', 'alpha').code).toBe(3);
    expect(run(dir, 'profile', 'remove', 'alpha', '--yes').code).toBe(0);
    expect(JSON.parse(run(dir, 'profile', 'list', '--json').stdout).data).toEqual({ profiles: [] });
  });

  it('removes profile-owned jobs, metadata, inputs and cached catalog records without touching another profile', async () => {
    const dir = home();
    expect(run(dir, 'init').code).toBe(0);
    const created = JSON.parse(run(dir, 'profile', 'add', 'alpha', '--platform', 'ykt', '--json').stdout).data as { scope: { userId: string; profileId: string; platform: 'ykt' } };
    const other = JSON.parse(run(dir, 'profile', 'add', 'beta', '--platform', 'ykt', '--json').stdout).data as { scope: { userId: string; profileId: string; platform: 'ykt' } };
    const scope = created.scope;
    const course = { ref: { scope, key: 'course', native: { kind: 'ykt', classroomId: '1' } }, title: 'course', system: null, term: null, teachers: [], locked: null };
    const resource = { course: course.ref, key: 'resource', native: { kind: 'ykt', leafId: '2', leafInfoId: null } };
    const otherCourse = { ref: { scope: other.scope, key: 'other-course', native: { kind: 'ykt', classroomId: '4' } }, title: 'other course', system: null, term: null, teachers: [], locked: null };
    const otherResource = { course: otherCourse.ref, key: 'other-resource', native: { kind: 'ykt', leafId: '3', leafInfoId: null } };
    const fullResource = { ref: resource, title: '第一讲', kind: 'video', path: ['course'], order: 1, durationSeconds: null, locked: false };
    const otherFullResource = { ...fullResource, ref: otherResource };
    const lesson = { ref: { scope, course: course.ref, lessonId: 'lesson-owned' }, title: '第一课', startsAtMs: null, finished: null };
    const otherLesson = { ...lesson, ref: { ...lesson.ref, scope: other.scope, course: otherCourse.ref, lessonId: 'lesson-other' } };
    const artifact = { id: 'artifact-owned', scope, filename: 'owned.txt', mimeType: 'text/plain', bytes: 3, sha256: 'a'.repeat(64), createdAtMs: 1 };
    const job = { id: 'job-owned', scope, kind: 'export', status: 'paused', createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: null, completed: 1, total: 1, items: [{ key: 'resource', state: 'succeeded', message: null, artifacts: [artifact] }], warnings: [] };
    const preview = { id: 'preview-owned', scope, kind: 'study', digest: 'digest', generation: 1, expiresAtMs: 2, description: 'study', startsTimer: false, finalSubmission: false, blockers: [], warnings: [] };
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const records: [string, Json][] = [
      ['job:job-owned', job], ['job-meta:job-owned', { inputDigest: 'x', generation: 1, cursor: null, pendingOperationId: null, running: false }],
      ['job-input:job-owned', { type: 'media', resources: [resource], quality: 'best', subtitles: false }], ['job-events:job-owned', []],
      ['cli:course:course', course], ['cli:resource:resource', resource], ['cli:resource-kind:resource', 'video'], ['cli:resource-title:resource', '第一讲'], ['cli:resource-path:resource', ['course']],
      ['cli:course:other-course', otherCourse], ['cli:resource:other-resource', otherResource], ['cli:resource-path:other-resource', ['other-course']],
      ['web:resource:resource', fullResource], ['web:resource:other-resource', otherFullResource],
      ['web:lesson:course:lesson-owned', lesson], ['web:lesson:other-course:lesson-other', otherLesson],
      ['preview:preview-owned', { preview, operationId: 'operation-owned', phase: 'preview', receipt: null, inputCiphertext: 'ciphertext' }],
      ['operation:operation-owned', 'preview-owned'],
      ['download:job-owned:resource', { url: 'https://example.test/video', validator: null, bytes: 0, checkpoint: { id: 'job-owned:resource:media', bytes: 0, sha256: 'a'.repeat(64) } }],
      ['cli:preferences', { version: 1, defaultProfileId: scope.profileId, downloadDir: '/tmp/learning-exports' }],
    ];
    expect(await state.commit({ expected: records.map(([key]) => ({ key, revision: null })), changes: records.map(([key, value]) => ({ key, value })) })).toBe(true);
    const artifacts = new NodeArtifactStore(resolve(dir, 'artifacts'));
    for (const id of [artifact.id, 'job-owned:resource:media', 'artifact-other']) {
      const writer = await artifacts.create({ id, mimeType: 'text/plain' });
      await writer.write(new TextEncoder().encode('abc'));
      await writer.finish();
    }
    state.close();
    expect(run(dir, 'profile', 'remove', 'alpha', '--yes').code).toBe(0);
    const reopened = new SqliteStateStore(resolve(dir, 'state.db'));
    for (const [key] of records.filter(([key]) => !key.includes('other-') && key !== 'cli:preferences')) expect(await reopened.get(key)).toBeNull();
    expect(await reopened.get('cli:course:other-course')).not.toBeNull();
    expect(await reopened.get('cli:resource:other-resource')).not.toBeNull();
    expect(await reopened.get('cli:resource-path:other-resource')).not.toBeNull();
    expect(await reopened.get('web:resource:other-resource')).not.toBeNull();
    expect(await reopened.get('web:lesson:other-course:lesson-other')).not.toBeNull();
    expect(await reopened.get('operation:operation-owned')).toBeNull();
    expect(await reopened.get('download:job-owned:resource')).toBeNull();
    expect(await reopened.get('cli:preferences')).toMatchObject({ value: { version: 1, defaultProfileId: null, downloadDir: '/tmp/learning-exports' } });
    reopened.close();
    const reopenedArtifacts = new NodeArtifactStore(resolve(dir, 'artifacts'));
    await expect(reopenedArtifacts.open(artifact.id)).rejects.toThrow();
    await expect(reopenedArtifacts.open('job-owned:resource:media')).rejects.toThrow();
    const preserved = await reopenedArtifacts.open('artifact-other');
    await preserved.cancel();
  });
});
