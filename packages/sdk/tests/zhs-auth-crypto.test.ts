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
    expect(result.view.platformUserId).toBe('uuid-fixture');
    const { readSession } = await import('../src/session/store.js');
    const record = await readSession(result.state, result.masterKey, scope);
    expect(record).not.toBeNull();
  });
});

describe('zhs default WeChat QR API flow', () => {
  it('follows the allowlisted page, image, poll and OAuth exchange without a browser', async () => {
    const fixture = loadFixture('zhs/wechat-qr');
    const service = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=https://onlineweb.zhihuishu.com/onlinestuh5';
    const redirect = `https://user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin?service=${encodeURIComponent(service)}`;
    fixture.interactions[0]!.request.query = { appid: 'wx3f96cd4b1dc1f574', scope: 'snsapi_login', redirect_uri: redirect, state: 'https://login.zhihuishu.com/wxTransit/0', login_type: 'jssdk', self_redirect: 'false' };
    for (const [index, row] of fixture.interactions.slice(2, 5).entries()) row.request.query = { uuid: 'WXUUID1', _: String(1728000000000 + index * 2000) };
    fixture.interactions[5]!.request.query = { service, code: 'CODE1', state: 'https://login.zhihuishu.com/wxTransit/0' };
    const transport = new FakeTransport();
    transport.scriptInteractions(fixture.interactions);
    const clock = new FakeClock();
    const runtime: Runtime = { transport, clock, state: new MemoryStateStore(), masterKey: new Uint8Array(32).fill(9),
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const client = createLearningClient({ scope, runtime });
    const flow = await client.auth.begin({ method: 'qr' });
    const view = await flow.result;
    expect(view.identityVerified).toBe(false);
    expect(view.platformUserId).toContain('uuid');
    transport.assertNoExtraScripts();
  });
});

describe('zhs online identity probe', () => {
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
