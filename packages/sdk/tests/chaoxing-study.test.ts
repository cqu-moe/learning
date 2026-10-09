import { describe, expect, it } from 'vitest';
import { createLearningClient } from '../src/index.js';
import { writeSession } from '../src/session/store.js';
import { SessionCookieJar } from '../src/http/client.js';
import { importLegacyCookies } from '../src/auth/legacy.js';
import { LearningError } from '../src/types/errors.js';
import { MemoryStateStore } from './helpers/memory.js';
import { FakeClock, FakeTransport, type FixtureInteraction } from './helpers/replay.js';
import type { Runtime } from '../src/runtime/types.js';
import type { Scope } from '../src/types/refs.js';
import {
  buildChaoxingProgressUrl,
  chaoxingReportEnc,
  parseChaoxingCardsHtml,
  parseChaoxingCourseUrl,
  parseChaoxingOutlineHtml,
} from '../src/providers/chaoxing/study.js';
import { encryptChaoxingLoginField as encryptLoginField } from '../src/providers/chaoxing/auth.js';

const scope: Scope = { userId: 'local', profileId: 'chaoxing-1', platform: 'chaoxing' };
const courseUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=1001&clazzid=2002&cpi=3003&enc=not-stored&t=1';

function runtime(transport: FakeTransport, clock = new FakeClock()): Runtime {
  return {
    transport,
    state: new MemoryStateStore(),
    clock,
    masterKey: new Uint8Array(32).fill(7),
    artifacts: {
      create: async () => { throw Error('unused'); },
      resume: async () => { throw Error('unused'); },
      open: async () => { throw Error('unused'); },
      remove: async () => {},
    },
    heavy: null,
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

describe('chaoxing study', () => {
  it('parses a course URL into a profile-specific course locator', () => {
    expect(parseChaoxingCourseUrl(courseUrl)).toEqual({
      courseId: '1001',
      clazzId: '2002',
      cpi: '3003',
    });
    expect(() => parseChaoxingCourseUrl('https://example.com/mycourse/stu?courseid=1&clazzid=2&cpi=3')).toThrow(/Chaoxing/);
  });

  it('parses outline units and active knowledge nodes without treating folders as videos', () => {
    const html = `<div class="chapter_body">
      <div class="chapter_unit">
        <div class="chapter_item"><div class="catalog_title"><a class="clicktitle">第一单元</a></div></div>
        <div class="catalog_level">
          <ul><li><div class="chapter_item" id="cur400">
            <a class="clicktitle"><span>视频章节</span></a>
            <input type="hidden" value="1" class="knowledgeJobCount"/>
          </div></li></ul>
        </div>
      </div>
    </div>`;
    expect(parseChaoxingOutlineHtml(html)).toEqual([
      { title: '第一单元', children: [{ knowledgeId: '400', title: '视频章节', jobCount: 1 }] },
    ]);
  });

  it('parses only complete video attachments from the embedded card JSON', () => {
    const arg = {
      attachments: [
        { type: 'video', otherInfo: 'nodeId_400-cpi_3003-rt_d-ds_0&discard=1', mid: 'opaque-mid-a', jobid: '7001', attDurationEnc: 'enc-a', attDuration: 90, objectId: 'object-a', property: { name: '第一讲.mp4' }, isPassed: false },
        { type: 'document', objectId: 'object-b' },
      ],
      defaults: {
        fid: '9001',
        userid: '5005',
        cpi: 3003,
        reportUrl: 'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/3003',
        reportTimeInterval: 60,
      },
      knowledgename: '视频章节',
    };
    const html = `<script>mArg = ""; try{ mArg = ${JSON.stringify(arg)}; }catch(e){}</script>`;
    expect(parseChaoxingCardsHtml(html)).toEqual({
      title: '视频章节',
      videos: [
        {
          otherInfo: 'nodeId_400-cpi_3003-rt_d-ds_0',
          mid: 'opaque-mid-a',
          jobid: '7001',
          attDurationEnc: 'enc-a',
          duration: 90,
          objectId: 'object-a',
          title: '第一讲.mp4',
          isPassed: false,
        },
      ],
      defaults: {
        fid: '9001',
        userid: '5005',
        cpi: '3003',
        reportUrl: 'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/3003',
        reportTimeInterval: 60,
      },
    });
    expect(parseChaoxingCardsHtml('<script>mArg = ""; mArg = $mArg;</script>').videos).toEqual([]);
  });

  it('rejects an incomplete video attachment instead of synthesizing progress', () => {
    const arg = {
      attachments: [{ type: 'video', objectId: 'object-incomplete' }],
      defaults: {
        fid: '9001',
        userid: '5005',
        cpi: 3003,
        reportUrl: 'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/3003',
        reportTimeInterval: 60,
      },
      knowledgename: '视频章节',
    };
    expect(() => parseChaoxingCardsHtml(`<script>mArg = ${JSON.stringify(arg)};</script>`))
      .toThrow(/video attachment is incomplete/);
  });

  it('builds the official progress hash and query in the captured field order', () => {
    const options = {
      clazzId: '152504698',
      userid: '424031336',
      jobid: '1755676041021452',
      objectId: '33d8b9bbc9853b697dbedb5b509a2682',
      playingTime: 0,
      duration: 623,
      cpi: '510392016',
      dtoken: 'synthetic-dtoken',
      otherInfo: 'other-info',
      courseId: '266291551',
      timestampMs: 1_728_000_000_000,
      attDuration: 623,
      attDurationEnc: 'att-duration-enc',
    };
    expect(chaoxingReportEnc(options)).toBe('eeaa6790658ca7189d4cc112224450a1');
    expect(buildChaoxingProgressUrl(options)).toBe(
      'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/510392016/synthetic-dtoken' +
      '?clazzId=152504698&playingTime=0&duration=623&clipTime=0_623' +
      '&objectId=33d8b9bbc9853b697dbedb5b509a2682&otherInfo=other-info' +
      '&courseId=266291551&jobid=1755676041021452&userid=424031336&isdrag=3&view=pc' +
      '&enc=eeaa6790658ca7189d4cc112224450a1&rt=0.9&dtype=Video&_t=1728000000000' +
      '&attDuration=623&attDurationEnc=att-duration-enc&courseEngineInfo=false',
    );
  });
});

describe('chaoxing SDK integration', () => {
  it('encrypts login fields with the independent AES-CBC vector and logs in exactly once', async () => {
    await expect(encryptLoginField('13800138000')).resolves.toBe('yYcVatS+4J+JGnm88UM56A==');
    await expect(encryptLoginField('p@ss w0rd!')).resolves.toBe('qRMp6h+9mkdLaCCCOm7pmA==');
    const transport = new FakeTransport();
    const clientRuntime = runtime(transport);
    const client = createLearningClient({ scope, runtime: clientRuntime });
    const form = new URLSearchParams({
      fid: '-1',
      uname: 'yYcVatS+4J+JGnm88UM56A==',
      password: 'qRMp6h+9mkdLaCCCOm7pmA==',
      refer: 'https%3A%2F%2Fi.chaoxing.com',
      t: 'true',
      forbidotherlogin: '0',
      validate: '',
      doubleFactorLogin: '0',
      independentId: '0',
    }).toString();
    transport.scriptInteractions([
      {
        request: {
          method: 'POST',
          host: 'passport2.chaoxing.com',
          path: '/fanyalogin',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
          },
          body: form,
        },
        response: {
          status: 200,
          headers: { 'set-cookie': 'UID=login-cookie; Domain=.chaoxing.com; Path=/; Secure; HttpOnly' },
          body: { status: true },
        },
      },
      {
        request: { method: 'GET', host: 'i.chaoxing.com', path: '/base' },
        response: { status: 200, body: '<html>welcome uid: "123456"</html>' },
      },
    ]);

    const flow = await client.auth.begin({ method: 'password', username: '13800138000', password: 'p@ss w0rd!' });
    await expect(flow.result).resolves.toMatchObject({ platformUserId: '123456', identityVerified: true });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.bodyText).toBe(form);
    transport.assertNoExtraScripts();

    const secondTransport = new FakeTransport();
    secondTransport.scriptInteractions([{
      request: { method: 'GET', host: 'i.chaoxing.com', path: '/base' },
      response: { status: 200, body: '<html>welcome uid: "123456"</html>' },
    }]);
    const persistedClient = createLearningClient({ scope, runtime: { ...clientRuntime, transport: secondTransport } });
    await expect(persistedClient.auth.probe()).resolves.toMatchObject({ state: 'valid' });
    expect(secondTransport.calls[0]?.headers.cookie).toContain('UID=login-cookie');
    secondTransport.assertNoExtraScripts();
  });

  it('rejects wrong credentials and captcha without a base probe or session write', async () => {
    const login = (body: { status: boolean; msg2: string }): FixtureInteraction => ({
      request: {
        method: 'POST',
        host: 'passport2.chaoxing.com',
        path: '/fanyalogin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
      response: { status: 200, body },
    });

    for (const [payload, message] of [
      [{ status: false, msg2: '用户名或密码错误' }, /wrong credentials|用户名或密码错误/],
      [{ status: false, msg2: '请输入验证码' }, /manual verification|验证码/],
    ] as const) {
      const transport = new FakeTransport();
      transport.scriptInteractions([login(payload)]);
      const clientRuntime = runtime(transport);
      const client = createLearningClient({ scope, runtime: clientRuntime });
      const flow = await client.auth.begin({ method: 'password', username: 'fixture-user', password: 'fixture-password' });
      await expect(flow.result).rejects.toBeInstanceOf(LearningError);
      await expect(flow.result).rejects.toMatchObject({ data: { code: 'AUTH_REQUIRED', message } });
      transport.assertNoExtraScripts();
      const { readSession } = await import('../src/session/store.js');
      expect(await readSession(clientRuntime.state, clientRuntime.masterKey, scope)).toBeNull();
    }
  });

  it('reports protocol failures and network loss as distinct errors without retry', async () => {
    const request = {
      method: 'POST',
      host: 'passport2.chaoxing.com',
      path: '/fanyalogin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
    const protocol = new FakeTransport();
    protocol.scriptInteractions([{ request, response: { status: 200, body: 'not-json' } }]);
    const protocolClient = createLearningClient({ scope, runtime: runtime(protocol) });
    const protocolFlow = await protocolClient.auth.begin({ method: 'password', username: 'fixture-user', password: 'fixture-password' });
    await expect(protocolFlow.result).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
    protocol.assertNoExtraScripts();

    const redirect = new FakeTransport();
    redirect.scriptInteractions([{
      request,
      response: { status: 302, headers: { location: 'https://passport2.chaoxing.com/fanyalogin' }, body: '' },
    }]);
    const redirectClient = createLearningClient({ scope, runtime: runtime(redirect) });
    const redirectFlow = await redirectClient.auth.begin({ method: 'password', username: 'fixture-user', password: 'fixture-password' });
    await expect(redirectFlow.result).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
    expect(redirect.calls).toHaveLength(1);

    const network = new FakeTransport();
    network.failNext(Error('connection reset'));
    const networkClient = createLearningClient({ scope, runtime: runtime(network) });
    const networkFlow = await networkClient.auth.begin({ method: 'password', username: 'fixture-user', password: 'fixture-password' });
    await expect(networkFlow.result).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
    expect(network.calls).toHaveLength(1);
  });

  it('promotes imported cookies only after the Chaoxing base page exposes a safe user id', async () => {
    const transport = new FakeTransport();
    const clientRuntime = runtime(transport);
    await importLegacyCookies(clientRuntime, scope, [{ name: 'UID', value: 'fixture', domain: '.chaoxing.com', secure: true }]);
    transport.scriptInteractions([{
      request: { method: 'GET', host: 'i.chaoxing.com', path: '/base' },
      response: { status: 200, body: '<html><body>welcome, uid: "123456"</body></html>' },
    }]);
    expect(await createLearningClient({ scope, runtime: clientRuntime }).auth.probe()).toMatchObject({
      state: 'valid',
      session: { platformUserId: '123456', identityVerified: true },
    });
    transport.assertNoExtraScripts();

    const denied = new FakeTransport();
    const deniedRuntime = runtime(denied);
    await importLegacyCookies(deniedRuntime, scope, [{ name: 'UID', value: 'stale', domain: '.chaoxing.com', secure: true }]);
    denied.scriptInteractions([{
      request: { method: 'GET', host: 'i.chaoxing.com', path: '/base' },
      response: { status: 200, body: '<script src="https://passport2.chaoxing.com/login?service=base"></script>请登录' },
    }]);
    expect((await createLearningClient({ scope, runtime: deniedRuntime }).auth.probe()).state).toBe('expired');
    const { readSession } = await import('../src/session/store.js');
    expect(await readSession(deniedRuntime.state, deniedRuntime.masterKey, scope)).toMatchObject({ identityVerified: false });
    denied.assertNoExtraScripts();
  });

  it('resolves and outlines video resources with exact read requests', async () => {
    const transport = new FakeTransport();
    const client = createLearningClient({ scope, runtime: runtime(transport) });
    const course = await client.catalog.resolveCourse(courseUrl);
    expect(course.native).toEqual({ kind: 'chaoxing', courseId: '1001', clazzId: '2002', cpi: '3003' });

    const outlineHtml = `<div class="chapter_body"><div class="chapter_unit">
      <div class="catalog_title"><a class="clicktitle">第一单元</a></div>
      <div class="catalog_level"><ul><li><div id="cur400"><a class="clicktitle">视频章节</a><input class="knowledgeJobCount" value="1"/></div></li></ul></div>
      </div></div>`;
    const cardArg = {
      attachments: [{ type: 'video', otherInfo: 'other-a', mid: 'opaque-mid-a', jobid: '7001', attDurationEnc: 'enc-a', attDuration: 90, objectId: 'object-a', property: { name: '第一讲.mp4' }, isPassed: false }],
      defaults: { fid: '9001', userid: '5005', cpi: 3003, reportUrl: 'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/3003', reportTimeInterval: 60 },
      knowledgename: '视频章节',
    };
    const cardHtml = `<script>mArg = ""; try{ mArg = ${JSON.stringify(cardArg)}; }</script>`;
    transport.scriptInteractions([
      {
        request: { method: 'GET', host: 'mooc2-ans.chaoxing.com', path: '/mooc2-ans/mycourse/studentcourse', query: { courseid: '1001', clazzid: '2002', cpi: '3003', ut: 's' } },
        response: { status: 200, body: outlineHtml },
      },
      {
        request: { method: 'GET', host: 'mooc1.chaoxing.com', path: '/mooc-ans/knowledge/cards', query: { clazzid: '2002', courseid: '1001', knowledgeid: '400', num: '0', ut: 's', cpi: '3003', v: '2025-0424-1038-3', mooc2: '1' } },
        response: { status: 200, body: cardHtml },
      },
      {
        request: { method: 'GET', host: 'mooc1.chaoxing.com', path: '/mooc-ans/knowledge/cards', query: { clazzid: '2002', courseid: '1001', knowledgeid: '400', num: '1', ut: 's', cpi: '3003', v: '2025-0424-1038-3', mooc2: '1' } },
        response: { status: 200, body: '<script>mArg = ""; mArg = $mArg;</script>' },
      },
    ]);
    const outline = await client.catalog.outline(course);
    const videos: unknown[] = [];
    const walk = (nodes: typeof outline.value.roots): void => {
      for (const node of nodes) {
        videos.push(...node.resources);
        walk(node.children);
      }
    };
    walk(outline.value.roots);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ title: '第一讲.mp4', kind: 'video', durationSeconds: 90 });
    transport.assertNoExtraScripts();
  });

  it('sends official reports at the server interval and requires pass at full completion', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(7);
    await writeSession(state, masterKey, {
      schemaVersion: 1,
      scope,
      generation: 1,
      platformUserId: '5005',
      identityVerified: true,
      cookieJar: await new SessionCookieJar().serialize(),
      displayName: null,
      checkedAtMs: clock.nowMs(),
    });
    const withState: Runtime = { ...runtime(transport, clock), state };
    const client = createLearningClient({ scope, runtime: withState });
    const courseRef = {
      scope,
      key: 'course-key',
      native: { kind: 'chaoxing' as const, courseId: '1001', clazzId: '2002', cpi: '3003' },
    };
    const resource = {
      course: courseRef,
      key: 'resource-key',
      native: {
        kind: 'chaoxing' as const,
        knowledgeId: '400',
        cardIndex: 0,
        objectId: 'object-a',
        jobid: '7001',
        mid: 'opaque-mid-a',
      },
    };
    const attachment = { type: 'video', otherInfo: 'other-a', mid: 'opaque-mid-a', jobid: '7001', attDurationEnc: 'enc-a', attDuration: 90, objectId: 'object-a', property: { name: '第一讲.mp4' }, isPassed: false };
    const cardArg = {
      attachments: [attachment],
      defaults: { fid: '9001', userid: '5005', cpi: 3003, reportUrl: 'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/3003', reportTimeInterval: 60 },
      knowledgename: '视频章节',
    };
    const cardHtml = `<script>mArg = ""; try{ mArg = ${JSON.stringify(cardArg)}; }</script>`;
    const card = (passed: boolean): FixtureInteraction => ({
      request: { method: 'GET', host: 'mooc1.chaoxing.com', path: '/mooc-ans/knowledge/cards', query: { clazzid: '2002', courseid: '1001', knowledgeid: '400', num: '0', ut: 's', cpi: '3003', v: '2025-0424-1038-3', mooc2: '1' } },
      response: { status: 200, body: cardHtml.replace('"isPassed":false', `"isPassed":${passed}`) },
    });
    const status: FixtureInteraction = {
      request: {
        method: 'GET',
        host: 'mooc1.chaoxing.com',
        path: '/ananas/status/object-a',
        query: { k: '9001', flag: 'normal' },
        headers: {
          referer: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=2025-0725-1842',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        },
      },
      response: { status: 200, body: { status: 'success', dtoken: 'status-token', duration: 90 } },
    };
    const report = (playingTime: number, passed: boolean): FixtureInteraction => ({
      request: {
        method: 'GET',
        host: 'mooc1.chaoxing.com',
        path: '/mooc-ans/multimedia/log/a/3003/status-token',
        query: {
          clazzId: '2002',
          playingTime: String(playingTime),
          duration: '90',
          clipTime: '0_90',
          objectId: 'object-a',
          otherInfo: 'other-a',
          courseId: '1001',
          jobid: '7001',
          userid: '5005',
          isdrag: '3',
          view: 'pc',
          enc: chaoxingReportEnc({ clazzId: '2002', userid: '5005', jobid: '7001', objectId: 'object-a', playingTime, duration: 90 }),
          rt: '0.9',
          dtype: 'Video',
          _t: String(clock.nowMs()),
          attDuration: '90',
          attDurationEnc: 'enc-a',
          courseEngineInfo: 'false',
        },
      },
      response: { status: 200, body: { isPassed: passed, videoTimeLimit: false, hasJobLimit: false } },
    });

    const preview = await client.actions.prepare({
      kind: 'study',
      resources: [resource],
      settings: { speed: 1, targetFraction: 1, questionMode: 'pause', maxDurationSeconds: 300 },
    });
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('study did not create a job');

    transport.scriptInteractions([card(false), status, report(0, false)]);
    const started = await client.jobs.advance(execution.job.id);
    expect(started.status).toBe('waiting');
    expect(started.nextRunAtMs).toBe(clock.nowMs() + 60_000);

    clock.setNow(clock.nowMs() + 60_000);
    transport.scriptInteractions([card(false), status, report(60, false)]);
    const middle = await client.jobs.advance(execution.job.id);
    expect(middle.status).toBe('waiting');

    clock.setNow(clock.nowMs() + 30_000);
    transport.scriptInteractions([card(false), status, report(90, true), card(true)]);
    const done = await client.jobs.advance(execution.job.id);
    expect(done).toMatchObject({ status: 'succeeded', completed: 1, items: [{ key: 'resource-key', state: 'succeeded' }] });
    transport.assertNoExtraScripts();
  });
});
