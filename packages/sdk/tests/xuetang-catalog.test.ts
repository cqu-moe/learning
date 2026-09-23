import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { parseXtxCourseList, parseXtxChapterTree } from '../src/providers/xuetang/catalog.js';
import { chooseExchangeToken } from '../src/providers/xuetang/auth.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, loadFixture, replay } from './helpers/replay.js';
import { FakeWsTransport } from './helpers/ws.js';
import type { Runtime } from '../src/runtime/types.js';
import type { Outline, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'x1', platform: 'xuetang' };

function runtimeOf(transport: Runtime['transport']): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    artifacts: {
      create: async () => { throw new Error('unused'); },
      resume: async () => { throw new Error('unused'); },
      open: async () => { throw new Error('unused'); },
      remove: async () => {},
    },
    clock: new FakeClock(),
    masterKey: new Uint8Array(32).fill(6),
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

describe('xuetang auth (T08, X02)', () => {
  it('ws qr login: seed csrf → wsapp → exchange {s_s} for is_new token', async () => {
    const fixture = loadFixture('xuetang/qr-is-new');
    const wsTransport = new FakeWsTransport();
    wsTransport.scriptInteractions(fixture.interactions);
    const server = wsTransport.connectNext();
    const client = createLearningClient({ scope, runtime: runtimeOf(wsTransport) });
    const flow = await client.auth.begin({ method: 'qr' });
    server.push(JSON.stringify({ op: 'requestlogin', ticket: encodeURIComponent('https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=abc'), expire_seconds: 60 }));
    server.push(JSON.stringify({ op: 'loginsuccess', token: 'old-token', is_new: true, s_s: 'fixture-token' }));
    const view = await flow.result;
    wsTransport.assertNoExtraScripts();
    expect(view.identityVerified).toBe(true);
    expect(view.generation).toBe(1);
  });

  it('chooses the exchange token per is_new branch', () => {
    expect(chooseExchangeToken({ op: 'loginsuccess', token: 'old', is_new: false })).toBe('old');
    expect(chooseExchangeToken({ op: 'loginsuccess', token: 'old', is_new: true, s_s: 'fresh' })).toBe('fresh');
    expect(chooseExchangeToken({ op: 'loginsuccess', token: '', is_new: false })).toBeNull();
  });
});

describe('xuetang catalog (T08)', () => {
  it('course list builds full locators; first page alone is not complete (A081)', async () => {
    const page = await replay('xuetang/courses', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      return client.catalog.courses();
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.ref.native).toEqual({ kind: 'xuetang', classroomId: '100', courseSign: 'SIGN-A', skuId: '900' });
    expect(page.completeness).toBe('unknown');
  });

  it('missing skuId is an error, never 0 (A081)', () => {
    expect(() => parseXtxCourseList({ data: { product_list: [{ classroom_id: 1, course_sign: 's', name: 'x' }] } }, scope)).toThrow(/sku/);
  });

  it('outline keeps root resources and node-id paths distinct from leaf.chapter_id', async () => {
    const outline = await replay('xuetang/outline', async ({ transport }) => {
      const client = createLearningClient({ scope, runtime: runtimeOf(transport) });
      const course = (await client.catalog.courses()).items[0]!;
      const result = await client.catalog.outline(course.ref);
      return result.value;
    });
    const roots = (outline as Outline).roots;
    expect(roots).toHaveLength(2);
    expect(roots[0]?.title).toBe('课程根');
    expect(roots[0]?.resources).toHaveLength(1);
    expect(roots[1]?.children[0]?.resources[0]?.path).toEqual(['第一章', '1.1']);
  });

  it('chapter tree flattening maps tree node ids, not leaf.chapter_id', () => {
    const parsed = parseXtxChapterTree({
      success: true,
      data: { course_chapter: { id: 40, name: 'root', leaf_list: [], children: [
        { id: 41, name: 'c1', leaf_list: [{ id: 7, leafinfo_id: 8, name: 'v', leaf_type: 0, chapter_id: 150, order: 1 }], children: [] }
      ] } },
    });
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]?.leaves[0]?.name).toBe('v');
  });
});
