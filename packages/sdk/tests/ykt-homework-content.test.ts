import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error opentype.js ships JavaScript without declarations.
import { Font, Glyph, Path } from 'opentype.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLearningClient } from '../src/index.js';
import { NodeArtifactStore } from '../src/runtime/node/artifacts.js';
import { LocalHeavyRenderer } from '../src/runtime/node/render.js';
import { parseHomeworkDraft } from '../src/services/homework-draft.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport } from './helpers/replay.js';
import type { FixtureInteraction } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { AssessmentRef, Json, Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'homework', platform: 'ykt' };
const ref: AssessmentRef = { resource: { course: { scope, key: 'course', native: { kind: 'ykt', classroomId: '10' } }, key: 'resource', native: { kind: 'ykt', leafId: '20', leafInfoId: null } }, kind: 'homework', assessmentId: '30' };
const roots: string[] = [];
const referenceSource = vi.hoisted(() => ({ url: 'https://example.invalid/reference-font', filename: 'reference.otf', bytes: 0, sha256: '' }));
vi.mock('../src/runtime/node/reference-font-source.js', () => ({ REFERENCE_FONT: referenceSource }));
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function remappedFont(character: string): Uint8Array {
  const path = new Path(); path.moveTo(100, 100); path.lineTo(700, 100); path.lineTo(700, 700); path.lineTo(100, 700); path.close();
  return new Uint8Array(new Font({ familyName: 'Homework test', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [
    new Glyph({ name: '.notdef', advanceWidth: 1000, path: new Path() }),
    new Glyph({ name: 'obfuscated', unicode: character.codePointAt(0), advanceWidth: 1000, path }),
  ] }).toArrayBuffer());
}
function exercise(data: Json): FixtureInteraction {
  return { request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/get_exercise_list/30/', query: { classroom_id: '10' }, headers: { xtbz: 'ykt' } }, response: { status: 200, body: { success: true, data } } };
}
async function setup(interactions: FixtureInteraction[]) {
  const root = await mkdtemp(join(tmpdir(), 'homework-content-')); roots.push(root);
  const transport = new FakeTransport(); transport.scriptInteractions(interactions);
  const runtime: Runtime = { transport, state: new MemoryStateStore(), artifacts: new NodeArtifactStore(root), clock: new FakeClock(), masterKey: new Uint8Array(32).fill(1), heavy: null, model: null, log: () => {}, wake: async () => {} };
  return { client: createLearningClient({ scope, runtime }), transport, runtime };
}

describe('Yuketang homework content through the SDK', () => {
  it('rejects a foreign profile before fetching or caching its question assets', async () => {
    const { client, transport } = await setup([]);
    const foreign = structuredClone(ref); foreign.resource.course.scope.profileId = 'another';
    try {
      await expect(client.assessments.get(foreign)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
      expect(transport.calls).toHaveLength(0);
    } finally { await client.close(); }
  });
  it('decodes marked text through the local renderer and exports stable readable bundles across font remapping', async () => {
    const reference = remappedFont('A');
    referenceSource.bytes = reference.length; referenceSource.sha256 = createHash('sha256').update(reference).digest('hex');
    const fetch = vi.fn(async () => new Response(reference)); vi.stubGlobal('fetch', fetch);
    const frames = (character: string, filename: string): FixtureInteraction[] => [
      exercise({ font: `https://www.yuketang.cn/${filename}`, problems: [{ problem_id: 11, content: { ProblemType: 1, Body: `<p>温<span class="xuetangx-com-encrypted-font">${character}</span></p>`, Options: [{ key: 'A', value: '甲' }] } }] }),
      { request: { method: 'GET', host: 'www.yuketang.cn', path: `/${filename}` }, response: { status: 200, base64: Buffer.from(remappedFont(character)).toString('base64') } },
    ];
    const { client, transport, runtime } = await setup([...frames('乙', 'one.ttf'), ...frames('丙', 'two.ttf'), ...frames('丙', 'two.ttf')]);
    const directory = await mkdtemp(join(tmpdir(), 'homework-font-')); roots.push(directory);
    runtime.clock.nowMs = () => Date.now();
    runtime.heavy = new LocalHeavyRenderer({ scope, artifacts: runtime.artifacts, referenceFontDirectory: directory });
    try {
      const first = await client.assessments.get(ref);
      const second = await client.assessments.get(ref);
      expect(first.questions[0]?.body).toMatchObject({ plainText: '温A', decodeState: 'complete' });
      expect(second.fingerprint).toBe(first.fingerprint);
      const created = await client.jobs.createExport({ type: 'assessments', refs: [ref], format: 'homework' });
      const job = await client.jobs.advance(created.id);
      expect(job.status).toBe('succeeded');
      const artifacts = job.items[0]!.artifacts;
      const markdown = await new Response(await runtime.artifacts.open(artifacts.find(item => item.mimeType === 'text/markdown')!.id)).text();
      const yaml = await new Response(await runtime.artifacts.open(artifacts.find(item => item.mimeType === 'application/yaml')!.id)).text();
      expect(markdown).toContain('温A'); expect(markdown).toContain('A. 甲');
      expect(parseHomeworkDraft(yaml).entries[0]?.answer).toEqual({ kind: 'unset' });
      expect(fetch).toHaveBeenCalledTimes(1);
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });
  it('returns readable text and submitted status, while option edits change the question identity', async () => {
    const data = (option: string) => ({ name: '第一章作业', problems: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>选择<b>正确</b>的一项</p>', Options: [{ key: 'A', value: `<p>${option}</p>` }] }, user: { my_count: 1 } }] });
    const { client, transport } = await setup([exercise(data('甲')), exercise(data('乙'))]);
    try {
      const first = await client.assessments.get(ref);
      expect(first.questions[0]?.body.plainText).toBe('选择正确的一项');
      expect(first.questions[0]?.body.markdown).toBe('选择**正确**的一项');
      expect(first.questions[0]?.attemptsUsed).toBe(1);
      const second = await client.assessments.get(ref);
      expect(second.questions[0]?.fingerprint).not.toBe(first.questions[0]?.fingerprint);
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  it('localizes a question image and exposes only the verified local artifact', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADRUhZgAAAABJRU5ErkJggg==';
    const { client, transport, runtime } = await setup([
      exercise({ problems: [{ problem_id: 11, content: { ProblemType: 1, Body: '<p>如图<img src="https://www.yuketang.cn/images/q.png?token=fixture" alt="题图"></p>', Options: [{ key: 'A', value: '甲' }] } }] }),
      { request: { method: 'GET', host: 'www.yuketang.cn', path: '/images/q.png', query: { token: 'fixture' } }, response: { status: 200, headers: { 'content-type': 'image/png' }, base64: png } },
    ]);
    try {
      const assessment = await client.assessments.get(ref);
      expect(assessment.questions[0]?.body.markdown).toMatch(/!\[题图\]\(assets\/[a-f0-9]{64}\.png\)/);
      expect(JSON.stringify(assessment)).not.toContain('token=fixture');
      expect(assessment.assets).toHaveLength(1);
      const asset = assessment.assets![0]!;
      expect(Buffer.from(await new Response(await runtime.artifacts.open(asset.id)).arrayBuffer())).toEqual(Buffer.from(png, 'base64'));
      transport.assertNoExtraScripts();
      expect(transport.calls).toHaveLength(2);
    } finally { await client.close(); }
  });

  it('marks only affected questions incomplete when font data or a trusted image is missing', async () => {
    const { client, transport } = await setup([exercise({ problems: [
      { problem_id: 11, content: { ProblemType: 1, Body: '<span class="xuetangx-com-encrypted-font">温</span>', Options: [{ key: 'A', value: '甲' }] } },
      { problem_id: 12, content: { ProblemType: 1, Body: '<img src="https://evil.invalid/private.png" alt="图">', Options: [{ key: 'A', value: '甲' }] } },
      { problem_id: 13, content: { ProblemType: 6, Body: '<p>正常题</p>' } },
    ] })]);
    try {
      const assessment = await client.assessments.get(ref);
      expect(assessment.questions.map(question => question.body.decodeState)).toEqual(['partial', 'partial', 'not-needed']);
      expect(assessment.questions[0]?.body.plainText).not.toContain('<span');
      expect(transport.calls).toHaveLength(1);
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  it.each([{ name: 'missing problems' }, { problems: [null] }])('rejects malformed exercise data instead of an empty success: %j', async data => {
    const { client } = await setup([exercise(data)]);
    try { await expect(client.assessments.get(ref)).rejects.toMatchObject({ data: { code: 'PROTOCOL' } }); }
    finally { await client.close(); }
  });
});
