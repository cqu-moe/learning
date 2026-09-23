import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zhsShareCourses, zhsShareOutline, zhsHikeCourses, zhsHikeOutline, parseShareVideoList, parseHikeTree } from '../src/providers/zhs/catalog.js';
import { HOME_KEY, VIDEO_KEY, IV } from '../src/providers/zhs/crypto.js';
import { SessionCookieJar, createSessionHttp } from '../src/http/client.js';
import { FakeClock, FakeTransport, loadFixture } from './helpers/replay.js';
import type { CourseRef, Scope } from '../src/public.js';
import { createLearningClient } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import type { Runtime } from '../src/runtime/types.js';

const scope: Scope = { userId: 'local', profileId: 'z1', platform: 'zhs' };
const DATE = 1_728_000_000_000;

function secret(plain: string, key = HOME_KEY): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV));
  return Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]).toString('base64');
}

function makeContext(transport: FakeTransport) {
  const clock = new FakeClock();
  clock.setNow(DATE);
  return { http: createSessionHttp({ transport, clock, jar: new SessionCookieJar(), allowHosts: ['zhihuishu.com'] }), clock };
}

function shareFixture() {
  const fixture = loadFixture('zhs/share-list');
  fixture.interactions[0]!.request.query = { secretStr: secret('{"status":0,"pageNo":1,"pageSize":5}'), date: String(DATE) };
  fixture.interactions[1]!.request.query = { secretStr: secret('{"status":0,"pageNo":2,"pageSize":5}'), date: String(DATE) };
  return fixture;
}

