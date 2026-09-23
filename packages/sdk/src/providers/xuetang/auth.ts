import type { Clock, Transport } from '../../runtime/types.js';
import type { AuthLaunch } from '../../auth/flow.js';
import type { SessionCookieJar, SessionHttp } from '../../http/client.js';
import type { SessionRecord } from '../../session/store.js';
import { REQUESTLOGIN_FRAME, XTX_BASE, XTX_BASE_HEADERS, XTX_WSAPP } from './schemas.js';

export interface LoginSuccessFrame { op: 'loginsuccess'; token?: string; is_new?: boolean; s_s?: string }

/** s_s = frame.s_s when is_new, else frame.token (X02 loginsuccess branches). */
export function chooseExchangeToken(frame: LoginSuccessFrame): string | null {
  if (frame.is_new === true) return typeof frame.s_s === 'string' && frame.s_s !== '' ? frame.s_s : null;
  return typeof frame.token === 'string' && frame.token !== '' ? frame.token : null;
}

function ticketFollowUrl(ticketUrl: string): string {
  const decoded = decodeURIComponent(ticketUrl);
  for (const match of decoded.matchAll(/[A-Za-z0-9+/]{16,}/g)) {
    for (let pad = 0; pad < 4; pad += 1) {
      try {
        const bytes = atob(match[0] + '='.repeat(pad));
        const found = /https?:\/\/weixin\.qq\.com\/[!-~]+/.exec(bytes);
        if (found !== null) return found[0];
      } catch {
        break;
      }
    }
  }
  return decoded;
}

/** xtx wsapp QR login (X02): seed csrf → WS requestlogin → loginsuccess → wx exchange. */
export function xtxQrLaunch(deps: { http: SessionHttp; jar: SessionCookieJar; transport: Transport; clock: Clock }): AuthLaunch {
  return async (ctx) => {
    await deps.http.request({ kind: 'read', method: 'GET', url: `${XTX_BASE}/`, signal: ctx.signal });
    const socket = await deps.transport.connect({
      url: XTX_WSAPP,
      headers: { Origin: XTX_BASE, 'User-Agent': XTX_BASE_HEADERS['user-agent'] ?? '' },
      signal: ctx.signal,
    });
    try {
      await socket.send(JSON.stringify(REQUESTLOGIN_FRAME));
      let success: LoginSuccessFrame | null = null;
      for await (const message of socket.messages) {
        if (ctx.signal.aborted) return;
        const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
        const frame = JSON.parse(text) as { op?: string; ticket?: string; expire_seconds?: number };
        if (frame.op === 'requestlogin' && typeof frame.ticket === 'string') {
          ctx.emit({
            type: 'qr',
            generation: ctx.generation,
            qr: { type: 'text', value: ticketFollowUrl(frame.ticket) },
            expiresAtMs: deps.clock.nowMs() + Math.max(5, (frame.expire_seconds ?? 60) - 2) * 1000,
          });
          ctx.emit({ type: 'waiting', generation: ctx.generation });
        } else if (frame.op === 'loginsuccess') {
          success = frame as LoginSuccessFrame;
          break;
        }
      }
      if (success === null) {
        ctx.fail({ code: 'AUTH_REQUIRED', message: 'wsapp closed before login confirmation', retryAfterMs: null, operationId: null });
        return;
      }
      const exchangeToken = chooseExchangeToken(success);
      if (exchangeToken === null) {
        ctx.fail({ code: 'PROTOCOL', message: 'loginsuccess frame lacks a usable token', retryAfterMs: null, operationId: null });
        return;
      }
      ctx.emit({ type: 'exchanging', generation: ctx.generation });
      const csrfHeader = await deps.jar.cookiesFor(new URL(XTX_BASE));
      const csrfToken = /(?:^|;\s*)csrftoken=([^;]+)/.exec(csrfHeader)?.[1] ?? '';
      const exchange = await deps.http.request({
        kind: 'write',
        method: 'POST',
        url: `${XTX_BASE}/api/v1/u/login/wx/`,
        body: JSON.stringify({ s_s: exchangeToken }),
        headers: { ...XTX_BASE_HEADERS, 'x-csrftoken': csrfToken, 'content-type': 'application/json;charset=utf-8', referer: `${XTX_BASE}/` },
        signal: ctx.signal,
      });
      const payload = (await exchange.json()) as { success?: boolean; msg?: string };
      if (exchange.status !== 200 || payload.success !== true) {
        ctx.fail({ code: 'AUTH_REQUIRED', message: `login exchange failed: ${payload.msg ?? exchange.status}`, retryAfterMs: null, operationId: null });
        return;
      }
      const session: Omit<SessionRecord, 'scope' | 'generation'> = {
        schemaVersion: 1,
        platformUserId: null,
        identityVerified: true,
        cookieJar: await deps.jar.serialize(),
        displayName: null,
        checkedAtMs: deps.clock.nowMs(),
      };
      await ctx.finish(session);
    } finally {
      await socket.close();
    }
  };
}

export function xtxProbeProvider(deps: { http: SessionHttp; clock: Clock }) {
  return {
    async probe(record: SessionRecord | null) {
      const response = await deps.http.request({
        kind: 'read',
        method: 'GET',
        url: `${XTX_BASE}/api/v1/lms/user/user-courses/?status=1&page=1`,
        headers: XTX_BASE_HEADERS,
      });
      const payload = (await response.json()) as { success?: boolean };
      if (response.status === 401 || payload.success === false) return null;
      return {
        scope: record?.scope ?? { userId: 'local', profileId: 'unknown', platform: 'xuetang' as const },
        generation: record?.generation ?? 1,
        displayName: record?.displayName ?? null,
        platformUserId: record?.platformUserId ?? null,
        identityVerified: record?.identityVerified ?? true,
        checkedAtMs: deps.clock.nowMs(),
      };
    },
  };
}
