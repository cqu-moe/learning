import { z } from 'zod';
import { httpError, protocolError } from '../../http/errors.js';
import type { Clock } from '../../runtime/types.js';
import type { AuthLaunch } from '../../auth/flow.js';
import type { HttpResult, SessionCookieJar, SessionHttp } from '../../http/client.js';
import type { SessionRecord } from '../../session/store.js';

const PASSPORT = 'https://passport.zhihuishu.com';
const QR_IMG_URL = `${PASSPORT}/qrCodeLogin/getLoginQrImg`;
const QR_INFO_URL = `${PASSPORT}/qrCodeLogin/getLoginQrInfo`;
const LOGIN_PAGE = `${PASSPORT}/login?service=https://onlineservice-api.zhihuishu.com/login/gologin`;

/** zhs native QR login (Z02): getLoginQrImg → poll status → pwd finish sets CASLOGC. */
export function zhsQrLaunch(deps: { http: SessionHttp; jar: SessionCookieJar; clock: Clock }): AuthLaunch {
  return async (ctx) => {
    const start = await deps.http.request({ kind: 'read', method: 'GET', url: QR_IMG_URL, signal: ctx.signal });
    const startPayload = (await start.json()) as { qrToken?: string; img?: string };
    if (typeof startPayload.qrToken !== 'string' || typeof startPayload.img !== 'string') {
      ctx.fail({ code: 'PROTOCOL', message: 'getLoginQrImg missing qrToken/img', retryAfterMs: null, operationId: null });
      return;
    }
    ctx.emit({
      type: 'qr',
      generation: ctx.generation,
      qr: { type: 'png', base64: startPayload.img },
      expiresAtMs: deps.clock.nowMs() + 5 * 60 * 1000,
    });
    ctx.emit({ type: 'waiting', generation: ctx.generation });

    let oncePassword: string | null = null;
    while (oncePassword === null) {
      if (ctx.signal.aborted) return;
      const poll = await deps.http.request({
        kind: 'read',
        method: 'GET',
        url: `${QR_INFO_URL}?qrToken=${encodeURIComponent(startPayload.qrToken)}`,
        signal: ctx.signal,
      });
      const payload = (await poll.json()) as { status?: number; oncePassword?: string };
      if (payload.status === 1 && typeof payload.oncePassword === 'string') {
        oncePassword = payload.oncePassword;
      } else if (payload.status === 2 || payload.status === 3) {
        ctx.fail({ code: 'AUTH_REQUIRED', message: `qr ${payload.status === 2 ? 'expired' : 'canceled'}`, retryAfterMs: null, operationId: null });
        return;
      } else {
        if (payload.status === 0) ctx.emit({ type: 'scanned', generation: ctx.generation });
        await deps.clock.sleep(2000, ctx.signal);
      }
    }

    ctx.emit({ type: 'exchanging', generation: ctx.generation });
    await deps.http.request({
      kind: 'read',
      method: 'GET',
      url: `${LOGIN_PAGE}&pwd=${encodeURIComponent(oncePassword)}`,
      signal: ctx.signal,
    });
    const cookies = await deps.jar.cookiesFor(new URL(PASSPORT));
    const caslogc = /(?:^|;\s*)CASLOGC=([^;]+)/.exec(cookies)?.[1];
    if (caslogc === undefined) {
      ctx.fail({ code: 'AUTH_REQUIRED', message: 'login finish did not set CASLOGC', retryAfterMs: null, operationId: null });
      return;
    }
    const session: Omit<SessionRecord, 'scope' | 'generation'> = {
      schemaVersion: 1,
      platformUserId: caslogc,
      identityVerified: false,
      cookieJar: await deps.jar.serialize(),
      displayName: null,
      checkedAtMs: deps.clock.nowMs(),
    };
    await ctx.finish(session);
  };
}

