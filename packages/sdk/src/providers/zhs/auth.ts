import type { Clock } from '../../runtime/types.js';
import type { AuthLaunch } from '../../auth/flow.js';
import type { SessionCookieJar, SessionHttp } from '../../http/client.js';
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
    const png = await deps.http.request({ kind: 'read', method: 'GET', url: `https://open.weixin.qq.com/connect/qrcode/${uuid}`, signal: ctx.signal });
    const bytes = await png.bytes(1024 * 1024);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    ctx.emit({ type: 'qr', generation: ctx.generation, qr: { type: 'png', base64: btoa(binary) }, expiresAtMs: deps.clock.nowMs() + 5 * 60_000 });
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
    await deps.http.request({ kind: 'read', method: 'GET', url: finish.toString(), signal: ctx.signal });
    const caslogc = await deps.jar.cookieValue(new URL('https://user.zhihuishu.com/'), 'CASLOGC');
    if (caslogc === null) { ctx.fail({ code: 'AUTH_REQUIRED', message: 'WeChat exchange did not set CASLOGC', retryAfterMs: null, operationId: null }); return; }
    await ctx.finish({ schemaVersion: 1, platformUserId: caslogc, identityVerified: false,
      cookieJar: await deps.jar.serialize(), displayName: null, checkedAtMs: deps.clock.nowMs() });
  };
}
