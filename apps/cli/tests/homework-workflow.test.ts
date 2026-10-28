import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeSession } from '../../../packages/sdk/src/session/store.js';
import { SessionCookieJar } from '../../../packages/sdk/src/http/client.js';
import { createCliRuntime } from '../src/runtime.js';
import { addProfile } from '../src/profiles.js';
import type { Fixture } from '../../../packages/sdk/tests/helpers/replay.js';
import type { Json } from '@learning/sdk';

const entry = resolve(import.meta.dirname, '../dist/index.js');
const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');
const fixtureRoot = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'learning-homework-workflow-'));
  homes.push(dir);
  return dir;
}

function run(homeDir: string, args: string[], fixture?: string) {
  const result = spawnSync(process.execPath, ['--import', preload, entry, '--home', homeDir, ...args], {
    cwd: homeDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      LEARNING_TELEMETRY: '0',
      LEARNING_HOME: resolve(homeDir, 'ignored-env'),
      ...(fixture === undefined ? {} : { LEARNING_FIXTURE_FILE: fixture }),
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

it('plans every ordinary homework in a course without resolving or reading exercises', async () => {
  const homeDir = home();
  const runtime = createCliRuntime(homeDir);
  const profile = (await addProfile(runtime.state, 'alpha', 'ykt'))!;
  const course = {
    ref: { scope: profile.scope, key: 'course', native: { kind: 'ykt', classroomId: '28930736' } },
    title: '测试课程',
    system: null,
    term: null,
    teachers: [],
    locked: null,
  };
  await runtime.state.commit({
    expected: [{ key: 'cli:course:course', revision: null }],
    changes: [{ key: 'cli:course:course', value: course as unknown as Json }],
  });
  runtime.state.close();

  const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/nested-outline.json'), 'utf8')) as Fixture;
  const body = fixture.interactions[2]!.response.body as { data: { course_chapter: Array<{ section_leaf_list: Json[] }> } };
  body.data.course_chapter[0]!.section_leaf_list.push(
    { id: 510, name: '普通作业甲', leaf_type: 6, chapter_id: 11, order: 5 },
    { name: '子小节', leaf_type: null, leaf_list: [{ id: 511, name: '普通作业乙', leaf_type: 6, chapter_id: 11, order: 6 }] },
  );
  const fixtureFile = resolve(homeDir, 'outline-only.json');
  writeFileSync(fixtureFile, JSON.stringify(fixture));

  const result = run(homeDir, ['homework', 'download', 'course', '--all', '--dry-run', '--profile', 'alpha', '--json'], fixtureFile);
  expect(result.code, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout).data as { resources: Array<{ key: string; title: string; path: string }>; count: number };
  expect(data.count).toBe(2);
  expect(data.resources.map(resource => [resource.title, resource.path])).toEqual([
    ['普通作业甲', '第1章 / 普通作业甲'],
    ['普通作业乙', '第1章 / 子小节 / 普通作业乙'],
  ]);
  expect(new Set(data.resources.map(resource => resource.key)).size).toBe(2);
});

it('downloads a readable homework bundle and previews a directory answer without posting', async () => {
  const homeDir = home();
  const runtime = createCliRuntime(homeDir);
  const profile = (await addProfile(runtime.state, 'alpha', 'ykt'))!;
  const scope = profile.scope;
  const resource = {
    course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } },
    key: 'clean-homework',
    native: { kind: 'ykt', leafId: '510', leafInfoId: null },
  };
  await runtime.state.commit({
    expected: [
      { key: 'cli:resource:clean-homework', revision: null },
      { key: 'cli:resource-kind:clean-homework', revision: null },
      { key: 'cli:resource-title:clean-homework', revision: null },
    ],
    changes: [
      { key: 'cli:resource:clean-homework', value: resource as unknown as Json },
      { key: 'cli:resource-kind:clean-homework', value: 'homework' },
      { key: 'cli:resource-title:clean-homework', value: '第一章作业' },
    ],
  });
  const jar = new SessionCookieJar();
  await jar.absorb(new URL('https://www.yuketang.cn/'), ['sessionid=fixture-session; Path=/']);
  await writeSession(runtime.state, new Uint8Array(readFileSync(resolve(homeDir, 'master.key'))), {
    schemaVersion: 1,
    scope,
    generation: 1,
    platformUserId: '424242',
    identityVerified: true,
    cookieJar: await jar.serialize(),
    displayName: null,
    checkedAtMs: Date.now(),
  });
  runtime.state.close();

  const leaf = {
    request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/510/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } },
    response: { status: 200, body: { success: true, data: { leaf_type: 6, content_info: { leaf_type_id: 888001 } } } },
  };
  const exercise = {
    request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/get_exercise_list/888001/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } },
    response: {
      status: 200,
      body: {
        success: true,
        data: {
          name: '第一章作业',
          problems: [{
            problem_id: 11,
            content: {
              ProblemType: 1,
              Body: '<p>选择正确的一项</p>',
              Options: [
                { key: 'A', value: '<p>甲</p>' },
                { key: 'B', value: '<p>乙</p>' },
              ],
            },
            user: { my_count: 0 },
          }],
        },
      },
    },
  };
  const downloadFixture = resolve(homeDir, 'download.json');
  writeFileSync(downloadFixture, JSON.stringify({ interactions: [leaf, exercise] }));
  const outputRoot = resolve(homeDir, 'downloads');
  const downloaded = run(homeDir, ['homework', 'download', 'clean-homework', '--output-dir', outputRoot, '--profile', 'alpha', '--json'], downloadFixture);
  expect(downloaded.code, downloaded.stderr).toBe(0);
  const files = (JSON.parse(downloaded.stdout).data as { files: string[] }).files;
  expect(files.filter(file => file.endsWith('.md')).length).toBe(1);
  const markdown = readFileSync(files.find(file => file.endsWith('.md'))!, 'utf8');
  expect(markdown).toContain('选择正确的一项');
  expect(markdown).toContain('甲');
  const generatedDraft = files.find(file => file.endsWith('.yaml'))!;
  expect(readFileSync(generatedDraft, 'utf8')).toContain('format: learning-homework/v1');

  const answerRoot = resolve(homeDir, 'answers', '第一章作业');
  mkdirSync(answerRoot, { recursive: true });
  const answerFile = resolve(answerRoot, 'answers.yaml');
  renameSync(generatedDraft, answerFile);
  const emptyAnswer = readFileSync(answerFile, 'utf8');
  const filledAnswer = emptyAnswer.replace(/^(\s*(?:"11"|'11'|11):\s*)null\s*$/m, '$1"A"');
  expect(filledAnswer).not.toBe(emptyAnswer);
  writeFileSync(answerFile, filledAnswer);
  const applyFixture = resolve(homeDir, 'apply-read-only.json');
  writeFileSync(applyFixture, JSON.stringify({ interactions: [exercise, exercise] }));
  const preview = run(homeDir, ['homework', 'apply', resolve(homeDir, 'answers'), '--all', '--dry-run', '--yes', '--profile', 'alpha', '--json'], applyFixture);
  expect(preview.code, preview.stdout + preview.stderr).toBe(0);
  const data = JSON.parse(preview.stdout).data as {
    receipts: unknown[];
    previews: Array<{ question: { body: string; options: Array<{ key: string; body: string }>; answer: string } }>;
  };
  expect(data.receipts).toEqual([]);
  expect(data.previews).toHaveLength(1);
  expect(data.previews[0]!.question.body).toContain('选择正确的一项');
  expect(data.previews[0]!.question.options).toEqual([
    { key: 'A', body: '甲' },
    { key: 'B', body: '乙' },
  ]);
  expect(data.previews[0]!.question.answer).toBe('A');
});