/** Default pure-API WeChat OAuth QR flow; no page script is executed. */
export function zhsWechatQrLaunch(deps: { http: SessionHttp; jar: SessionCookieJar; clock: Clock }): AuthLaunch {
  return async (ctx) => {
    const service = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=https://onlineweb.zhihuishu.com/onlinestuh5';
    const redirect = `https://user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin?service=${encodeURIComponent(service)}`;
    const state = 'https://login.zhihuishu.com/wxTransit/0';
    const page = new URL('https://open.weixin.qq.com/connect/qrconnect');
    for (const [key, value] of Object.entries({ appid: 'wx3f96cd4b1dc1f574', scope: 'snsapi_login', redirect_uri: redirect, state, login_type: 'jssdk', self_redirect: 'false' })) page.searchParams.set(key, value);
    const html = await deps.http.request({ kind: 'read', method: 'GET', url: page.toString(), headers: { referer: 'https://login.zhihuishu.com/' }, signal: ctx.signal });
    const uuid = /connect\/qrcode\/([A-Za-z0-9]+)/.exec(await html.text())?.[1];
    if (uuid === undefined) { ctx.fail({ code: 'PROTOCOL', message: 'WeChat QR page contains no safe UUID', retryAfterMs: null, operationId: null }); return; }
    const image = await deps.http.request({ kind: 'read', method: 'GET', url: `https://open.weixin.qq.com/connect/qrcode/${uuid}`, signal: ctx.signal });
    const bytes = await image.bytes(1024 * 1024);
    const imageType = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
      : [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) ? 'png' : null;
    if (imageType === null) throw protocolError('WeChat QR response is not PNG or JPEG');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    ctx.emit({ type: 'qr', generation: ctx.generation, qr: { type: imageType, base64: btoa(binary) }, expiresAtMs: deps.clock.nowMs() + 5 * 60_000 });
    ctx.emit({ type: 'waiting', generation: ctx.generation });
    let code: string | null = null;
    while (code === null) {
      const poll = new URL('https://lp.open.weixin.qq.com/connect/l/qrconnect');
      poll.searchParams.set('uuid', uuid);
      poll.searchParams.set('_', String(deps.clock.nowMs()));
      const result = await deps.http.request({ kind: 'read', method: 'GET', url: poll.toString(), signal: ctx.signal });
      const body = await result.text();
      const err = /(?:^|[;\r\n])\s*(?:window\.)?wx_errcode\s*=\s*(\d+)\s*(?:;|$)/.exec(body)?.[1];
      if (err === '405') {
        code = /(?:^|[;\r\n])\s*(?:window\.)?wx_code\s*=\s*(["'])([A-Za-z0-9_-]+)\1\s*(?:;|$)/.exec(body)?.[2] ?? null;
        if (code === null) { ctx.fail({ code: 'PROTOCOL', message: 'WeChat confirmed without a safe code', retryAfterMs: null, operationId: null }); return; }
      } else if (err === '403') { ctx.fail({ code: 'CANCELED', message: 'WeChat login was canceled', retryAfterMs: null, operationId: null }); return; }
      else if (err === '404' || err === '408') {
        if (err === '404') ctx.emit({ type: 'scanned', generation: ctx.generation });
        await deps.clock.sleep(2000, ctx.signal);
      } else { ctx.fail({ code: 'PROTOCOL', message: 'unexpected WeChat QR status', retryAfterMs: null, operationId: null }); return; }
    }
    ctx.emit({ type: 'exchanging', generation: ctx.generation });
    const finish = new URL(redirect);
    finish.searchParams.set('code', code);
    finish.searchParams.set('state', state);
    // The OAuth code and once-password are single-use, even though their endpoints use GET.
    const exchanged = await deps.http.request({ kind: 'write', method: 'GET', url: finish.toString(), signal: ctx.signal });
    let caslogc = await deps.jar.cookieValue(new URL(PASSPORT), 'CASLOGC');
    if (caslogc === null) {
      await completeWechatTransit(deps.http, exchanged.url, service, ctx.signal);
      caslogc = await deps.jar.cookieValue(new URL(PASSPORT), 'CASLOGC');
    }
    if (caslogc === null) { ctx.fail({ code: 'AUTH_REQUIRED', message: 'WeChat exchange did not set CASLOGC', retryAfterMs: null, operationId: null }); return; }
    // Keep the full cookie only in the encrypted session, never in public auth events.
    let platformUserId: string | null = null;
    try {
      const identity = z.object({ uuid: z.string().min(1) }).safeParse(JSON.parse(decodeURIComponent(caslogc)));
      if (identity.success) platformUserId = identity.data.uuid;
    } catch { /* An authenticated identity probe can populate a missing UUID later. */ }
    await ctx.finish({ schemaVersion: 1, platformUserId, identityVerified: false,
      cookieJar: await deps.jar.serialize(), displayName: null, checkedAtMs: deps.clock.nowMs() });
  };
}

const CachedWechatUserSchema = z.object({
  status: z.literal(200),
  rt: z.object({
    mobile: z.string().nullable().optional(),
    certifyList: z.array(z.object({ schoolId: z.union([z.string().min(1), z.number().int()]) }).passthrough()).optional(),
  }),
});
const IsNewWechatUserSchema = z.object({ status: z.literal(200), rt: z.boolean() });
const WechatOncePasswordSchema = z.object({ status: z.literal(1), rt: z.object({ pwd: z.string().min(1) }) });

async function readWechatEnvelope<S extends z.ZodType>(result: HttpResult, schema: S): Promise<z.infer<S>> {
  const bytes = await result.bytes(256 * 1024);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw protocolError('invalid WeChat transit response'); }
  const parsed = schema.safeParse(payload);
  if (result.status !== 200 || !parsed.success) throw protocolError('invalid WeChat transit response');
  return parsed.data;
}

/** Current official wxTransit/0: cached user → skipSet → passport once-password login. */
async function completeWechatTransit(http: SessionHttp, finalUrl: string, service: string, signal: AbortSignal): Promise<void> {
  const transit = new URL(finalUrl);
  const cacheId = z.string().min(1).max(512).safeParse(transit.searchParams.get('cacheId'));
  if (transit.origin !== 'https://login.zhihuishu.com' || transit.pathname !== '/wxTransit/0' || !cacheId.success) {
    throw protocolError('WeChat exchange did not reach a valid login transit');
  }
  const interaction = (message: string) => httpError({ code: 'INTERACTION_REQUIRED', message, operationId: null });
  if (transit.searchParams.get('isLock') === '1') throw interaction('智慧树账号已被锁定，请在官方登录中心处理。');
  const suffix = encodeURIComponent(cacheId.data);
  const headers = { origin: 'https://login.zhihuishu.com', referer: 'https://login.zhihuishu.com/',
    'content-type': 'application/json;charset=UTF-8' };
  const cached = await readWechatEnvelope(await http.request({ kind: 'read', method: 'GET',
    url: `https://user.zhihuishu.com/zhsuser/user/cache/${suffix}`, headers, signal }), CachedWechatUserSchema);
  if (!cached.rt.mobile) {
    const isNew = await readWechatEnvelope(await http.request({ kind: 'read', method: 'GET',
      url: `https://user.zhihuishu.com/zhsuser/login/isNewUser/${suffix}`, headers, signal }), IsNewWechatUserSchema);
    if (isNew.rt) throw interaction('请先在智慧树官方登录中心完成手机号绑定。');
  }
  if (!cached.rt.certifyList?.length) throw interaction('请先在智慧树官方登录中心完成身份认证。');
  if (new Set(cached.rt.certifyList.map(item => item.schoolId)).size > 1) {
    throw interaction('此微信账号关联多个学校，请先在智慧树官方登录中心选择登录身份。');
  }
  const once = await readWechatEnvelope(await http.request({ kind: 'write', method: 'POST',
    url: `https://user.zhihuishu.com/zhsuser/login/code/skipSet/${suffix}`, headers, signal }), WechatOncePasswordSchema);
  const passport = new URL(`${PASSPORT}/login`);
  passport.searchParams.set('pwd', once.rt.pwd);
  // Use the SDK's canonical service, not an arbitrary URL in the transit page.
  passport.searchParams.set('service', service);
  await http.request({ kind: 'write', method: 'GET', url: passport.toString(),
    headers: { referer: 'https://login.zhihuishu.com/' }, signal });
}
