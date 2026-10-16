import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesCipher, HOME_KEY, VIDEO_KEY, WatchPoint, getEv, hikeSign, hms, revEv } from '../src/providers/zhs/crypto.js';
import { zhsQrLaunch } from '../src/providers/zhs/auth.js';
import { md5Hex } from '../src/providers/zhs/md5.js';
import { AuthLifecycle } from '../src/auth/flow.js';
import { MemoryStateStore } from './helpers/memory.js';
import { replay } from './helpers/replay.js';
import { loadFixture, FakeClock, FakeTransport } from './helpers/replay.js';
import { createLearningClient } from '../src/index.js';
import type { Runtime } from '../src/runtime/types.js';
import { readSession, writeSession } from '../src/session/store.js';
import type { Scope } from '../src/public.js';

const scope: Scope = { userId: 'local', profileId: 'z1', platform: 'zhs' };

describe('zhs crypto (T10, A101)', () => {
  it('md5 matches RFC 1321 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('decrypts the online HOME reference vector', async () => {
    expect(await new AesCipher(HOME_KEY).decrypt('LuNpV83QUU4T5C+UCYd2trCagnzKhl9z2BfOZUhqMqw=')).toBe('{"schoolId":116}');
  });

  it('round-trips chinese, empty, and 16-byte boundary inputs with byte padding', async () => {
    const cipher = new AesCipher(VIDEO_KEY);
    for (const plain of ['{"a":"你好"}', '', 'x'.repeat(16), 'x'.repeat(17)]) {
      const sealed = await cipher.encrypt(plain);
      expect(await cipher.decrypt(sealed)).toBe(plain);
      expect(Buffer.from(sealed, 'base64').length % 16).toBe(0);
    }
  });

  it('get_ev matches the hand-computed vector and rev_ev inverts it', () => {
    expect(getEv([1, 2, 3, 4, '你'])).toBe('4b41424f475150414f1a');
    expect(revEv(getEv([1, 2, 3, 4]))).toBe('1;2;3;4');
  });

  it('watchPoint follows the official sequence vectors', () => {
    const wp = new WatchPoint();
    wp.add(10);
    expect(wp.get()).toBe('0,1,2,2,3,3,3');
    wp.add(20);
    expect(wp.get()).toBe('0,1,2,2,3,3,3,4,4,4,5,5,6');
    wp.reset(20);
    expect(wp.get()).toBe('0,1');
  });

  it('hike sign uses the fixed field order and salt; hms formats', () => {
    const raw = 'o6xpt3b#Qy$Z' + 'u1' + 'c1' + 'f1' + '30' + '1000' + '2000' + '60' + '30' + 'u1';
    expect(hikeSign('u1', 'c1', 'f1', 30, 1000, 2000, 60, 30)).toBe(createHash('md5').update(raw, 'utf8').digest('hex'));
    expect(hms(283)).toBe('0:04:43');
    expect(hms(61)).toBe('0:01:01');
  });
});

describe('zhs native qr login (T10, Z02)', () => {
  it('img → poll status 1 → pwd finish sets CASLOGC; session stays unverified (E04)', async () => {
    const result = await replay('zhs/qr-login', async ({ transport, clock }) => {
      const state = new MemoryStateStore();
      const masterKey = new Uint8Array(32).fill(9);
      const lifecycle = new AuthLifecycle({ scope, clock, state, masterKey });
      const { SessionCookieJar } = await import('../src/http/client.js');
      const { createSessionHttp } = await import('../src/http/client.js');
      const jar = new SessionCookieJar();
      const http = createSessionHttp({ transport, clock, jar, allowHosts: ['zhihuishu.com'] });
      const flow = lifecycle.begin(zhsQrLaunch({ http, jar, clock }));
      const view = await flow.result;
      return { view, state, masterKey };
    });
    expect(result.view.identityVerified).toBe(false);
    expect(result.view.platformUserId).toBeNull();
    const { readSession } = await import('../src/session/store.js');
    const record = await readSession(result.state, result.masterKey, scope);
    expect(record).not.toBeNull();
    const { SessionCookieJar } = await import('../src/http/client.js');
    const restored = await SessionCookieJar.deserialize(record!.cookieJar);
    expect(await restored.cookieValue(new URL('https://passport.zhihuishu.com'), 'CASLOGC')).toBe('uuid-fixture');
  });
});

