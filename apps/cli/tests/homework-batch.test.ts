import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCliRuntime } from '../src/runtime.js';
import { addProfile } from '../src/profiles.js';
import { writeSession } from '../../../packages/sdk/src/session/store.js';
import { SessionCookieJar } from '../../../packages/sdk/src/http/cookies.js';
import type { Json } from '@learning/sdk';

const roots: string[] = [];
const entry = resolve(import.meta.dirname, '../dist/index.js');
const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');
const fixtures = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function batch() {
  const home = mkdtempSync(resolve(tmpdir(), 'learning-batch-')); roots.push(home);
  const runtime = createCliRuntime(home);
  const profile = (await addProfile(runtime.state, 'alpha', 'ykt'))!;
  const course = { ref: { scope: profile.scope, key: 'course', native: { kind: 'ykt', classroomId: '28930736' } }, title: '批量测试', system: null, term: null, teachers: [], locked: null };
  await runtime.state.commit({ expected: [{ key: 'cli:course:course', revision: null }], changes: [{ key: 'cli:course:course', value: course as Json }] });
  const jar = new SessionCookieJar(); await jar.absorb(new URL('https://www.yuketang.cn/'), ['sessionid=fixture-session; Path=/']);
  await writeSession(runtime.state, runtime.masterKey, { schemaVersion: 1, scope: profile.scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: Date.now() });
  runtime.state.close();
  const run = (args: string[], interactions: unknown[]) => {
    const path = resolve(home, 'fixture.json'); writeFileSync(path, JSON.stringify({ interactions }));
    return spawnSync(process.execPath, ['--import', preload, entry, '--home', home, '--profile', 'alpha', ...args, '--json'], {
      cwd: home, encoding: 'utf8', env: { ...process.env, CI: '1', LEARNING_FIXTURE_FILE: path, LEARNING_ASSERT_COOKIE: 'sessionid=fixture-session' },
    });
  };
  const outline = JSON.parse(readFileSync(resolve(fixtures, 'ykt/nested-outline.json'), 'utf8'));
  outline.interactions[2].response.body.data.course_chapter[0].section_leaf_list.push(
    { id: 510, name: '作业甲', leaf_type: 6, chapter_id: 11, order: 5 },
    { id: 511, name: '作业乙', leaf_type: 6, chapter_id: 11, order: 6 },
  );
  return { home, profile, run, outline, output: resolve(home, 'exports') };
}

const leaf = (id: number, exercise: number | null) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: `/mooc-api/v1/lms/learn/leaf_info/28930736/${id}/`, query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 6, content_info: exercise === null ? {} : { leaf_type_id: exercise } } } } });
const problem = (id: number, body: string) => ({ problem_id: id, content: { ProblemType: 1, Body: body, Options: [{ key: 'A', value: '甲' }] }, user: { my_count: 0 } });
const exercise = (id: number, problems: ReturnType<typeof problem>[]) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: `/mooc-api/v1/lms/exercise/get_exercise_list/${id}/`, query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { name: `作业${id}`, problems } } } });