describe('zhs catalog (T11)', () => {
  it('uses the observed share-course secret as recruitAndCourseId when that field is absent', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions([{ request: { method: 'GET', host: 'onlineservice-api.zhihuishu.com', path: '/gateway/t/v1/student/course/share/queryShareCourseInfo', query: { secretStr: secret('{"status":0,"pageNo":1,"pageSize":5}'), date: String(DATE) } }, response: { status: 200, body: { code: 200, result: { totalCount: 1, courseOpenDtos: [{ secret: 'fixture-rac', courseId: 55, recruitId: 66, courseName: '课程' }] } } } }]);
    const { http, clock } = makeContext(transport);
    const courses = await zhsShareCourses(http, clock, scope);
    expect(courses.items[0]?.ref.native).toEqual({ kind: 'zhs-share', recruitAndCourseId: 'fixture-rac' });
    transport.assertNoExtraScripts();
  });

  it('share list pages at pageSize 5 and does not miss the tail (A111)', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions(shareFixture().interactions);
    const { http, clock } = makeContext(transport);
    const rows: unknown[] = [];
    const page = await zhsShareCourses(http, clock, scope);
    {
      rows.push(...page.items);
    }
    expect(rows).toHaveLength(6);
    expect(transport.calls.filter((c) => c.url.includes('queryShareCourseInfo'))).toHaveLength(2);
    expect(transport.calls.some((c) => c.url.includes('saveDatabaseIntervalTimeV2') || c.url.includes('stuViewFile'))).toBe(false);
  });

  it('single-video lessons keep the smallLessonId=0 sentinel; same videoId in two places stays distinct', () => {
    const parsed = parseShareVideoList({
      data: {
        courseId: 55,
        videoChapterDtos: [
          { id: 1, name: 'ch1', videoLessons: [
            { id: 10, name: 'l1', videoId: 'V1', videoLessons: undefined },
            { id: 11, name: 'l2', videoSmallLessons: [
              { id: 1, videoId: 'V1', lessonId: 11, name: 'v in l2', videoSec: 30 },
              { id: 2, videoId: 'V1', lessonId: 11, name: 'v again', videoSec: 30 }
            ] }
          ] }
        ]
      }
    });
    expect(parsed.leaves).toHaveLength(3);
    expect(parsed.leaves[0]?.smallLessonId).toBe('0');
    const keys = new Set(parsed.leaves.map((leaf) => [leaf.chapterId, leaf.lessonId, leaf.smallLessonId, leaf.videoId].join('|')));
    expect(keys.size).toBe(3);
  });

  it('hike tree keeps dataType null as unknown and never calls viewFile (A212/A112)', async () => {
    const parsed = parseHikeTree({ rt: [
      { id: 'f1', name: '讲义', dataType: null, childList: [] },
      { id: 'f2', name: '视频', dataType: 3, childList: [] }
    ] });
    expect(parsed.nodes.map((n) => n.kind)).toEqual(['unknown', 'video']);
    const transport = new FakeTransport();
    transport.scriptInteractions(loadFixture('zhs/hike-list').interactions);
    const context = makeContext(transport);
    const courses = await zhsHikeCourses(context.http, context.clock, scope, 'u-fixture');
    expect(courses.items[0]?.ref.native).toEqual({ kind: 'zhs-hike', courseId: '77' });
    expect(courses.items[0]?.title).toBe('校内课A');
    expect(transport.calls.some((c) => c.url.includes('stuViewFile'))).toBe(false);
  });

  it('share outline walks gologin → queryCourse → videolist', async () => {
    const transport = new FakeTransport();
    const fixture = loadFixture('zhs/share-outline');
    fixture.interactions[1]!.request.body = `secretStr=${encodeURIComponent(secret('{"recruitAndCourseId":"R1","dateFormate":1728000000000}', VIDEO_KEY))}&dateFormate=${DATE}`;
    fixture.interactions[2]!.request.body = fixture.interactions[1]!.request.body;
    transport.scriptInteractions(fixture.interactions);
    const ref: CourseRef = { scope, key: 'k', native: { kind: 'zhs-share', recruitAndCourseId: 'R1' } };
    const { http, clock } = makeContext(transport);
    const outline = await zhsShareOutline(http, clock, ref);
    expect(outline.value.roots).toHaveLength(1);
    expect(outline.value.roots[0]?.resources[0]?.title).toBe('第一节');
    expect(outline.value.roots[0]?.resources[0]?.ref.native).toEqual({ kind: 'zhs-share', chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' });
  });

  it('hike outline uses queryResourceMenuTree (startInngcourseList spelling preserved upstream)', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions(loadFixture('zhs/hike-tree').interactions);
    const ref: CourseRef = { scope, key: 'k', native: { kind: 'zhs-hike', courseId: '77' } };
    const context = makeContext(transport);
    const outline = await zhsHikeOutline(context.http, context.clock, ref);
    expect(outline.value.roots).toHaveLength(1);
    expect(outline.value.roots[0]?.children[0]?.resources[0]?.ref.native).toEqual({ kind: 'zhs-hike', fileId: 'f2' });
  });

  it('reads hike file progress from the resource tree without visiting the file', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions([{ request: { method: 'GET', host: 'studyresources.zhihuishu.com', path: '/studyResources/stuResouce/queryResourceMenuTree', query: { courseId: '77', _: String(DATE) } }, response: { status: 200, body: { rt: [{ id: 'f2', name: '视频', dataType: 3, studyTime: 30, totalTime: 100, childList: [] }] } } }]);
    const ref = { course: { scope, key: 'course', native: { kind: 'zhs-hike' as const, courseId: '77' } }, key: 'video', native: { kind: 'zhs-hike' as const, fileId: 'f2' } };
    const clock = new FakeClock();
    const runtime: Runtime = { transport, state: new MemoryStateStore(), clock, masterKey: new Uint8Array(32),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    expect((await createLearningClient({ scope, runtime }).catalog.progress(ref)).value).toMatchObject({ serverFraction: 0.3, serverSeconds: 30, durationSeconds: 100, serverCompleted: false });
    expect(transport.calls.some((call) => call.url.includes('stuViewFile'))).toBe(false);
    transport.assertNoExtraScripts();
  });

  it('reads share watch state through studyservice without sending save', async () => {
    const transport = new FakeTransport();
    const encrypted = (plain: string) => `secretStr=${encodeURIComponent(secret(plain, VIDEO_KEY))}&dateFormate=${DATE}`;
    const headers = { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1', 'content-type': 'application/x-www-form-urlencoded' };
    transport.scriptInteractions([
      { request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/login/gologin', query: { fromurl: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1' } }, response: { status: 200, body: {} } },
      { request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/learning/queryCourse', headers, body: encrypted('{"recruitAndCourseId":"R1","dateFormate":1728000000000}') }, response: { status: 200, body: { code: 0, data: { recruitId: 9, courseInfo: { courseId: 44 } } } } },
      { request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/learning/videolist', headers, body: encrypted('{"recruitAndCourseId":"R1","dateFormate":1728000000000}') }, response: { status: 200, body: { code: 0, data: { courseId: 55, videoChapterDtos: [{ id: 1, name: '章', videoLessons: [{ id: 10, name: '节', videoId: 'V1', videoSec: 100 }] }] } } } },
      { request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/learning/queryStuyInfo', headers, body: encrypted('{"lessonIds":[10],"lessonVideoIds":[],"recruitId":9,"dateFormate":1728000000000}') }, response: { status: 200, body: { code: 0, data: { lv: {}, lesson: { '10': { watchState: 0, studyTotalTime: 30 } } } } } },
    ]);
    const clock = new FakeClock();
    const runtime: Runtime = { transport, state: new MemoryStateStore(), clock, masterKey: new Uint8Array(32),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const resource = { course: { scope, key: 'course', native: { kind: 'zhs-share' as const, recruitAndCourseId: 'R1' } }, key: 'video', native: { kind: 'zhs-share' as const, chapterId: '1', lessonId: '10', smallLessonId: '0', videoId: 'V1' } };
    expect((await createLearningClient({ scope, runtime }).catalog.progress(resource)).value).toMatchObject({ serverFraction: 0.3, serverSeconds: 30, durationSeconds: 100, serverCompleted: false });
    expect(transport.calls.some((call) => call.url.includes('saveDatabaseIntervalTimeV2'))).toBe(false);
    transport.assertNoExtraScripts();
  });
});
