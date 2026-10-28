import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCliRuntime } from '../src/runtime.js';
import { addProfile } from '../src/profiles.js';
import type { Json } from '@learning/sdk';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const entry = resolve(import.meta.dirname, '../dist/index.js');
const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');

it('plans all ordinary homework explicitly and previews without downloading or submitting it', async () => {
  const home = mkdtempSync(resolve(tmpdir(), 'learning-homework-flow-')); roots.push(home);
  const runtime = createCliRuntime(home);
  const profile = (await addProfile(runtime.state, 'alpha', 'ykt'))!;
  const course = { ref: { scope: profile.scope, key: 'course', native: { kind: 'ykt', classroomId: '28930736' } }, title: '测试课程', system: null, term: null, teachers: [], locked: null };
  await runtime.state.commit({ expected: [{ key: 'cli:course:course', revision: null }], changes: [{ key: 'cli:course:course', value: course as Json }] });
  runtime.state.close();
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures/ykt/nested-outline.json'), 'utf8'));
  fixture.interactions[2].response.body.data.course_chapter[0].section_leaf_list.push(
    { id: 510, name: '作业甲', leaf_type: 6, chapter_id: 11, order: 5 },
    { name: '子小节', leaf_type: null, leaf_list: [{ id: 511, name: '作业乙', leaf_type: 6, chapter_id: 11, order: 6 }] },
  );
  const path = resolve(home, 'fixture.json'); writeFileSync(path, JSON.stringify(fixture));
  const result = spawnSync(process.execPath, ['--import', preload, entry, 'homework', 'download', 'course', '--all', '--dry-run', '--profile', 'alpha', '--json'], {
    encoding: 'utf8', env: { ...process.env, CI: '1', LEARNING_TELEMETRY: '0', LEARNING_HOME: home, LEARNING_FIXTURE_FILE: path },
  });
  expect(result.status, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout).data;
  expect(data.resources.map((resource: { title: string }) => resource.title)).toEqual(['作业甲', '作业乙']);
  expect(data.count).toBe(2);
});
