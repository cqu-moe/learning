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