describe('zhs default WeChat QR API flow', () => {
  async function beginWechat(body: string, code: string | null, includeWaiting = false, configure?: (fixture: ReturnType<typeof loadFixture>, service: string) => void, responseLossPath?: string) {
    const fixture = loadFixture('zhs/wechat-qr');
    const service = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=https://onlineweb.zhihuishu.com/onlinestuh5';
    const redirect = `https://user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin?service=${encodeURIComponent(service)}`;
    fixture.interactions[0]!.request.query = { appid: 'wx3f96cd4b1dc1f574', scope: 'snsapi_login', redirect_uri: redirect, state: 'https://login.zhihuishu.com/wxTransit/0', login_type: 'jssdk', self_redirect: 'false' };
    fixture.interactions[0]!.request.headers = { referer: 'https://login.zhihuishu.com/' };
    for (const [index, row] of fixture.interactions.slice(2, 5).entries()) row.request.query = { uuid: 'WXUUID1', _: String(1728000000000 + index * 2000) };
    fixture.interactions[4]!.response.body = body;
    fixture.interactions[5]!.request.query = { service, code: code ?? '', state: 'https://login.zhihuishu.com/wxTransit/0' };
    configure?.(fixture, service);
    if (!includeWaiting) {
      fixture.interactions.splice(2, 2);
      fixture.interactions[2]!.request.query = { uuid: 'WXUUID1', _: '1728000000000' };
    }
    class ResponseLossTransport extends FakeTransport {
      override async fetch(request: Request): Promise<Response> {
        const response = await super.fetch(request);
        if (new URL(request.url).pathname === responseLossPath) throw new TypeError('fixture response lost');
        return response;
      }
    }
    const transport = new ResponseLossTransport();
    transport.scriptInteractions(code === null ? fixture.interactions.slice(0, -1) : fixture.interactions);
    const clock = new FakeClock();
    const runtime: Runtime = { transport, clock, state: new MemoryStateStore(), masterKey: new Uint8Array(32).fill(9),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const client = createLearningClient({ scope, runtime });
    const flow = await client.auth.begin({ method: 'qr' });
    return { client, flow, runtime, transport };
  }

  it.each([
    { name: 'single-quoted alphanumeric code', body: "window.wx_errcode=405;window.wx_code='CODE1';", code: 'CODE1', includeWaiting: true },
    { name: 'code containing underscore', body: "window.wx_errcode=405;window.wx_code='CODE_1';", code: 'CODE_1' },
    { name: 'code containing hyphen', body: "window.wx_errcode=405;window.wx_code='CODE-1';", code: 'CODE-1' },
    { name: 'double-quoted code', body: 'window.wx_errcode=405;window.wx_code="CODE1";', code: 'CODE1' },
    { name: 'assignment whitespace', body: "window.wx_errcode = 405;\nwindow.wx_code = 'CODE1';", code: 'CODE1' },
  ])('exchanges a confirmed $name without exposing the code', async ({ body, code, includeWaiting }) => {
    const { client, flow, runtime, transport } = await beginWechat(body, code, includeWaiting);
    try {
      const view = await flow.result;
      const events = [];
      for await (const event of flow.events) events.push(event);
      expect(view.identityVerified).toBe(false);
      expect(view.platformUserId).toBe('u1');
      expect(events.map(event => event.type)).toEqual(includeWaiting ? ['qr', 'waiting', 'scanned', 'exchanging', 'authenticated'] : ['qr', 'waiting', 'exchanging', 'authenticated']);
      expect(JSON.stringify(events)).not.toContain(code);
      expect(JSON.stringify(events)).not.toContain('%7B%22uuid');
      expect(await readSession(runtime.state, runtime.masterKey, scope)).toMatchObject({ generation: view.generation });
      transport.assertNoExtraScripts();
    } finally {
      await client.close();
    }
  });

  it('publishes the actual JPEG image format from the WeChat endpoint', async () => {
    const { client, flow, transport } = await beginWechat("window.wx_errcode=405;window.wx_code='CODE1';", 'CODE1');
    try {
      await flow.result;
      const events = [];
      for await (const event of flow.events) events.push(event);
      expect(events[0]).toMatchObject({ type: 'qr', qr: { type: 'jpeg' } });
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  async function beginTransit(options: { locked?: boolean; hasMobile?: boolean; hasCertify?: boolean; missingPwd?: boolean; isNew?: boolean; schools?: 'same' | 'different'; oversizedAt?: 'cache' | 'skipSet'; lostAt?: 'oauth' | 'skipSet' | 'passport' } = {}) {
    const responseLossPath = options.lostAt === 'oauth' ? '/zhsuser/oauth/weixin/wxLogin' : options.lostAt === 'skipSet' ? '/zhsuser/login/code/skipSet/CACHE1' : options.lostAt === 'passport' ? '/login' : undefined;
    return beginWechat("window.wx_errcode=405;window.wx_code='CODE1';", 'CODE1', false, (fixture, service) => {
      const transitUrl = new URL('https://login.zhihuishu.com/wxTransit/0');
      transitUrl.searchParams.set('cacheId', 'CACHE1');
      transitUrl.searchParams.set('isLock', options.locked ? '1' : '0');
      transitUrl.searchParams.set('service', service);
      fixture.interactions.at(-1)!.response = { status: 302, headers: {
        location: transitUrl.toString(), 'set-cookie': ['JSESSIONID=fixture-session; Path=/zhsuser; HttpOnly'] }, body: '' };
      if (options.lostAt === 'oauth') return;
      fixture.interactions.push({ request: { method: 'GET', host: 'login.zhihuishu.com', path: '/wxTransit/0',
        query: { cacheId: 'CACHE1', isLock: options.locked ? '1' : '0', service }, body: '' }, response: { status: 200, body: '<html><title>登录中心</title></html>' } });
      if (options.locked) return;
      const headers = { origin: 'https://login.zhihuishu.com', referer: 'https://login.zhihuishu.com/',
        'content-type': 'application/json;charset=UTF-8', cookie: 'JSESSIONID=fixture-session' };
      fixture.interactions.push({ request: { method: 'GET', host: 'user.zhihuishu.com', path: '/zhsuser/user/cache/CACHE1', headers, body: '' },
        response: { status: 200, body: { status: 200, rt: { mobile: options.hasMobile === false ? null : 'fixture-mobile',
          certifyList: options.hasCertify === false ? [] : options.schools ? [{ schoolId: 'fixture-school', role: 1 }, { schoolId: options.schools === 'same' ? 'fixture-school' : 'other-school', role: 2 }] : [{ schoolId: 'fixture-school', role: 1 }] } } } });
      if (options.hasMobile === false) fixture.interactions.push({ request: { method: 'GET', host: 'user.zhihuishu.com', path: '/zhsuser/login/isNewUser/CACHE1', headers, body: '' },
        response: { status: 200, body: { status: 200, rt: options.isNew ?? false } } });
      if (options.hasCertify === false || options.isNew || options.schools === 'different') return;
      fixture.interactions.push({ request: { method: 'POST', host: 'user.zhihuishu.com', path: '/zhsuser/login/code/skipSet/CACHE1', headers, body: '' },
        response: { status: 200, body: { status: 1, rt: options.missingPwd ? {} : { pwd: 'ONCE1' } } } });
      if (options.missingPwd || options.lostAt === 'skipSet') return;
      fixture.interactions.push({ request: { method: 'GET', host: 'passport.zhihuishu.com', path: '/login',
        query: { pwd: 'ONCE1', service }, headers: { referer: 'https://login.zhihuishu.com/' }, body: '' }, response: { status: 302,
        headers: { 'set-cookie': ['CASLOGC=%7B%22uuid%22%3A%22u1%22%7D; Domain=zhihuishu.com; Path=/; Secure'],
          location: `${service}&ticket=fixture-ticket` }, body: '' } });
      if (options.lostAt === 'passport') return;
      fixture.interactions.push({ request: { method: 'GET', host: 'onlineservice-api.zhihuishu.com', path: '/gateway/f/v1/login/gologin',
        query: { fromurl: 'https://onlineweb.zhihuishu.com/onlinestuh5', ticket: 'fixture-ticket' },
        headers: { cookie: 'CASLOGC=%7B%22uuid%22%3A%22u1%22%7D' }, body: '' }, response: { status: 200, body: {} } });
      if (options.oversizedAt !== undefined) {
        const path = options.oversizedAt === 'cache' ? '/zhsuser/user/cache/CACHE1' : '/zhsuser/login/code/skipSet/CACHE1';
        const row = fixture.interactions.find(item => item.request.path === path)!;
        row.response.body = { ...(row.response.body as Record<string, unknown>), padding: 'x'.repeat(1024 * 1024) };
      }
    }, responseLossPath);
  }

  it.each([true, false])('completes wxTransit cache → one-time password → passport with hasMobile=%s', async hasMobile => {
    const { client, flow, runtime, transport } = await beginTransit({ hasMobile });
    try {
      expect(await flow.result).toMatchObject({ platformUserId: 'u1', identityVerified: false });
      const events = [];
      for await (const event of flow.events) events.push(event);
      expect(JSON.stringify(events)).not.toMatch(/CACHE1|ONCE1|fixture-ticket|CASLOGC|CODE1/);
      expect(await readSession(runtime.state, runtime.masterKey, scope)).not.toBeNull();
      expect(transport.calls.find(call => new URL(call.url).hostname === 'login.zhihuishu.com')?.headers.cookie).toBeUndefined();
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  it('accepts multiple roles at one school without inventing a school selection', async () => {
    const { client, flow, transport } = await beginTransit({ schools: 'same' });
    try {
      expect(await flow.result).toMatchObject({ platformUserId: 'u1', identityVerified: false });
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  it.each([
    { options: { locked: true }, code: 'INTERACTION_REQUIRED' },
    { options: { hasCertify: false }, code: 'INTERACTION_REQUIRED' },
    { options: { hasMobile: false, isNew: true }, code: 'INTERACTION_REQUIRED' },
    { options: { schools: 'different' as const }, code: 'INTERACTION_REQUIRED' },
    { options: { missingPwd: true }, code: 'PROTOCOL' },
  ])('stops incomplete wxTransit $options without publishing or saving credentials', async ({ options, code }) => {
    const { client, flow, runtime, transport } = await beginTransit(options);
    try {
      await expect(flow.result).rejects.toMatchObject({ data: { code } });
      expect(transport.calls.some(call => new URL(call.url).hostname === 'passport.zhihuishu.com')).toBe(false);
      expect(await readSession(runtime.state, runtime.masterKey, scope)).toBeNull();
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  it.each(['cache', 'skipSet'] as const)('rejects an oversized %s envelope before saving or continuing credentials', async oversizedAt => {
    const { client, flow, runtime, transport } = await beginTransit({ oversizedAt });
    try {
      await expect(flow.result).rejects.toMatchObject({ data: { code: 'BUDGET' } });
      expect(transport.calls.filter(call => new URL(call.url).pathname === '/zhsuser/login/code/skipSet/CACHE1')).toHaveLength(oversizedAt === 'cache' ? 0 : 1);
      expect(transport.calls.some(call => new URL(call.url).hostname === 'passport.zhihuishu.com')).toBe(false);
      expect(await readSession(runtime.state, runtime.masterKey, scope)).toBeNull();
    } finally { await client.close(); }
  });

  it.each(['oauth', 'skipSet', 'passport'] as const)('does not replay a consumed %s credential after response loss', async lostAt => {
    const { client, flow, runtime, transport } = await beginTransit({ lostAt });
    try {
      await expect(flow.result).rejects.toMatchObject({ data: { code: 'UNCERTAIN' } });
      const path = lostAt === 'oauth' ? '/zhsuser/oauth/weixin/wxLogin' : lostAt === 'skipSet' ? '/zhsuser/login/code/skipSet/CACHE1' : '/login';
      expect(transport.calls.filter(call => new URL(call.url).pathname === path)).toHaveLength(1);
      expect(await readSession(runtime.state, runtime.masterKey, scope)).toBeNull();
      const events = [];
      for await (const event of flow.events) events.push(event);
      expect(JSON.stringify(events)).not.toMatch(/CACHE1|ONCE1|fixture-ticket|CASLOGC|CODE1/);
      transport.assertNoExtraScripts();
    } finally { await client.close(); }
  });

  it.each([
    "window.wx_errcode=405;",
    "window.wx_errcode=405;window.wx_code='';",
    'window.wx_errcode=405;window.wx_code=\'CODE1";',
    "window.wx_errcode=405;window.wx_code='CODE/1';",
    "window.wx_errcode=405;window.wx_code='CODE1'+suffix;",
  ])('rejects malformed confirmation without exchanging or saving a session: %s', async body => {
    const { client, flow, runtime, transport } = await beginWechat(body, null);
    try {
      await expect(flow.result).rejects.toMatchObject({ data: { code: 'PROTOCOL' } });
      expect(transport.calls.some(call => new URL(call.url).hostname === 'user.zhihuishu.com')).toBe(false);
      expect(await readSession(runtime.state, runtime.masterKey, scope)).toBeNull();
      transport.assertNoExtraScripts();
    } finally {
      await client.close();
    }
  });
});

describe('zhs online identity probe', () => {
  it('derives and persists UUID from the authenticated endpoint for imported cookies', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(9);
    const { importLegacyCookies } = await import('../src/auth/legacy.js');
    await importLegacyCookies({ transport, clock, state, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} }, scope, [{ name: 'CASLOGC', value: 'fixture', domain: '.zhihuishu.com', secure: true }]);
    const dateFormate = Math.trunc(clock.nowMs() / 1000) * 1000;
    const secretStr = await new AesCipher(VIDEO_KEY).encrypt(JSON.stringify({ dateFormate }));
    transport.scriptInteractions([{ request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/login/getLoginUserInfo', query: { secretStr, dateFormate: String(dateFormate) }, headers: { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/' } }, response: { status: 200, body: { code: 0, data: { uuid: 'u1', name: 'Student' } } } }]);
    const runtime: Runtime = { transport, clock, state, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    expect(await createLearningClient({ scope, runtime }).auth.probe()).toMatchObject({ state: 'valid', session: { identityVerified: true, platformUserId: 'u1' } });
    expect(await readSession(state, masterKey, scope)).toMatchObject({ identityVerified: true, platformUserId: 'u1' });
    transport.assertNoExtraScripts();
  });

  it('upgrades an unverified CASLOGC only after an authenticated UUID read-back', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const masterKey = new Uint8Array(32).fill(9);
    const { SessionCookieJar } = await import('../src/http/client.js');
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1,
      platformUserId: encodeURIComponent(JSON.stringify({ uuid: 'u1' })), identityVerified: false,
      cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const dateFormate = Math.trunc(clock.nowMs() / 1000) * 1000;
    const secretStr = await new AesCipher(VIDEO_KEY).encrypt(JSON.stringify({ dateFormate }));
    transport.scriptInteractions([{ request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/login/getLoginUserInfo', query: { secretStr, dateFormate: String(dateFormate) }, headers: { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/' } }, response: { status: 200, body: { code: 0, data: { uuid: 'u1', name: 'Student' } } } }]);
    const runtime: Runtime = { transport, clock, state, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const probe = await createLearningClient({ scope, runtime }).auth.probe();
    expect(probe).toMatchObject({ state: 'valid', session: { identityVerified: true, platformUserId: 'u1' } });
    expect((await readSession(state, masterKey, scope))?.identityVerified).toBe(true);
    transport.assertNoExtraScripts();
  });
});
