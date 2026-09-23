import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';

const scope = { userId: 'local', profileId: 'p1', platform: 'xuetang' as const };
const resource = { course: { scope, key: 'course', native: { kind: 'xuetang' as const, classroomId: '100', courseSign: 'SIGN-A', skuId: '1' } }, key: 'resource', native: { kind: 'xuetang' as const, leafId: '7', leafInfoId: null } };
function runtime(transport: FakeTransport): Runtime {
  return { transport, state: new MemoryStateStore(), clock: new FakeClock(), masterKey: new Uint8Array(32),
    artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
    heavy: null, model: null, log: () => {}, wake: async () => {} };
}

describe('xuetang discussion facade', () => {
  it('resolves a thread, reads one page, and creates an editable draft', async () => {
    const transport = new FakeTransport();
    const root = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/unit/discussion/', query: { product_sign: 'SIGN-A', leaf_id: '7', classroom_id: '100', topic_type: '0', channel: 'xt' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { id: 55, user_id: 77, content: { text: '讨论主题' }, commented: 1 } } };
    const comments = { request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/forum/comment/list/55/', query: { offset: '0', limit: '10', cid: '100', lid: '7' }, headers: { xtbz: 'xt' } }, response: { status: 200, body: { data: { results: [{ id: 9, user_id: 88, content: { text: '已有回复' } }] } } } };
    transport.scriptInteractions([root, root, comments, root, comments]);
    const client = createLearningClient({ scope, runtime: runtime(transport) });
    const ref = await client.discussions.resolve(resource);
    expect(ref.topicId).toBe('55');
    const thread = await client.discussions.get(ref);
    expect(thread.body.plainText).toBe('讨论主题');
    expect(thread.replies).toMatchObject([{ id: '9', body: { plainText: '已有回复' } }]);
    const draft = await client.discussions.draft(ref);
    expect(draft).toMatchObject({ ref, text: '', sourceHash: thread.body.sourceHash, origin: 'user' });
    transport.assertNoExtraScripts();
  });
});
