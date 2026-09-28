import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStateStore } from '@learning/sdk/node';
import { ActionStore } from '../../../packages/sdk/src/services/actions.js';
import { readFileSync } from 'node:fs';

const cliEntry = resolve(import.meta.dirname, '../dist/index.js');
const tempRoots: string[] = [];

function runCli(args: string[], home = mkdtempSync(resolve(tmpdir(), 'learning-cmds-'))) {
  if (!tempRoots.includes(home)) tempRoots.push(home);
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, ...args, '--home', home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LEARNING_HOME: home } });
    return { stdout, stderr: '', exitCode: 0, home };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 1, home };
  }
}

afterAll(() => {
  for (const home of tempRoots) rmSync(home, { recursive: true, force: true });
});

describe('cli commands (T26, A261/A262)', () => {
  it('help lists the command groups', () => {
    const run = runCli(['--help']);
    expect(run.exitCode).toBe(0);
    for (const name of ['init', 'doctor', 'jobs', 'exam', 'run', 'download']) {
      expect(run.stdout).toContain(name);
    }
  });

  it('exam submit without --yes --final refuses with exit 2', () => {
    const run = runCli(['exam', 'submit', 'draft.yaml']);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('--yes --final');
  });

  it('run and download do not report success without an initialized course', () => {
    for (const args of [['run', '--dry-run'], ['download', '--dry-run']]) {
      const run = runCli(args);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
    }
    const pendingStudy = runCli(['run', 'course-key', '--dry-run']);
    expect(pendingStudy.exitCode).toBe(3);
    expect(pendingStudy.stdout).toBe('');
    expect(pendingStudy.stderr).toContain('尚未初始化');
    const uninitializedDownload = runCli(['download', 'course-key', '--dry-run']);
    expect(uninitializedDownload.exitCode).toBe(3);
    expect(uninitializedDownload.stdout).toBe('');
    expect(uninitializedDownload.stderr).toContain('尚未初始化');
    const init = runCli(['init']);
    expect(init.exitCode).toBe(0);
    expect(runCli(['profile', 'add', 'alpha', '--platform', 'ykt'], init.home).exitCode).toBe(0);
    const unknown = runCli(['download', 'course-key', '--dry-run'], init.home);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toBe('');
  });

  it('jobs list reads initialized local state and unknown reconcile fails', () => {
    const init = runCli(['init']);
    expect(init.exitCode).toBe(0);
    const list = runCli(['jobs', 'list', '--json'], init.home);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).data).toEqual([]);
    const rec = runCli(['jobs', 'reconcile', 'missing-job'], init.home);
    expect(rec.exitCode).not.toBe(0);
    expect(rec.stdout).toBe('');
  });

  it('jobs list returns persisted SDK job records instead of a fixed empty array', async () => {
    const init = runCli(['init']);
    expect(init.exitCode).toBe(0);
    const state = new SqliteStateStore(resolve(init.home, 'state.db'));
    const job = {
      id: 'job-persisted',
      scope: { userId: 'local', profileId: 'fixture', platform: 'ykt' },
      kind: 'export', status: 'paused', createdAtMs: 1, updatedAtMs: 2,
      nextRunAtMs: null, completed: 0, total: 1, items: [], warnings: [],
    };
    try {
      expect(await state.commit({ expected: [{ key: `job:${job.id}`, revision: null }], changes: [{ key: `job:${job.id}`, value: job }] })).toBe(true);
    } finally {
      state.close();
    }
    const list = runCli(['jobs', 'list', '--json'], init.home);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).data).toEqual([job]);
    const show = runCli(['jobs', 'show', job.id, '--json'], init.home);
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout).data).toEqual(job);
  });

  it('jobs cancel changes a saved job under its matching profile', async () => {
    const init = runCli(['init']);
    expect(init.exitCode).toBe(0);
    expect(runCli(['profile', 'add', 'alpha', '--platform', 'ykt'], init.home).exitCode).toBe(0);
    const state = new SqliteStateStore(resolve(init.home, 'state.db'));
    const profile = (await state.get('cli:profile:alpha'))!.value as { scope: { userId: string; profileId: string; platform: 'ykt' } };
    const job = { id: 'job-cancel-me', scope: profile.scope, kind: 'export', status: 'paused', createdAtMs: 1, updatedAtMs: 2, nextRunAtMs: null, completed: 0, total: 1, items: [], warnings: [] };
    expect(await state.commit({ expected: [{ key: `job:${job.id}`, revision: null }], changes: [{ key: `job:${job.id}`, value: job }] })).toBe(true);
    state.close();
    const canceled = runCli(['jobs', 'cancel', job.id, '--profile', 'alpha', '--json'], init.home);
    expect(canceled.exitCode, canceled.stderr).toBe(0);
    expect(JSON.parse(canceled.stdout).data.status).toBe('canceled');
    expect(JSON.parse(runCli(['jobs', 'show', job.id, '--json'], init.home).stdout).data.status).toBe('canceled');
  });

  it('final exam submit cannot claim success without a verified session', () => {
    const run = runCli(['exam', 'submit', 'missing.yaml', '--yes', '--final']);
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe('');
  });

  it('reconciles a standalone uncertain action by saved operation id without a new write', async () => {
    const init = runCli(['init']);
    expect(init.exitCode).toBe(0);
    const add = runCli(['profile', 'add', 'alpha', '--platform', 'ykt', '--json'], init.home);
    const profile = JSON.parse(add.stdout).data as { scope: { userId: string; profileId: string; platform: 'ykt' } };
    const scope = profile.scope;
    const state = new SqliteStateStore(resolve(init.home, 'state.db'));
    const store = new ActionStore(state, { nowMs: () => Date.now(), sleep: async () => {} }, new Uint8Array(readFileSync(resolve(init.home, 'master.key'))));
    const ref = { resource: { course: { scope, key: 'course', native: { kind: 'ykt' as const, classroomId: '1' } }, key: 'resource', native: { kind: 'ykt' as const, leafId: '2', leafInfoId: null } }, kind: 'homework' as const, assessmentId: '3' };
    const draft = { schemaVersion: 1 as const, id: 'draft', ref, fingerprint: 'fp', entries: [{ questionId: '4', fingerprint: 'qf', answer: { kind: 'choice' as const, keys: ['A'] }, evidence: null }] };
    const preview = await store.prepare({ kind: 'homework.apply', draft, questionIds: ['4'] }, 1, async () => { throw Error('lost response'); });
    await expect(store.execute(preview.id)).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    const operationId = (await store.inspect(preview.id)).operationId;
    state.close();
    const reconciled = runCli(['operations', 'reconcile', operationId, '--profile', 'alpha', '--json'], init.home);
    expect(reconciled.exitCode, reconciled.stderr).toBe(5);
    expect(JSON.parse(reconciled.stdout).data.state).toBe('uncertain');
    expect(reconciled.stderr).not.toContain('sessionid');
  });

  it('missing arguments and unknown commands use parameter exit code 2', () => {
    for (const args of [['run'], ['download'], ['not-a-command']]) {
      const run = runCli(args);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
    }
  });
});
