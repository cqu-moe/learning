import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { keyOfCourse } from '../src/types/refs.js';
import { parseKgChapterPayload } from '../src/providers/ykt/catalog.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, replay } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { AuthEvent, Outline, OutlineNode, Resource, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'p1', platform: 'ykt' };
const masterKey = new Uint8Array(32).fill(5);

function flattenResources(node: OutlineNode): Resource[] {
  return [...node.resources, ...node.children.flatMap(flattenResources)];
}

function createRuntime(transport: Runtime['transport']): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    artifacts: {
      create: async () => {
        throw new Error('unused');
      },
      resume: async () => {
        throw new Error('unused');
      },
      open: async () => {
        throw new Error('unused');
      },
      remove: async () => {},
    },
    clock: new FakeClock(),
    masterKey,
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

function yktCourseRef(classroomId: string) {
  const native = { kind: 'ykt' as const, classroomId };
  return { scope, key: keyOfCourse({ scope, key: 'pending', native }), native };
}

describe('ykt catalog (T06)', () => {
  it('keeps a KG folder with id zero but never accepts a zero-id leaf', () => {
    const payload = { success: true, data: { course_chapter: { id: 1, name: '根', leaf_list: [], children: [
      { id: 0, name: '目录', leaf_list: [{ id: 12, name: '视频', leaf_type: 0, order: 1 }], children: [] },
    ] } } };
    expect(parseKgChapterPayload(payload).chapters[0]?.leaves[0]?.leafId).toBe('12');
    const invalid = structuredClone(payload);
    invalid.data.course_chapter.children[0]!.leaf_list[0]!.id = 0;
    expect(() => parseKgChapterPayload(invalid)).toThrow(/leaf.*id/i);
  });

  it('nested standard outline keeps root exam, deep resources, and drops empty folders (A062)', async () => {
    const outline = await replay('ykt/nested-outline', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: createRuntime(transport) });
      const result = await client.catalog.outline(yktCourseRef('28930736'));
      return result.value;
    });
    const flattened = (outline as Outline).roots.flatMap(flattenResources);
    expect(flattened).toHaveLength(4);
    const kinds = flattened.map((r) => r.kind).sort();
    expect(kinds).toEqual(['document', 'exam', 'video', 'video']);
    const exam = flattened.find((r) => r.kind === 'exam');
    expect(exam?.path).toEqual(['第1章']);
    const deepVideo = flattened.find((r) => r.title === '嵌套视频');
    expect(deepVideo?.path).toEqual(['第1章', '1.1 小节', '1.1.1 子小节']);
    expect((outline as Outline).completeness).toBe('complete');
  });

  it('kg outline preserves root-level resources and section paths', async () => {
    const outline = await replay('ykt/kg-outline', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: createRuntime(transport) });
      const result = await client.catalog.outline(yktCourseRef('28927419'));
      return result.value;
    });
    const flattened = (outline as Outline).roots.flatMap(flattenResources);
    expect(flattened).toHaveLength(3);
    const rootExam = flattened.find((r) => r.title === '期末考试');
    expect(rootExam).toBeDefined();
    expect(rootExam?.path).toEqual(['课程根节点']);
    const deep = flattened.find((r) => r.title === 'KG 深层视频');
    expect(deep?.path).toEqual(['第一章', '1.1 节点']);
  });

  it('parses the course list into stable Course DTOs', async () => {
    const page = await replay('ykt/courses-list', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: createRuntime(transport) });
      return client.catalog.courses();
    });
    expect(page.items).toHaveLength(2);
    expect(page.completeness).toBe('complete');
    expect(page.items[0]).toMatchObject({
      title: '学术写作',
      system: null,
      term: '20251',
      teachers: ['王老师'],
    });
    expect(page.items[0]?.ref.native).toEqual({ kind: 'ykt', classroomId: '28930736' });
    expect(page.items[0]?.ref.key).toBe(keyOfCourse({ scope, key: 'x', native: { kind: 'ykt', classroomId: '28930736' } }));
  });

  it('resolveCourse parses studentLog URLs', async () => {
    const client = createLearningClient({ scope, runtime: createRuntime(null as never) });
    const ref = await client.catalog.resolveCourse(
      'https://www.yuketang.cn/v2/web/studentLog/28930736?university_id=7&platform_id=3&classroom_id=28930736',
    );
    expect(ref.native).toEqual({ kind: 'ykt', classroomId: '28930736' });
    expect(ref.key).toBe(keyOfCourse({ scope, key: 'x', native: { kind: 'ykt', classroomId: '28930736' } }));
  });

  it('qr login walks pre-info → app-web-login → form web_login → userinfo (A061)', async () => {
    const loginRun = await replay('ykt/qr-login', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: createRuntime(transport) });
      const flow = await client.auth.begin({ method: 'qr' });
      const events: AuthEvent[] = [];
      const consuming = (async () => {
        for await (const event of flow.events) events.push(event);
      })();
      const view = await flow.result;
      await consuming;
      return { view, events };
    });
    const sessionView = loginRun.view;
    expect(sessionView.platformUserId).toBe('424242');
    expect(sessionView.identityVerified).toBe(true);
    expect(sessionView.generation).toBe(1);
    expect(loginRun.events.map((e) => e.type)).toEqual(['qr', 'waiting', 'exchanging', 'authenticated']);
  });

  it('missing leaf id is rejected instead of coerced to 0 (A062)', async () => {
    const { parseStandardChapterPayload } = await import('../src/providers/ykt/catalog.js');
    expect(() =>
      parseStandardChapterPayload({
        success: true,
        data: { course_chapter: [{ id: 1, name: 'c', section_leaf_list: [{ name: '无 id 单元', leaf_type: 0 }] }] },
      }),
    ).toThrow(/id/);
  });

  it('has_kg success=false is a protocol failure, distinct from has:false (A061)', async () => {
    const { parseHasKg } = await import('../src/providers/ykt/catalog.js');
    expect(parseHasKg({ data: { has: false } })).toBeNull();
    expect(() => parseHasKg({ success: false, msg: 'XTBZ IS REQUIRED' })).toThrow(/XTBZ|success/);
  });
});