it.each([false, true])('isolates invalid files and incomplete questions, and stops on uncertain=%s', async uncertain => {
  const { profile, run, outline, output } = await batch();
  const first = exercise(30, [problem(11, '第一份正常题')]);
  const second = exercise(31, [problem(21, '<span class="xuetangx-com-encrypted-font">温</span>'), problem(22, '第二份正常题')]);
  const download = run(['homework', 'download', 'course', '--all', '--output-dir', output], [...outline.interactions, leaf(510, 30), leaf(511, 31), first, second]);
  expect(download.status, download.stdout + download.stderr).toBe(4);
  const downloaded = JSON.parse(download.stdout).data;
  expect(downloaded.job.items.map((item: { state: string }) => item.state)).toEqual(['succeeded', 'partial']);
  const drafts = (downloaded.files as string[]).filter(file => file.endsWith('answers.yaml'));
  expect(drafts).toHaveLength(2);
  for (const file of drafts) writeFileSync(file, readFileSync(file, 'utf8').replace(/^( {2}"\d+": )null$/gm, '$1A'));
  const invalidFile = resolve(output, '00-invalid', 'answers.yaml');
  const foreignFile = resolve(output, '01-foreign', 'answers.yaml');
  mkdirSync(resolve(output, '00-invalid'));
  mkdirSync(resolve(output, '01-foreign'));
  writeFileSync(invalidFile, 'answers: [');
  writeFileSync(foreignFile, readFileSync(drafts[0]!, 'utf8').replaceAll(profile.scope.profileId, 'foreign-profile'));
  const post = (id: number, lose: boolean) => ({ request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/problem_apply/', headers: { xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': '28930736', 'content-type': 'application/json;charset=utf-8' }, body: { classroom_id: '28930736', problem_id: String(id), answer: ['A'] } }, response: lose ? { status: 200, chunks: [Buffer.from('{"success":').toString('base64')], failAfterChunks: true } : { status: 200, body: { success: true } } });
  // Files are selected in path order; map the saved draft identity to its fixture.
  const ordered = drafts.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const firstIs30 = readFileSync(ordered[0]!, 'utf8').includes('assessmentId: "30"');
  const preparation = firstIs30 ? [first, first, second, second, second] : [second, second, second, first, first];
  const preview = run(['homework', 'apply', output, '--all', '--dry-run'], preparation);
  expect(preview.status, preview.stdout + preview.stderr).toBe(4);
  expect(JSON.parse(preview.stdout)).toMatchObject({ status: 'partial', data: { previews: expect.any(Array), receipts: [], skipped: [
    { file: invalidFile, questionId: null, code: 'INVALID_INPUT' },
    { file: foreignFile, questionId: null, code: 'FORBIDDEN' },
    { questionId: '21', code: 'PRECONDITION_CHANGED' },
  ] } });
  expect(JSON.parse(preview.stdout).data.previews).toHaveLength(2);
  const writes = firstIs30 ? [{ read: first, id: 11 }, { read: second, id: 22 }] : [{ read: second, id: 22 }, { read: first, id: 11 }];
  const submit = run(['homework', 'apply', output, '--all', '--yes'], [
    ...preparation, writes[0]!.read, post(writes[0]!.id, uncertain),
    ...(uncertain ? [] : [writes[1]!.read, post(writes[1]!.id, false)]),
  ]);
  expect(submit.status, submit.stdout + submit.stderr).toBe(uncertain ? 5 : 4);
  const result = JSON.parse(submit.stdout);
  expect(result.data.skipped).toHaveLength(3);
  if (uncertain) expect(result.error.code).toBe('UNCERTAIN');
  else {
    expect(result.data.receipts).toHaveLength(2);
    expect(result.data.receipts.every((item: { receipt: { state: string } }) => item.receipt.state === 'confirmed')).toBe(true);
  }
});

it('reports every rejected directory draft without creating a submission', async () => {
  const { run, output } = await batch();
  const invalid = resolve(output, 'a', 'answers.yaml');
  mkdirSync(resolve(output, 'a'), { recursive: true });
  mkdirSync(resolve(output, 'b'));
  writeFileSync(invalid, 'answers: [');
  writeFileSync(resolve(output, 'b', 'answers.yaml'), 'unknown: draft');
  const result = run(['homework', 'apply', output, '--all', '--yes'], []);
  expect(result.status, result.stdout + result.stderr).toBe(4);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: 'partial', data: { previews: [], receipts: [], skipped: [
    { code: 'INVALID_INPUT' }, { code: 'INVALID_INPUT' },
  ] } });
  const single = run(['homework', 'apply', invalid, '--dry-run'], []);
  expect(single.status, single.stdout + single.stderr).toBe(2);
  expect(JSON.parse(single.stdout).error.code).toBe('INVALID_INPUT');
});

it.each(['unresolved', 'protocol', 'all-unresolved'] as const)('reports %s resources and downloads the remaining homework', async failure => {
  const { run, outline, output } = await batch();
  const first = leaf(510, null);
  if (failure === 'protocol') first.response.body.success = false;
  const allFailed = failure === 'all-unresolved';
  const download = run(['homework', 'download', 'course', '--all', '--output-dir', output], [
    ...outline.interactions, first, leaf(511, allFailed ? null : 31),
    ...(allFailed ? [] : [exercise(31, [problem(21, '正常题')])]),
  ]);
  expect(download.status, download.stdout + download.stderr).toBe(4);
  const result = JSON.parse(download.stdout);
  expect(result.status).toBe('partial');
  expect(result.data.failed).toHaveLength(allFailed ? 2 : 1);
  expect(result.data.failed[0]).toMatchObject({ resourceKey: expect.any(String), title: '作业甲', code: failure === 'protocol' ? 'PROTOCOL' : 'INVALID_INPUT' });
  if (allFailed) expect(result.data).toMatchObject({ job: null, files: [] });
  else {
    expect(result.data.job.items).toHaveLength(1);
    expect(result.data.job.items[0]).toMatchObject({ state: 'succeeded' });
    expect(result.data.files.some((file: string) => file.endsWith('answers.yaml'))).toBe(true);
  }
  const jobs = run(['jobs', 'list'], []);
  expect(jobs.status, jobs.stderr).toBe(0);
  expect(JSON.parse(jobs.stdout).data.jobs).toHaveLength(allFailed ? 0 : 1);
});
