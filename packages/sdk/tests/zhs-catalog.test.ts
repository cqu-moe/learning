import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zhsShareCourses, zhsShareOutline, zhsHikeCourses, zhsHikeOutline, parseShareVideoList, parseHikeTree } from '../src/providers/zhs/catalog.js';
import { HOME_KEY, IV } from '../src/providers/zhs/crypto.js';
import { SessionCookieJar, createSessionHttp } from '../src/http/client.js';
import { FakeClock, FakeTransport, loadFixture } from './helpers/replay.js';
import type { CourseRef, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'z1', platform: 'zhs' };
const DATE = 1_728_000_000_000;

function secret(plain: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(HOME_KEY), Buffer.from(IV));
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
      { id: 'f1', name: '讲义', dataType: null, children: [] },
      { id: 'f2', name: '视频', dataType: 1, children: [] }
    ] });
    expect(parsed.nodes.map((n) => n.kind)).toEqual(['unknown', 'video']);
    const transport = new FakeTransport();
    transport.scriptInteractions(loadFixture('zhs/hike-list').interactions);
    const courses = await zhsHikeCourses(makeContext(transport).http, scope);
    expect(courses.items[0]?.ref.native).toEqual({ kind: 'zhs-hike', courseId: '77' });
    expect(courses.items[0]?.title).toBe('校内课A');
    expect(transport.calls.some((c) => c.url.includes('stuViewFile'))).toBe(false);
  });

  it('share outline walks gologin → queryCourse → videolist', async () => {
    const transport = new FakeTransport();
    transport.scriptInteractions(loadFixture('zhs/share-outline').interactions);
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
    const outline = await zhsHikeOutline(makeContext(transport).http, ref);
    expect(outline.value.roots).toHaveLength(1);
    expect(outline.value.roots[0]?.children[0]?.resources[0]?.ref.native).toEqual({ kind: 'zhs-hike', fileId: 'f2' });
  });
});
