import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStateStore } from '@learning/sdk/node';
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
  it('requires initialization before adding a profile', () => {
    const dir = home();
    const add = run(dir, 'profile', 'add', 'alpha', '--platform', 'ykt', '--json');
    expect(add.code).toBe(3);
    expect(existsSync(resolve(dir, 'master.key'))).toBe(false);
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
    expect(run(dir, 'profile', 'add', 'chaoxing', '--platform', 'chaoxing', '--json').code).toBe(0);
    const listed = run(dir, 'profile', 'list', '--json');
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).data.profiles.map((profile: { name: string }) => profile.name)).toEqual(['alpha', 'chaoxing']);
    expect(listed.stdout).not.toContain('cookie');
    expect(run(dir, 'profile', 'remove', 'alpha').code).toBe(3);
    expect(run(dir, 'profile', 'remove', 'alpha', '--yes').code).toBe(0);
    expect(run(dir, 'profile', 'remove', 'chaoxing', '--yes').code).toBe(0);
    expect(JSON.parse(run(dir, 'profile', 'list', '--json').stdout).data).toEqual({ profiles: [] });
  });

  it('removes profile-owned jobs, metadata, inputs and cached catalog records', async () => {
    const dir = home();
    expect(run(dir, 'init').code).toBe(0);
    const created = JSON.parse(run(dir, 'profile', 'add', 'alpha', '--platform', 'ykt', '--json').stdout).data as { scope: { userId: string; profileId: string; platform: 'ykt' } };
    const scope = created.scope;
    const course = { ref: { scope, key: 'course', native: { kind: 'ykt', classroomId: '1' } }, title: 'course', system: null, term: null, teachers: [], locked: null };
    const resource = { course: course.ref, key: 'resource', native: { kind: 'ykt', leafId: '2', leafInfoId: null } };
    const job = { id: 'job-owned', scope, kind: 'export', status: 'paused', createdAtMs: 1, updatedAtMs: 1, nextRunAtMs: null, completed: 0, total: 1, items: [], warnings: [] };
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const records: [string, Json][] = [
      ['job:job-owned', job], ['job-meta:job-owned', { inputDigest: 'x', generation: 1, cursor: null, pendingOperationId: null, running: false }],
      ['job-input:job-owned', { type: 'media', resources: [resource], quality: 'best', subtitles: false }], ['job-events:job-owned', []],
      ['cli:course:course', course], ['cli:resource:resource', resource], ['cli:resource-kind:resource', 'video'],
    ];
    expect(await state.commit({ expected: records.map(([key]) => ({ key, revision: null })), changes: records.map(([key, value]) => ({ key, value })) })).toBe(true);
    state.close();
    expect(run(dir, 'profile', 'remove', 'alpha', '--yes').code).toBe(0);
    const reopened = new SqliteStateStore(resolve(dir, 'state.db'));
    for (const [key] of records) expect(await reopened.get(key)).toBeNull();
    reopened.close();
  });
});
