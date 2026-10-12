import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStateStore } from '@learning/sdk/node';
import { JobRunner } from '../../../packages/sdk/src/services/jobs.js';
import { writeSession } from '../../../packages/sdk/src/session/store.js';
import { SessionCookieJar } from '../../../packages/sdk/src/http/client.js';
import { sha256Hex } from '../../../packages/sdk/src/types/sha256.js';
import type { Fixture } from '../../../packages/sdk/tests/helpers/replay.js';

const cli = resolve(import.meta.dirname, '../dist/index.js');
const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');
const fixtureRoot = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
const homes: string[] = [];

function home() {
  const dir = mkdtempSync(resolve(tmpdir(), 'learning-catalog-'));
  homes.push(dir);
  return dir;
}

function run(dir: string, args: string[], fixture?: string, expectedCookie?: string, extraEnv: Record<string, string> = {}) {
  const nodeArgs = fixture ? ['--import', preload, cli] : [cli];
  if (args[0] === 'login' && !args.includes('--import') && !args.includes('--qr-file')) args = [...args, '--qr-file', resolve(dir, 'fixture-login-qr.png')];
  const parity = fixture && (args.includes('--json') || args.includes('jsonl')) ? mkdtempSync(resolve(tmpdir(), 'learning-human-')) : null;
  if (parity) cpSync(dir, parity, { recursive: true });
  const result = spawnSync(process.execPath, [...nodeArgs, '--home', dir, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      LEARNING_HOME: resolve(dir, 'ignored-env'),
      ...(fixture ? { LEARNING_FIXTURE_FILE: fixture.startsWith('/') ? fixture : resolve(fixtureRoot, `${fixture}.json`) } : {}),
      ...(expectedCookie ? { LEARNING_ASSERT_COOKIE: expectedCookie } : {}),
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  if (parity) {
    try {
      const humanArgs = args.flatMap((argument, index) => argument === '--json' ? ['--output-format','plain'] : argument === 'jsonl' && args[index-1] === '--output-format' ? ['plain'] : [argument.startsWith(dir) ? parity + argument.slice(dir.length) : argument]);
      const human = spawnSync(process.execPath, [...nodeArgs,'--home',parity,...humanArgs,'--no-interactive'], { cwd: parity, encoding: 'utf8', env: { ...process.env, LEARNING_HOME: parity, LEARNING_FIXTURE_FILE: fixture!.startsWith('/') ? fixture! : resolve(fixtureRoot, `${fixture}.json`), ...(expectedCookie ? { LEARNING_ASSERT_COOKIE: expectedCookie } : {}), ...extraEnv } });
      expect(human.status, `${args.join(' ')} plain: ${human.stderr}`).toBe(result.status);
      expect(human.stdout + human.stderr).not.toContain('\u001b');
      if (result.status === 0) expect(human.stdout.trim().length).toBeGreaterThan(0);
    } finally { rmSync(parity, { recursive: true, force: true }); }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

describe('CLI auth and catalog against strict offline fixtures', () => {
  it('imports only a named cookie file without printing its value', () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(JSON.parse(run(dir, ['whoami', '--profile', 'alpha', '--json']).stdout).data).toEqual({ state: 'expired' });
    const cookieFile = resolve(dir, 'cookies.json');
    writeFileSync(cookieFile, JSON.stringify([{ name: 'sessionid', value: 'top-secret-cookie', domain: 'yuketang.cn' }]));
    const imported = run(dir, ['login', '--profile', 'alpha', '--import', cookieFile, '--json']);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout).data.identityVerified).toBe(false);
    expect(imported.stdout + imported.stderr).not.toContain('top-secret-cookie');
  });

  it('runs QR login, course list and outline through the SDK using fixture traffic', () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const importFile = resolve(dir, 'old-session.json');
    writeFileSync(importFile, JSON.stringify([{ name: 'sessionid', value: 'old-cookie', domain: 'yuketang.cn' }]));
    expect(run(dir, ['login', '--profile', 'alpha', '--import', importFile]).code).toBe(0);
    const login = run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login');
    expect(login.code).toBe(0);
    const session = JSON.parse(login.stdout).data as { identityVerified: boolean; platformUserId: string; generation: number };
    expect(session).toMatchObject({ identityVerified: true, platformUserId: '424242', generation: 2 });
    expect(login.stdout).not.toContain('sessionid');
    const courses = run(dir, ['courses', '--profile', 'alpha', '--json'], 'ykt/courses-list', 'sessionid=sess-fixture');
    expect(courses.code).toBe(0);
    const page = JSON.parse(courses.stdout).data as { items: Array<{ ref: { key: string }; title: string }> };
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.title).toBe('学术写作');
    const outline = run(dir, ['outline', page.items[0]!.ref.key, '--profile', 'alpha', '--json'], 'ykt/nested-outline');
    expect(outline.code).toBe(0);
    expect(JSON.parse(outline.stdout).data.value.roots.length).toBeGreaterThan(0);
  });

  it.each([
    { format: 'pretty', expired: false },
    { format: 'plain', expired: false },
    { format: 'pretty', expired: true },
    { format: 'plain', expired: true },
  ])('handles whole-course selection with format=$format expired=$expired', ({ format, expired }) => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'beta', '--platform', 'zhs']).code).toBe(0);
    const cookieFile = resolve(dir, 'cookies.json');
    writeFileSync(cookieFile, JSON.stringify([{ name: 'sessionid', value: 'fixture-session', domain: 'www.yuketang.cn' }]));
    expect(run(dir, ['login', '--profile', 'alpha', '--import', cookieFile]).code).toBe(0);
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/courses-list.json'), 'utf8')) as Fixture;
    if (expired) fixture.interactions[0]!.response = { status: 401, body: { errcode: 401002 } };
    const fixtureFile = resolve(dir, 'course-selection.json');
    writeFileSync(fixtureFile, JSON.stringify(fixture));
    const result = spawnSync('python3', [resolve(import.meta.dirname, 'helpers/terminal-driver.py'), JSON.stringify({
      argv: [process.execPath, '--import', preload, cli, '--home', dir, 'run', '--output-format', format],
      env: { LEARNING_FIXTURE_FILE: fixtureFile, LEARNING_ASSERT_COOKIE: 'sessionid=fixture-session' },
      steps: [
        { wait: '选择账号', send: format === 'pretty' ? '\r' : '1\n' },
        ...(expired ? [] : [{ wait: '学术写作', send: '\u0003' }]),
      ],
    })], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout) as { code: number; screen: string; steps: number };
    expect(data.screen).not.toContain('INVALID_INPUT');
    expect(data.screen).not.toContain('选择操作范围');
    if (expired) {
      expect(data.screen).toContain('AUTH_EXPIRED');
      expect(data.screen).toContain('learning login --profile');
      expect(data.steps).toBe(1);
    } else {
      expect(data.screen).toContain('学术写作');
      expect(data.steps, data.screen).toBe(2);
    }
    expect(data.code).toBe(3);
    expect(JSON.parse(run(dir, ['jobs', 'list', '--json']).stdout).data.jobs).toEqual([]);
  }, 20_000);


  it('shows a concise whole-course confirmation without resource hash lists', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login').code).toBe(0);
    const courses = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/courses-list.json'), 'utf8')) as Fixture;
    const outline = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/nested-outline.json'), 'utf8')) as Fixture;
    const outlineBody = outline.interactions[2]!.response.body as { data: { course_chapter: unknown[] } };
    outlineBody.data.course_chapter = [{
      id: 11,
      name: '第1章',
      section_leaf_list: [
        { name: '1.1 小节', leaf_type: null, leaf_list: [{ id: 502, leafinfo_id: 602, name: '小节视频', leaf_type: 0, chapter_id: 11, order: 1 }] },
        { id: 504, leafinfo_id: 604, name: '图文讲义', leaf_type: 3, chapter_id: 11, order: 2 },
      ],
    }];
    const videoLeaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } };
    const videoProgress = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate: 0, completed: 0, video_length: 0, last_point: 0 } } } } };
    const articleLeaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/504/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 3, sku_id: 901, finish: false } } } };
    const fixtureFile = resolve(dir, 'run-confirm.json');
    const playUrl = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/api/open/audiovideo/playurl', query: { video_id: 'CC1', provider: 'cc', file_type: '1', is_single: '0', domain: 'www.yuketang.cn' } }, response: { status: 200, body: { data: { playurl: { sources: {} } } } } };
    writeFileSync(fixtureFile, JSON.stringify({ interactions: [...courses.interactions, ...outline.interactions, articleLeaf, videoLeaf, videoProgress, playUrl] }));
    const result = spawnSync('python3', [resolve(import.meta.dirname, 'helpers/terminal-driver.py'), JSON.stringify({
      argv: [process.execPath, '--import', preload, cli, '--home', dir, 'run', '--profile', 'alpha', '--speed', '1', '--target', '0.5'],
      env: { LEARNING_FIXTURE_FILE: fixtureFile, LEARNING_ASSERT_COOKIE: 'sessionid=sess-fixture' },
      steps: [
        { wait: '搜索并选择课程', send: '\r' },
        { wait: '确认执行以上操作', send: '\u0003' },
      ],
    })], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout) as { code: number; screen: string; steps: number };
    expect(data.steps, data.screen).toBe(2);
    expect(data.screen).not.toContain('选择操作范围');
    const summary = data.screen.slice(data.screen.indexOf('课程：'));
    expect(summary).toContain('课程：学术写作');
    expect(summary).toContain('账号：alpha');
    expect(summary).toContain('视频：1 个');
    expect(summary).toContain('图文：1 个');
    expect(summary).toContain('本次可处理：1 / 2 个资源');
    expect(summary).toContain('暂不处理：1 个视频（未能读取时长）');
    expect(summary).toContain('小节视频');
    expect(summary).toContain('官方网页播放后重试');
    expect(data.screen).not.toContain('video duration is unknown');
    expect(summary).toContain('倍速：1×');
    expect(summary).toContain('目标进度：50%');
    expect(data.code).toBe(3);
    expect(JSON.parse(run(dir, ['jobs', 'list', '--json']).stdout).data.jobs).toEqual([]);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    try {
      const cached = await state.list('cli:resource:', null, 100);
      for (const row of cached.items) expect(summary).not.toContain(String((row.record.value as { key: string }).key));
    } finally { state.close(); }
    const courseKey = JSON.parse(run(dir, ['courses', '--profile', 'alpha', '--json'], 'ykt/courses-list').stdout).data.items[0].ref.key as string;
    articleLeaf.response.body.data.finish = true;
    writeFileSync(fixtureFile, JSON.stringify({ interactions: [...outline.interactions, articleLeaf, videoLeaf, videoProgress, playUrl, articleLeaf] }));
    const executed = run(dir, ['run', courseKey, '--profile', 'alpha', '--yes', '--json'], fixtureFile);
    expect(executed.code, executed.stderr).toBe(4);
    expect(JSON.parse(executed.stdout)).toMatchObject({ status: 'partial', warnings: expect.arrayContaining([expect.objectContaining({ code: 'SKIPPED_UNKNOWN_DURATION' })]), data: { status: 'succeeded', completed: 1, total: 1 } });
    const resumed = run(dir, ['jobs', 'resume', JSON.parse(executed.stdout).data.id as string, '--profile', 'alpha', '--json']);
    expect(resumed.code, resumed.stderr).toBe(4);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'partial', data: { job: { warnings: [expect.objectContaining({ code: 'SKIPPED_UNKNOWN_DURATION', resourceKey: expect.any(String) })] } } });
  }, 20_000);

  it('runs default ZHS WeChat QR entirely through allowlisted API requests', () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'zhs']).code).toBe(0);
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'zhs/wechat-qr.json'), 'utf8')) as { interactions: Array<{ request: { query?: Record<string, string> } }> };
    const service = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=https://onlineweb.zhihuishu.com/onlinestuh5';
    const redirect = `https://user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin?service=${encodeURIComponent(service)}`;
    const state = 'https://login.zhihuishu.com/wxTransit/0';
    fixture.interactions[0]!.request.query = { appid: 'wx3f96cd4b1dc1f574', scope: 'snsapi_login', redirect_uri: redirect, state, login_type: 'jssdk', self_redirect: 'false' };
    for (const row of fixture.interactions.slice(2, 5)) row.request.query = { uuid: 'WXUUID1', _: '__NOW_MS__' };
    fixture.interactions[5]!.request.query = { service, code: 'CODE1', state };
    const path = resolve(dir, 'wechat-fixture.json');
    writeFileSync(path, JSON.stringify(fixture));
    const result = run(dir, ['login', '--profile', 'alpha', '--json'], path);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.identityVerified).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('CASLOGC');
  }, 15_000);

  it('requires explicit selection with multiple profiles and never calls the network', () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'beta', '--platform', 'zhs']).code).toBe(0);
    const ambiguous = run(dir, ['whoami', '--json']);
    expect(ambiguous.code).toBe(2);
    expect(JSON.parse(ambiguous.stdout)).toMatchObject({ ok: false, exitCode: ambiguous.code });
  });

  it('exports a fixture exam through a persisted SDK job and materializes the file', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'fixture-exam', native: { kind: 'ykt', leafId: '510', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-exam', revision: null }], changes: [{ key: 'cli:resource:fixture-exam', value: ref }] })).toBe(true);
    state.close();
    const exported = run(dir, ['exam', 'export', 'fixture-exam', '--profile', 'alpha', '--json'], 'ykt/exam-read');
    expect(exported.code, exported.stderr).toBe(0);
    const result = JSON.parse(exported.stdout).data as { job: { status: string; id: string }; files: string[] };
    expect(result.job.status).toBe('succeeded');
    expect(result.files).toHaveLength(1);
    expect(JSON.parse(readFileSync(result.files[0]!, 'utf8')).questions).toHaveLength(2);
    const shown = run(dir, ['jobs', 'list', '--json']);
    expect(JSON.parse(shown.stdout).data.jobs[0].id).toBe(result.job.id);
  });

  it('writes a reimportable homework draft once without overwriting it', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'fixture-homework', native: { kind: 'ykt', leafId: '505', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-homework', revision: null }], changes: [{ key: 'cli:resource:fixture-homework', value: ref }] })).toBe(true);
    state.close();
    const output = resolve(dir, 'draft.yaml');
    const first = run(dir, ['homework', 'draft', 'fixture-homework', '-o', output, '--profile', 'alpha', '--json'], 'ykt/exercise-read');
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).data.questions).toBe(1);
    expect(readFileSync(output, 'utf8')).toContain('schemaVersion: 1');
    const second = run(dir, ['homework', 'draft', 'fixture-homework', '-o', output, '--profile', 'alpha', '--json'], 'ykt/exercise-read');
    expect(second.code).toBe(3);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: false, exitCode: second.code });
  });

  it('keeps homework dry-run read-only and sends exactly one confirmed answer', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login').code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'fixture-homework', native: { kind: 'ykt', leafId: '505', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-homework', revision: null }], changes: [{ key: 'cli:resource:fixture-homework', value: ref }] })).toBe(true);
    state.close();
    const output = resolve(dir, 'answer.yaml');
    expect(run(dir, ['homework', 'draft', 'fixture-homework', '-o', output, '--profile', 'alpha'], 'ykt/exercise-read').code).toBe(0);
    writeFileSync(output, readFileSync(output, 'utf8').replace('kind: unset', 'kind: choice\n      keys:\n        - A'));
    const original = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/exercise-read.json'), 'utf8')) as { interactions: unknown[] };
    const read = original.interactions[1];
    const write = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/problem_apply/', headers: { xtbz: 'ykt', 'xt-agent': 'web', 'classroom-id': '28930736', 'content-type': 'application/json;charset=utf-8' }, body: { classroom_id: '28930736', problem_id: '11', answer: ['A'] } }, response: { status: 200, body: { success: true, data: { submitted: true } } } };
    const dryFixture = resolve(dir, 'dry.json');
    const applyFixture = resolve(dir, 'apply.json');
    writeFileSync(dryFixture, JSON.stringify({ interactions: [read] }));
    writeFileSync(applyFixture, JSON.stringify({ interactions: [read, write] }));
    const dry = run(dir, ['homework', 'apply', output, '--profile', 'alpha', '--dry-run', '--json'], dryFixture);
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).data.receipts).toEqual([]);
    const applied = run(dir, ['homework', 'apply', output, '--profile', 'alpha', '--yes', '--json'], applyFixture);
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).data.receipts[0].receipt.state).toBe('confirmed');
  });

  it('drafts and applies Xuetang homework through two CLI processes with CSRF and numeric ids', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const ref = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '900' } }, key: 'xtx-homework', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:xtx-homework', revision: null }], changes: [{ key: 'cli:resource:xtx-homework', value: ref }] })).toBe(true);
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.xuetangx.com/'), ['csrftoken=fixture-csrf; Path=/']);
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const leaf = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 6, content_info: { leaf_type_id: 888 } } } } };
    const exercise = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/exercise/get_exercise_list/888/900/', headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { exercise_id: 888, problems: [{ problem_id: 11, content: { Type: 'FillBlank', Body: '<p>填空</p>' }, user: { my_count: 0 } }] } } } };
    const draftFixture = resolve(dir, 'xtx-draft.json');
    writeFileSync(draftFixture, JSON.stringify({ interactions: [leaf, exercise] }));
    const file = resolve(dir, 'xtx-answer.yaml');
    const drafted = run(dir, ['homework', 'draft', 'xtx-homework', '-o', file, '--profile', 'alpha', '--json'], draftFixture);
    expect(drafted.code, drafted.stderr).toBe(0);
    writeFileSync(file, readFileSync(file, 'utf8').replace('kind: unset', 'kind: fill-blank\n      blanks:\n        - id: "1"\n          text: fixture answer'));
    const write = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/exercise/problem_apply/', headers: { xtbz: 'xt', 'x-csrftoken': 'fixture-csrf', 'content-type': 'application/json;charset=utf-8' }, body: { leaf_id: 7, classroom_id: 100, exercise_id: 888, problem_id: 11, sign: 'SIGN-A', answers: { '1': 'fixture answer' }, answer: '' } }, response: { status: 200, body: { success: true, data: { saved: true } } } };
    const applyFixture = resolve(dir, 'xtx-apply.json');
    writeFileSync(applyFixture, JSON.stringify({ interactions: [exercise, write] }));
    const applied = run(dir, ['homework', 'apply', file, '--yes', '--profile', 'alpha', '--json'], applyFixture);
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).data.receipts[0].receipt.state).toBe('confirmed');
  });

  it('drafts and applies one Yuketang embedded question using its dedicated reply endpoint', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'embedded-video', native: { kind: 'ykt', leafId: '502', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:embedded-video', revision: null }], changes: [{ key: 'cli:resource:embedded-video', value: ref }] })).toBe(true);
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.yuketang.cn/'), ['csrftoken=fixture; Path=/']);
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 0, sku_id: 901, content_info: { media: { exercise_id: 888 } } } } } };
    const list = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/901/502/888/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>题</p>', Options: [{ key: 'A', value: '<p>甲</p>' }] }, user: { is_right: false } }] } } };
    const file = resolve(dir, 'embedded.yaml');
    const draftFixture = resolve(dir, 'embedded-draft.json');
    writeFileSync(draftFixture, JSON.stringify({ interactions: [leaf, leaf, list] }));
    const drafted = run(dir, ['homework', 'draft', 'embedded-video', '-o', file, '--profile', 'alpha', '--json'], draftFixture);
    expect(drafted.code, drafted.stderr).toBe(0);
    writeFileSync(file, readFileSync(file, 'utf8').replace('kind: unset', 'kind: choice\n      keys:\n        - A'));
    const write = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/reply/11/', headers: { xtbz: 'ykt', 'x-csrftoken': 'fixture', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { exercise_id: 888, sku_id: 901, leaf_id: 502, answer: ['A'] } }, response: { status: 200, body: { success: true, data: { is_right: false, my_answer: ['A'] } } } };
    const applyFixture = resolve(dir, 'embedded-apply.json');
    writeFileSync(applyFixture, JSON.stringify({ interactions: [leaf, list, leaf, list, leaf, write] }));
    const applied = run(dir, ['homework', 'apply', file, '--yes', '--profile', 'alpha', '--json'], applyFixture);
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).data.receipts[0].receipt.result).toMatchObject({ isRight: false, correctAnswer: null });
  });

  it('exports historical slide images as a real local PDF', () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/history-slides.json'), 'utf8')) as { interactions: unknown[] };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const imageCalls = ['/s0.png', '/s1.png', '/s3/p2.png'].map((path) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path }, response: { status: 200, headers: { 'content-type': 'image/png' }, base64: png } }));
    const file = resolve(dir, 'slides-fixture.json');
    writeFileSync(file, JSON.stringify({ interactions: [...fixture.interactions.slice(1), ...imageCalls] }));
    const result = run(dir, ['slide', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--format', 'pdf', '--profile', 'alpha', '--json'], file);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout).data as { job: { status: string }; files: string[] };
    expect(parsed.job.status).toBe('succeeded');
    expect(parsed.files).toHaveLength(1);
    expect(readFileSync(parsed.files[0]!).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('downloads a fixture MP4 through the SDK and publishes a verified file', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'fixture-video', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-video', revision: null }], changes: [{ key: 'cli:resource:fixture-video', value: ref }] })).toBe(true);
    state.close();
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'xuetang/media.json'), 'utf8')) as { interactions: unknown[] };
    const body = Buffer.from('synthetic-mp4-content');
    const file = resolve(dir, 'mp4-fixture.json');
    writeFileSync(file, JSON.stringify({ interactions: [...fixture.interactions, { request: { method: 'GET', host: 'www.xuetangx.com', path: '/hd.mp4' }, response: { status: 200, headers: { 'content-type': 'video/mp4' }, base64: body.toString('base64') } }] }));
    const result = run(dir, ['download', 'fixture-video', '--types', 'video', '--profile', 'alpha', '--json'], file);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout).data as { job: { status: string }; files: string[] };
    expect(parsed.job.status).toBe('succeeded');
    expect(parsed.files).toHaveLength(1);
    expect(readFileSync(parsed.files[0]!)).toEqual(body);
  });

  it('resumes a stopped MP4 process from a verified Range checkpoint', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'fixture-video', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-video', revision: null }], changes: [{ key: 'cli:resource:fixture-video', value: ref }] })).toBe(true);
    state.close();
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'xuetang/media.json'), 'utf8')) as { interactions: unknown[] };
    const first = resolve(dir, 'first-mp4.json');
    writeFileSync(first, JSON.stringify({ interactions: [...fixture.interactions, { request: { method: 'GET', host: 'www.xuetangx.com', path: '/hd.mp4' }, response: { status: 200, headers: { etag: '"v1"', 'content-type': 'video/mp4' }, chunks: [Buffer.from('abc').toString('base64')], failAfterChunks: true } }] }));
    const interrupted = run(dir, ['download', 'fixture-video', '--types', 'video', '--profile', 'alpha', '--json'], first);
    expect(interrupted.code).not.toBe(0);
    expect(JSON.parse(interrupted.stdout)).toMatchObject({ ok: false, exitCode: interrupted.code });
    const jobs = JSON.parse(run(dir, ['jobs', 'list', '--json']).stdout).data.jobs as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('paused');
    const second = resolve(dir, 'second-mp4.json');
    writeFileSync(second, JSON.stringify({ interactions: [...fixture.interactions, { request: { method: 'GET', host: 'www.xuetangx.com', path: '/hd.mp4', headers: { range: 'bytes=3-', 'if-range': '"v1"' } }, response: { status: 206, headers: { etag: '"v1"', 'content-range': 'bytes 3-5/6', 'content-type': 'video/mp4' }, base64: Buffer.from('def').toString('base64') } }] }));
    const resumed = run(dir, ['jobs', 'resume', jobs[0]!.id, '--profile', 'alpha', '--json'], second);
    expect(resumed.code, resumed.stderr).toBe(0);
    const result = JSON.parse(resumed.stdout).data as { job: { status: string }; files: string[] };
    expect(result.job.status).toBe('succeeded');
    expect(readFileSync(result.files[0]!, 'utf8')).toBe('abcdef');
  });

  it('downloads an unencrypted HLS media playlist in order', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'fixture-hls', native: { kind: 'ykt', leafId: '502', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-hls', revision: null }], changes: [{ key: 'cli:resource:fixture-hls', value: ref }] })).toBe(true);
    state.close();
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/media.json'), 'utf8')) as { interactions: unknown[] };
    const playlist = '#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST\n';
    const binary = (path: string, body: Buffer) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path }, response: { status: 200, base64: body.toString('base64') } });
    const file = resolve(dir, 'hls-fixture.json');
    writeFileSync(file, JSON.stringify({ interactions: [...fixture.interactions, binary('/hd.m3u8', Buffer.from(playlist)), binary('/a.ts', Buffer.from('AAA')), binary('/b.ts', Buffer.from('BBB'))] }));
    const result = run(dir, ['download', 'fixture-hls', '--types', 'video', '--profile', 'alpha', '--json'], file);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout).data as { files: string[] };
    expect(parsed.files[0]).toMatch(/\.ts$/);
    expect(readFileSync(parsed.files[0]!, 'utf8')).toBe('AAABBB');
  });

  it('resumes HLS at the next verified segment after a process stops mid-segment', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'fixture-hls-resume', native: { kind: 'ykt', leafId: '502', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-hls-resume', revision: null }], changes: [{ key: 'cli:resource:fixture-hls-resume', value: ref }] })).toBe(true);
    state.close();
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/media.json'), 'utf8')) as { interactions: unknown[] };
    const playlist = '#EXTM3U\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST\n';
    const binary = (path: string, body: Buffer) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path }, response: { status: 200, base64: body.toString('base64') } });
    const first = resolve(dir, 'hls-first.json');
    writeFileSync(first, JSON.stringify({ interactions: [...fixture.interactions, binary('/hd.m3u8', Buffer.from(playlist)), binary('/a.ts', Buffer.from('AAA')),
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/b.ts' }, response: { status: 200, chunks: [Buffer.from('discard').toString('base64')], failAfterChunks: true } }] }));
    const interrupted = run(dir, ['download', 'fixture-hls-resume', '--types', 'video', '--profile', 'alpha', '--json'], first);
    expect(interrupted.code).not.toBe(0);
    const jobs = JSON.parse(run(dir, ['jobs', 'list', '--json']).stdout).data.jobs as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('paused');
    const second = resolve(dir, 'hls-second.json');
    writeFileSync(second, JSON.stringify({ interactions: [...fixture.interactions, binary('/hd.m3u8', Buffer.from(playlist)), binary('/b.ts', Buffer.from('BBB'))] }));
    const resumed = run(dir, ['jobs', 'resume', jobs[0]!.id, '--profile', 'alpha', '--json'], second);
    expect(resumed.code, resumed.stderr).toBe(0);
    const parsed = JSON.parse(resumed.stdout).data as { job: { status: string }; files: string[] };
    expect(parsed.job.status).toBe('succeeded');
    expect(readFileSync(parsed.files[0]!, 'utf8')).toBe('AAABBB');
  });

  it('previews then runs a one-beat Yuketang study job with server confirmation', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login').code).toBe(0);
    expect(run(dir, ['profile', 'add', 'beta', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'study-video', native: { kind: 'ykt', leafId: '502', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:study-video', revision: null }, { key: 'cli:resource-kind:study-video', revision: null }], changes: [{ key: 'cli:resource:study-video', value: ref }, { key: 'cli:resource-kind:study-video', value: 'video' }] })).toBe(true);
    state.close();
    const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } };
    const progress = (rate: number, point: number) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate, completed: 0, video_length: 10, last_point: point } } } } });
    const dryFixture = resolve(dir, 'study-dry.json');
    writeFileSync(dryFixture, JSON.stringify({ interactions: [leaf, progress(0, 0)] }));
    const dry = run(dir, ['run', '--resource', 'study-video', '--target', '0.5', '--speed', '1', '--dry-run', '--json'], dryFixture);
    expect(dry.code, dry.stderr).toBe(0);
    const dryResult = JSON.parse(dry.stdout) as { data: Record<string, unknown> };
    expect(Object.keys(dryResult.data)).toEqual(['id', 'scope', 'kind', 'digest', 'generation', 'expiresAtMs', 'description', 'startsTimer', 'finalSubmission', 'blockers', 'warnings']);
    expect(dryResult.data.kind).toBe('study');
    const missing = run(dir, ['run', '--resource', 'missing-video', '--dry-run', '--profile', 'alpha', '--json'], dryFixture);
    const missingResult = JSON.parse(missing.stdout);
    expect(missingResult.exitCode).toBe(2);
    expect(missingResult.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(missingResult.error).toMatchObject({ fields: ['resource'] });
    expect(missingResult.error.message).toContain('找不到课程或资源 key');
    const single = run(dir, ['run', '--resource', 'study-video', '--target', '0.5', '--speed', '1', '--dry-run', '--profile', 'alpha', '--output-format', 'plain'], dryFixture);
    expect(single.code, single.stderr).toBe(0);
    expect(single.stdout).toContain('课程：课程名称暂不可用');
    expect(single.stdout).toContain('范围：单个资源');
    expect(single.stdout).toContain('视频：1 个');
    expect(single.stdout).not.toContain('study-video');
    const row = { i: 5, et: 'heartbeat', p: 'web', n: 'ali-cdn.xuetangx.com', lob: 'ykt', cp: 5, fp: 0, tp: 10, sp: 1,
      ts: '__NOW_MS__', u: '424242', uip: '', c: '5184094', v: '502', skuid: '901', classroomid: '28930736', cc: 'CC1', d: 10,
      pg: '__JOB_PG_502__', sq: 1, t: 'video', cards_id: 0, slide: 0 };
    const write = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/video-log/heartbeat/', headers: { xtbz: 'ykt', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: [row] } }, response: { status: 200, body: {} } };
    const runFixture = resolve(dir, 'study-run.json');
    writeFileSync(runFixture, JSON.stringify({ interactions: [leaf, progress(0, 0), leaf, progress(0, 0), write, leaf, progress(0.5, 5)] }));
    const actual = run(dir, ['run', 'study-video', '--target', '0.5', '--speed', '1', '--yes', '--profile', 'alpha', '--json'], runFixture);
    expect(actual.code, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout).data.status).toBe('succeeded');
  });

  it('runs a Yuketang study job with the default preset: max speed and full target', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login').code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'study-video', native: { kind: 'ykt', leafId: '502', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:study-video', revision: null }], changes: [{ key: 'cli:resource:study-video', value: ref }] })).toBe(true);
    state.close();
    const leaf = { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } };
    const progress = (rate: number, point: number) => ({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate, completed: 0, video_length: 10, last_point: point } } } } });
    const row = { i: 5, et: 'heartbeat', p: 'web', n: 'ali-cdn.xuetangx.com', lob: 'ykt', cp: 10, fp: 0, tp: 10, sp: 5,
      ts: '__NOW_MS__', u: '424242', uip: '', c: '5184094', v: '502', skuid: '901', classroomid: '28930736', cc: 'CC1', d: 10,
      pg: '__JOB_PG_502__', sq: 1, t: 'video', cards_id: 0, slide: 0 };
    const write = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/video-log/heartbeat/', headers: { xtbz: 'ykt', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: [row] } }, response: { status: 200, body: {} } };
    const runFixture = resolve(dir, 'study-default.json');
    writeFileSync(runFixture, JSON.stringify({ interactions: [leaf, progress(0, 0), leaf, progress(0, 0), write, leaf, progress(1, 10)] }));
    const actual = run(dir, ['run', 'study-video', '--yes', '--profile', 'alpha', '--json'], runFixture);
    expect(actual.code, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout).data.status).toBe('succeeded');
  });

  it('reconciles an uncertain saved study job with only two GETs', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login').code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const resource = { course: { scope, key: 'course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'video', native: { kind: 'ykt', leafId: '502', leafInfoId: null } };
    const runner = new JobRunner(state, { nowMs: () => Date.now(), sleep: async () => {} });
    const job = await runner.create(scope, 'study', { total: 1, generation: 1, payload: { kind: 'study', resources: [resource], settings: { speed: 1, targetFraction: 0.5, questionMode: 'pause', maxDurationSeconds: 60 } } });
    const operationId = `heartbeat:${job.id}:video:1`;
    await expect(runner.advance(job.id, async () => {
      await runner.setCursor(job.id, JSON.stringify({ resourceKey: 'video', cp: 5, sq: 1, baseline: 0, awaiting: true, stalls: 0 }));
      await runner.setPendingOperation(job.id, operationId);
      throw Error('response lost');
    })).rejects.toThrow();
    state.close();
    const fixture = resolve(dir, 'reconcile.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data: { course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } } } },
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { '502': { rate: 0.5, completed: 0, video_length: 10, last_point: 5 } } } } },
    ] }));
    const result = run(dir, ['jobs', 'reconcile', job.id, '--profile', 'alpha', '--json'], fixture);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ receipt: { state: 'confirmed' }, job: { status: 'paused' } });
  });

  it('matches an exact feedback answer into a new draft without submitting it', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    const ref = { course: { scope, key: 'fixture-course', native: { kind: 'ykt', classroomId: '28930736' } }, key: 'fixture-homework', native: { kind: 'ykt', leafId: '505', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:fixture-homework', revision: null }], changes: [{ key: 'cli:resource:fixture-homework', value: ref }] })).toBe(true);
    state.close();
    const original = JSON.parse(readFileSync(resolve(fixtureRoot, 'ykt/exercise-read.json'), 'utf8')) as { interactions: Array<{ response: { body: { data: { font?: string } } } }> };
    delete original.interactions[1]!.response.body.data.font;
    const draftFixture = resolve(dir, 'draft-fixture.json');
    const matchFixture = resolve(dir, 'match-fixture.json');
    writeFileSync(draftFixture, JSON.stringify(original));
    writeFileSync(matchFixture, JSON.stringify({ interactions: [original.interactions[1]] }));
    const draftFile = resolve(dir, 'draft.yaml');
    expect(run(dir, ['homework', 'draft', 'fixture-homework', '-o', draftFile, '--profile', 'alpha'], draftFixture).code).toBe(0);
    const feedbackFile = resolve(dir, 'feedback.json');
    writeFileSync(feedbackFile, JSON.stringify({ problems: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p><span class="textfonts">&#x1234;</span> 选对的</p>', Options: [{ key: 'A', value: '<p>甲</p>' }], Answers: ['A'] } }] }));
    const matchedFile = resolve(dir, 'matched.yaml');
    const matched = run(dir, ['answers', 'match', draftFile, '--source', feedbackFile, '-o', matchedFile, '--profile', 'alpha', '--json'], matchFixture);
    expect(matched.code, matched.stderr).toBe(0);
    expect(JSON.parse(matched.stdout).data.matches[0].state).toBe('exact');
    expect(readFileSync(matchedFile, 'utf8')).toContain('kind: choice');
  });

  it('creates a Xuetang discussion draft, previews it, and posts once with confirmation', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'discussion', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:discussion', revision: null }], changes: [{ key: 'cli:resource:discussion', value: resource }] })).toBe(true);
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '88', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const root = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/unit/discussion/', query: { product_sign: 'SIGN-A', leaf_id: '7', classroom_id: '100', topic_type: '0', channel: 'xt' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { id: 55, user_id: 77, content: { text: '主题' }, commented: 0 } } };
    const comments = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/comment/list/55/', query: { offset: '0', limit: '10', cid: '100', lid: '7' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { results: [] } } } };
    const draftFixture = resolve(dir, 'discuss-draft.json');
    const previewFixture = resolve(dir, 'discuss-preview.json');
    const postFixture = resolve(dir, 'discuss-post.json');
    writeFileSync(draftFixture, JSON.stringify({ interactions: [root, root, comments] }));
    writeFileSync(previewFixture, JSON.stringify({ interactions: [root] }));
    const write = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/comment/', query: { classroom_id: '100', leaf_id: '7' }, headers: { xtbz: 'xt', 'content-type': 'application/json;charset=utf-8' }, body: { topic_id: '55', to_user: 77, content: { text: '我的回复', upload_images: [] } } }, response: { status: 200, body: { success: true, data: { id: 9 } } } };
    writeFileSync(postFixture, JSON.stringify({ interactions: [root, write] }));
    const path = resolve(dir, 'discussion.json');
    const drafted = run(dir, ['discuss', 'draft', 'discussion', '-o', path, '--profile', 'alpha', '--json'], draftFixture);
    expect(drafted.code, drafted.stderr).toBe(0);
    const draft = JSON.parse(readFileSync(path, 'utf8')) as { text: string };
    draft.text = '我的回复';
    writeFileSync(path, JSON.stringify(draft));
    const preview = run(dir, ['discuss', 'post', path, '--dry-run', '--profile', 'alpha', '--json'], previewFixture);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data.kind).toBe('discussion.post');
    const posted = run(dir, ['discuss', 'post', path, '--yes', '--profile', 'alpha', '--json'], postFixture);
    expect(posted.code, posted.stderr).toBe(0);
    expect(JSON.parse(posted.stdout).data.receipt.state).toBe('confirmed');
  });

  it('creates an editable AI discussion draft only when a model is explicitly configured', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'discussion-ai', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:discussion-ai', revision: null }], changes: [{ key: 'cli:resource:discussion-ai', value: resource }] })).toBe(true);
    state.close();
    const root = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/unit/discussion/', query: { product_sign: 'SIGN-A', leaf_id: '7', classroom_id: '100', topic_type: '0', channel: 'xt' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { id: 55, user_id: 77, content: { text: '讨论主题' }, commented: 0 } } };
    const comments = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/comment/list/55/', query: { offset: '0', limit: '10', cid: '100', lid: '7' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { results: [] } } } };
    const model = { request: { method: 'POST', host: 'model.example.test', path: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-key', 'content-type': 'application/json' }, body: { model: 'fixture-model', messages: [
      { role: 'system', content: 'Return only JSON with one nonempty text field containing an editable discussion reply. Do not submit it.' },
      { role: 'user', content: JSON.stringify({ topic: '讨论主题' }) },
    ], stream: false } }, response: { status: 200, body: { choices: [{ message: { content: JSON.stringify({ text: '建议正文' }) } }] } } };
    const fixture = resolve(dir, 'discussion-ai.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [root, root, comments, model] }));
    const output = resolve(dir, 'discussion-ai-draft.json');
    const configured = run(dir, ['discuss', 'draft', 'discussion-ai', '--ai', '-o', output, '--profile', 'alpha', '--json'], fixture, undefined,
      { LEARNING_MODEL_BASE_URL: 'https://model.example.test/v1', LEARNING_MODEL_NAME: 'fixture-model', LEARNING_MODEL_API_KEY: 'fixture-key' });
    expect(configured.code, configured.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ text: '建议正文', origin: 'model' });
    expect(configured.stdout + configured.stderr).not.toContain('fixture-key');
  });

  it('requires explicit exam start confirmation and sends one start_paper call', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam-resource', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:exam-resource', revision: null }], changes: [{ key: 'cli:resource:exam-resource', value: resource }] })).toBe(true);
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '88', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const refused = run(dir, ['exam', 'start', 'exam-resource', '--profile', 'alpha', '--json']);
    expect(refused.code).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, exitCode: refused.code });
    const leaf = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { leaf_type: 5, content_info: { leaf_type_id: 777001 } } } } };
    const cover = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/cover', query: { exam_id: '777001' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { data: { result: { status: 0 }, user: { user_id: 88 } } } } } };
    const token = { request: { method: 'POST', host: 'www.xuetangx.com', path: '/api/v1/lms/exam/gen_token', headers: { xtbz: 'xt', 'content-type': 'application/json;charset=utf-8' }, body: { exam_id: '777001', classroom_id: '100', is_teacher: 0 } }, response: { status: 200, body: { success: true, data: { errcode: 0, data: { crypt: 'fixture-crypt', exam_host: 'https://examination.xuetangx.com' } } } } };
    const login = { request: { method: 'GET', host: 'examination.xuetangx.com', path: '/login', query: { exam_id: '777001', user_id: '88', crypt: 'fixture-crypt', next: 'https://examination.xuetangx.com/result/777001?isFrom=0', language: 'zh' } }, response: { status: 200, body: {} } };
    const start = { request: { method: 'POST', host: 'examination.xuetangx.com', path: '/exam_room/start_paper', headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' }, body: { exam_id: 777001 } }, response: { status: 200, body: { errcode: 0, data: { started: true } } } };
    const fixture = resolve(dir, 'exam-start.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [leaf, cover, cover, token, login, start] }));
    const actual = run(dir, ['exam', 'start', 'exam-resource', '--yes', '--profile', 'alpha', '--json'], fixture);
    expect(actual.code, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout).data.receipt.state).toBe('confirmed');
  });

  it('saves an in-progress exam draft without finalizing the paper', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam-resource', native: { kind: 'xuetang', leafId: '30', leafInfoId: null } };
    const q1 = sha256Hex(JSON.stringify([1, 'SingleChoice', '<p>选对的</p>']));
    const q9 = sha256Hex(JSON.stringify([9, 'WeirdNewType', '<p>?</p>']));
    const draft = { schemaVersion: 1, id: 'draft-3908258', ref: { resource, kind: 'exam', assessmentId: '3908258' }, fingerprint: sha256Hex(JSON.stringify([q1, q9])), entries: [
      { questionId: '1', fingerprint: q1, answer: { kind: 'choice', keys: ['A'] }, evidence: null },
      { questionId: '9', fingerprint: q9, answer: { kind: 'unset' }, evidence: null },
    ] };
    const file = resolve(dir, 'exam-draft.json');
    writeFileSync(file, JSON.stringify(draft));
    const withoutFinal = run(dir, ['exam', 'submit', file, '--yes', '--profile', 'alpha', '--json']);
    expect(withoutFinal.code).toBe(2);
    expect(JSON.parse(withoutFinal.stdout).error.message).toContain('--final');
    const withoutYes = run(dir, ['exam', 'save', file, '--profile', 'alpha', '--json']);
    expect(withoutYes.code).toBe(3);
    expect(JSON.parse(withoutYes.stdout)).toMatchObject({ ok: false, exitCode: withoutYes.code });
    const original = JSON.parse(readFileSync(resolve(fixtureRoot, 'xuetang/exam-read.json'), 'utf8')) as { interactions: Array<{ request: { path: string }; response: { body: { data?: { data?: { result?: { status: number } } } } } }> };
    const reads = original.interactions.slice(1);
    reads[0]!.response.body.data!.data!.result!.status = 1;
    const final = JSON.parse(JSON.stringify(reads.slice(0, 4))) as typeof reads;
    final[0]!.response.body.data!.data!.result!.status = 1;
    const save = { request: { method: 'POST', host: 'examination.xuetangx.com', path: '/exam_room/answer_problem', headers: { xtbz: 'cloud', 'x-client': 'web', 'content-type': 'application/json;charset=utf-8' }, body: { results: [{ problem_id: 1, result: ['A'], time: '__NOW_NUMBER__' }], exam_id: 3908258, record: [] } }, response: { status: 200, body: { errcode: 0, data: { saved: true } } } };
    const fixture = resolve(dir, 'exam-save.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [...reads, ...final, save] }));
    const result = run(dir, ['exam', 'save', file, '--yes', '--profile', 'alpha', '--json'], fixture);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.receipt.state).toBe('confirmed');
  });

  it('writes an editable exam draft from a permitted paper without starting it', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam-resource', native: { kind: 'xuetang', leafId: '30', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:exam-resource', revision: null }], changes: [{ key: 'cli:resource:exam-resource', value: resource }] })).toBe(true);
    state.close();
    const path = resolve(dir, 'exam-draft.yaml');
    const result = run(dir, ['exam', 'draft', 'exam-resource', '-o', path, '--profile', 'alpha', '--json'], 'xuetang/exam-read');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.questions).toBe(2);
    expect(readFileSync(path, 'utf8')).toContain('schemaVersion: 1');
  });

  it('shows the E05 final-submission blocker without any upstream request', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'exam', native: { kind: 'xuetang', leafId: '30', leafInfoId: null } };
    const file = resolve(dir, 'final.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, id: 'draft-final', ref: { resource, kind: 'exam', assessmentId: '3908258' }, fingerprint: 'fp', entries: [] }));
    const result = run(dir, ['exam', 'submit', file, '--yes', '--final', '--profile', 'alpha', '--json']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).data.blockers.join(' ')).toContain('E05');
    expect(JSON.parse(result.stdout).warnings.some((warning: { message: string }) => warning.message.includes('E05'))).toBe(true);
  });

  it('checks in to a fixture live lesson, records a question and closes the socket', () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    expect(run(dir, ['login', '--profile', 'alpha', '--json'], 'ykt/qr-login').code).toBe(0);
    const withoutYes = run(dir, ['live', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--profile', 'alpha', '--json']);
    expect(withoutYes.code).toBe(3);
    expect(JSON.parse(withoutYes.stdout)).toMatchObject({ ok: false, exitCode: withoutYes.code });
    const fixture = resolve(dir, 'live-fixture.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [
      { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' } }, response: { status: 200, headers: { 'set-auth': 'fixture-jwt' }, body: { code: 0, data: { lessonToken: 'fixture-live-token' } } } },
    ], websocket: { url: 'wss://www.yuketang.cn/wsapp/', hello: { op: 'hello', userid: '424242', role: 'student', auth: 'fixture-live-token', lessonid: '9000' }, frames: [
      { op: 'hello' }, { op: 'unlockproblem', problem: { prob: 11, problemType: 1, limit: 30 }, msgid: 2 }, { op: 'lessonfinished' },
    ] } }));
    const result = run(dir, ['live', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--yes', '--profile', 'alpha', '--output-format', 'jsonl'], fixture);
    expect(result.code, result.stderr).toBe(0);
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1).data.data.status).toBe('succeeded');
    expect(events.some(event => event.type === 'question' && event.data.question.id === '11')).toBe(true);
  });

  it('resumes the same paused live job only after a fresh --yes checkin', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'ykt']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: Date.now() });
    const runner = new JobRunner(state, { nowMs: () => Date.now(), sleep: async () => {} });
    const job = await runner.create(scope, 'live', { total: null, generation: 1, payload: { kind: 'live.join', lesson: { scope, course: null, lessonId: '9000' }, maxDurationSeconds: 60 } });
    await runner.pause(job.id);
    state.close();
    const withoutYes = run(dir, ['jobs', 'resume', job.id, '--profile', 'alpha', '--json']);
    expect(withoutYes.code).toBe(3);
    expect(JSON.parse(withoutYes.stdout)).toMatchObject({ ok: false, exitCode: withoutYes.code });
    const fixture = resolve(dir, 'live-resume.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [
      { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' } }, response: { status: 200, body: { code: 0, data: { lessonToken: 'fixture-rejoin-token' } } } },
    ], websocket: { url: 'wss://www.yuketang.cn/wsapp/', hello: { op: 'hello', userid: '77', role: 'student', auth: 'fixture-rejoin-token', lessonid: '9000' }, frames: [{ op: 'hello' }, { op: 'lessonfinished' }] } }));
    const result = run(dir, ['jobs', 'resume', job.id, '--yes', '--profile', 'alpha', '--json'], fixture);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.job).toMatchObject({ id: job.id, status: 'succeeded' });
    const reopened = new SqliteStateStore(resolve(dir, 'state.db'));
    const events = await new JobRunner(reopened, { nowMs: () => Date.now(), sleep: async () => {} }).events(job.id, 0);
    expect(events.some((event) => event.type === 'gap')).toBe(true);
    reopened.close();
  });

  it('runs Xuetang start, ratechange and heartbeat with real elapsed intervals', async () => {
    const dir = home();
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'xuetang']).code).toBe(0);
    const state = new SqliteStateStore(resolve(dir, 'state.db'));
    const profile = await state.get('cli:profile:alpha');
    const scope = (profile?.value as { scope: { userId: string; profileId: string; platform: 'xuetang' } }).scope;
    const resource = { course: { scope, key: 'course', native: { kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '9' } }, key: 'xtx-video', native: { kind: 'xuetang', leafId: '7', leafInfoId: null } };
    expect(await state.commit({ expected: [{ key: 'cli:resource:xtx-video', revision: null }], changes: [{ key: 'cli:resource:xtx-video', value: resource }] })).toBe(true);
    const jar = new SessionCookieJar();
    await jar.absorb(new URL('https://www.xuetangx.com/'), ['csrftoken=fixture; Path=/']);
    await writeSession(state, new Uint8Array(readFileSync(resolve(dir, 'master.key'))), { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await jar.serialize(), displayName: null, checkedAtMs: Date.now() });
    state.close();
    const schedule = (rate: number) => ({ request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule', query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { leaf_schedules: { '7': rate } } } } });
    const leaf = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/', query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { success: true, data: { id: 7, course_id: 5, user_id: 77, sku_id: 9, content_info: { media: { ccid: 'CCX1', duration: 10 } } } } } };
    const row = (event: string, cp: number, sq: number) => ({ i: 5, et: event, p: 'web', n: '', lob: 'xt', cp, fp: 0, tp: 0, sp: 2, ts: '__NOW_MS__', u: 77, c: 5, v: 7, cc: 'CCX1', d: 10, pg: '__JOB_PG_7__', sq, t: 'video', uip: '', skuid: '9', classroomid: '100', cards_id: 0, slide: 0, v_url: '' });
    const write = (rows: ReturnType<typeof row>[]) => ({ request: { method: 'POST', host: 'www.xuetangx.com', path: '/video-log/heartbeat/', headers: { xtbz: 'xt', 'x-csrftoken': 'fixture', 'content-type': 'application/json;charset=utf-8' }, body: { heart_data: rows } }, response: { status: 200, body: {} } });
    const fixture = resolve(dir, 'xtx-study.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [schedule(0), leaf,
      schedule(0), leaf, write([row('loadstart', 0, 1), row('loadeddata', 0, 2), row('play', 0, 3)]),
      schedule(0), leaf, write([row('ratechange', 0, 4)]),
      schedule(0), leaf, write([row('heartbeat', 5, 5)]), schedule(0.5)] }));
    const actual = run(dir, ['run', 'xtx-video', '--target', '0.5', '--speed', '2', '--yes', '--profile', 'alpha', '--json'], fixture);
    expect(actual.code, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout).data.status).toBe('succeeded');
  }, 40_000);
});
