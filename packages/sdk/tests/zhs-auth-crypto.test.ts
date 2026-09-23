import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesCipher, HOME_KEY, VIDEO_KEY, WatchPoint, getEv, hikeSign, hms, revEv } from '../src/providers/zhs/crypto.js';
import { zhsQrLaunch } from '../src/providers/zhs/auth.js';
import { md5Hex } from '../src/providers/zhs/md5.js';
import { AuthLifecycle } from '../src/auth/flow.js';
import { MemoryStateStore } from './helpers/memory.js';
import { replay } from './helpers/replay.js';
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
