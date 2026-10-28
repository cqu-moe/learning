// Synthetic browser acceptance data; unregistered platform requests are denied.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../server/app.ts';
import { SqliteStateStore, loadOrCreateMasterKey } from '@learning/sdk/node';
import { FakeTransport, loadFixture } from '../../../packages/sdk/tests/helpers/replay.ts';
import type { FixtureInteraction } from '../../../packages/sdk/tests/helpers/replay.ts';
import { SessionCookieJar } from '../../../packages/sdk/dist/http/client.js';
import { writeSession } from '../../../packages/sdk/dist/session/store.js';
import { CourseSchema, JobSchema, keyOfCourse } from '@learning/sdk/public';
import type { Course, Job, Json, Scope } from '@learning/sdk/public';

const directory = mkdtempSync(join(tmpdir(), 'learning-web-browser-'));
const interactions: FixtureInteraction[] = [
  ...loadFixture('ykt/qr-login').interactions,
  ...loadFixture('ykt/nested-outline').interactions,
  ...loadFixture('ykt/media').interactions,
  ...loadFixture('ykt/history-slides').interactions.slice(0, 1),
  { request: { method: 'GET', host: 'www.yuketang.cn', path: '/hd.m3u8' }, response: { status: 200, body: '#EXTM3U\n#EXTINF:10,\nfixture.ts\n#EXT-X-ENDLIST\n' } },
  { request: { method: 'GET', host: 'www.yuketang.cn', path: '/fixture.ts' }, response: { status: 200, body: 'synthetic-browser-video' } },
];
for (const leafId of ['502', '503']) {
  const source = structuredClone(loadFixture('ykt/media').interactions[0]!);
  source.request.path = `/mooc-api/v1/lms/learn/leaf_info/28930736/${leafId}/`;
  source.response.body = { success: true, data: { leaf_type: 0, course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1' } } } };
  interactions.unshift(source);
  interactions.push({ request: { method: 'GET', host: 'www.yuketang.cn', path: '/video-log/get_video_watch_progress/', query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: leafId, snapshot: '1', no_loading: 'true' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { data: { [leafId]: { rate: 1, completed: 1, video_length: 30, last_point: 30 } } } } });
}
class BrowserTransport extends FakeTransport {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const interaction = interactions.find(item => item.request.method === request.method && item.request.host === url.hostname && item.request.path === url.pathname && Object.entries(item.request.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value));
    if (!interaction) throw new Error(`Unregistered browser fixture request: ${request.method} ${url.pathname}`);
    if (url.pathname === '/fixture.ts') await new Promise(resolve => setTimeout(resolve, 2500));
    this.scriptInteractions([interaction]);
    return super.fetch(request);
  }
}
const server = createWebServer({ dataDir: directory, transport: new BrowserTransport() });
const store = new SqliteStateStore(join(directory, 'state.db'));
const profiles = [
  { name: '我的雨课堂', scope: { userId: 'local', profileId: 'browser-ykt', platform: 'ykt' } },
  { name: '我的学堂在线', scope: { userId: 'local', profileId: 'browser-xuetang', platform: 'xuetang' } },
  { name: '我的智慧树', scope: { userId: 'local', profileId: 'browser-zhs', platform: 'zhs' } },
] satisfies { name: string; scope: Scope }[];
const rows: { key: string; value: Json }[] = profiles.map(profile => ({ key: `cli:profile:${encodeURIComponent(profile.name)}`, value: profile }));
const titles = ['数字逻辑与计算机设计', '大学物理（下）', '线性代数', '程序设计基础', '大学心理', '工程伦理'];
for (const [index, title] of titles.entries()) {
  const profile = profiles[index % profiles.length]!;
  const id = index === 0 ? '28930736' : String(100 + index);
  const native = profile.scope.platform === 'ykt' ? { kind: 'ykt' as const, classroomId: id }
    : profile.scope.platform === 'xuetang' ? { kind: 'xuetang' as const, classroomId: id, courseSign: `course-${id}`, skuId: id }
      : { kind: 'zhs-share' as const, recruitAndCourseId: id };
  const course: Course = { ref: { key: 'pending', scope: profile.scope, native }, title, system: null, term: '2026 秋季', teachers: ['示例教师'], locked: false };
  course.ref.key = keyOfCourse(course.ref);
  rows.push({ key: `cli:course:${course.ref.key}`, value: CourseSchema.parse(course) });
}
const now = Date.now();
const states: Job['status'][] = ['running', 'needs-input', 'paused', 'succeeded'];
for (const [index, status] of states.entries()) {
  const job = JobSchema.parse({
    id: `browser-job-${index}`, scope: profiles[index % profiles.length]!.scope,
    kind: index % 2 === 0 ? 'study' : 'export', status,
    createdAtMs: now - (index + 1) * 3600000, updatedAtMs: now - index * 600000,
    nextRunAtMs: null, completed: [7, 3, 2, 12][index], total: [10, 8, 6, 12][index],
    items: index === 1 ? [{ key: 'example-resource', state: 'needs-input', message: '这是一条合成验收记录：部分内容需要人工核对。', artifacts: [] }] : [], warnings: [],
  });
  rows.push({ key: `job:${job.id}`, value: job });
}
await store.commit({ expected: rows.map(row => ({ key: row.key, revision: null })), changes: rows });
await writeSession(store, loadOrCreateMasterKey(directory), { schemaVersion: 1, scope: profiles[0]!.scope, generation: 1, platformUserId: '424242', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: now });
store.close();
server.listen(4312, '127.0.0.1', () => {
  console.log('Synthetic browser fixture: http://127.0.0.1:4312 (synthetic allowlist; no real platform access)');
  console.log(`Synthetic data directory: ${directory}`);
});
const close = () => server.close(() => { rmSync(directory, { recursive: true, force: true }); process.exit(0); });
process.once('SIGINT', close);
process.once('SIGTERM', close);
