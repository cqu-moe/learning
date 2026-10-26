import { z } from 'zod';
import { LearningError } from '../../types/errors.js';
import { AppLoginWire, PreInfoWire, UserinfoWire, YKT_BASE } from './schemas.js';
import type { Clock } from '../../runtime/types.js';
import type { AuthLaunch } from '../../auth/flow.js';
import type { SessionCookieJar, SessionHttp } from '../../http/client.js';
import type { SessionRecord } from '../../session/store.js';
import type { SessionView } from '../../types/models.js';

const QR_TTL_MS = 5 * 60 * 1000;
const POLL_TIMEOUT_MS = 5_000;

function userInfoIdentity(info: ReturnType<typeof UserinfoWire.parse>): { userId: string | null; name: string | null } {
  const row = Array.isArray(info.data) ? info.data[0] : info.data;
  const rawId = row?.id ?? row?.user_id;
  const userId = rawId === undefined ? null : String(rawId);
  return { userId: userId === '' || userId === '0' ? null : userId, name: row?.name ?? null };
}
const POLL_INTERVAL_MS = 2_000;

/** ykt pure-API QR login (Y02): pre-info → long-poll app-web-login → form web_login → userinfo. */
export function yktQrLaunch(deps: { http: SessionHttp; jar: SessionCookieJar; clock: Clock }): AuthLaunch {
  return async (ctx) => {
    for (;;) {
      if (ctx.signal.aborted) return;
      const preResponse = await deps.http.request({
        kind: 'read',
        method: 'GET',
        url: `${YKT_BASE}/api/v3/user/login/app-web-pre-info`,
        signal: ctx.signal,
      });
      const payload = await preResponse.json();
      const envelope = z.object({ code: z.number(), msg: z.string().optional() }).parse(payload);
      if (envelope.code !== 0) {
        ctx.fail({ code: 'AUTH_REQUIRED', message: `pre-info failed: ${envelope.msg ?? envelope.code}`, retryAfterMs: null, operationId: null });
        return;
      }
      const pre = PreInfoWire.parse(payload);
      ctx.emit({
        type: 'qr',
        generation: ctx.generation,
        qr: { type: 'text', value: pre.data.qrContent },
        expiresAtMs: deps.clock.nowMs() + QR_TTL_MS,
      });
      ctx.emit({ type: 'waiting', generation: ctx.generation });

      let exchanged: { userId: string; auth: string } | null = null;
      while (exchanged === null) {
        if (ctx.signal.aborted) return;
        try {
          const poll = await deps.http.request({
            kind: 'read',
            method: 'POST',
            url: `${YKT_BASE}/api/v3/user/login/app-web-login`,
            body: JSON.stringify({ token: pre.data.token }),
            headers: { 'content-type': 'application/json' },
            signal: ctx.signal,
            timeoutMs: POLL_TIMEOUT_MS,
          });
          if (poll.status === 404) break; // ticket expired → refresh QR
          const parsed = AppLoginWire.parse(await poll.json());
          if (parsed.code === 0 && parsed.data !== undefined) {
            exchanged = { userId: String(parsed.data.UserID), auth: parsed.data.Auth };
          } else {
            break; // treat unknown codes as expired ticket
          }
        } catch (error) {
          if (ctx.signal.aborted) return;
          if (error instanceof LearningError && error.data.code === 'TIMEOUT') {
            await deps.clock.sleep(POLL_INTERVAL_MS, ctx.signal);
            continue;
          }
          throw error;
        }
      }
      if (exchanged === null) continue;

      ctx.emit({ type: 'exchanging', generation: ctx.generation });
      await deps.http.request({
        kind: 'write',
        method: 'POST',
        url: `${YKT_BASE}/pc/web_login`,
        body: `UserID=${encodeURIComponent(exchanged.userId)}&Auth=${encodeURIComponent(exchanged.auth)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: ctx.signal,
      });
      const infoResponse = await deps.http.request({
        kind: 'read',
        method: 'GET',
        url: `${YKT_BASE}/v2/api/web/userinfo`,
        signal: ctx.signal,
      });
      const parsed = UserinfoWire.safeParse(await infoResponse.json());
      const info = parsed.success ? parsed.data : null;
      const identity = info === null ? null : userInfoIdentity(info);
      if (info === null || info.errcode !== 0 || identity?.userId === null || identity?.userId !== exchanged.userId) {
        throw new LearningError({ code: 'PROTOCOL', message: 'web_login did not produce a valid userinfo session', retryAfterMs: null, operationId: null }, { cause: parsed.error });
      }
      const session: Omit<SessionRecord, 'scope' | 'generation'> = {
        schemaVersion: 1,
        platformUserId: exchanged.userId,
        identityVerified: true,
        cookieJar: await deps.jar.serialize(),
        displayName: identity.name,
        checkedAtMs: deps.clock.nowMs(),
      };
      await ctx.finish(session);
      return;
    }
  };
}

export function yktProbeProvider(deps: { http: SessionHttp; clock: Clock }) {
  return {
    async probe(record: SessionRecord | null): Promise<SessionView | null> {
      const response = await deps.http.request({
        kind: 'read',
        method: 'GET',
        url: `${YKT_BASE}/v2/api/web/userinfo`,
      });
      const parsed = UserinfoWire.safeParse(await response.json());
      if (!parsed.success) throw new LearningError({ code: 'PROTOCOL', message: 'Yuketang userinfo envelope is invalid', retryAfterMs: null, operationId: null }, { cause: parsed.error });
      const info = parsed.data;
      if (info.errcode !== 0) return null;
      const identity = userInfoIdentity(info);
      const platformUserId = identity.userId;
      if (response.status !== 200 || platformUserId === null || platformUserId === '' || platformUserId === '0') throw new LearningError({ code: 'PROTOCOL', message: 'Yuketang userinfo lacks a verified user id', retryAfterMs: null, operationId: null });
      return {
        scope: record?.scope ?? { userId: 'local', profileId: 'unknown', platform: 'ykt' },
        generation: record?.generation ?? 1,
        displayName: identity.name ?? record?.displayName ?? null,
        platformUserId,
        identityVerified: true,
        checkedAtMs: deps.clock.nowMs(),
      };
    },
  };
}
