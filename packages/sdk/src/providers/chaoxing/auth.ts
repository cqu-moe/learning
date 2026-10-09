import { z } from 'zod';
import { LearningError } from '../../types/errors.js';
import { AesCipher } from '../../crypto/aes.js';
import type { AuthLaunch } from '../../auth/flow.js';
import type { Clock } from '../../runtime/types.js';
import type { SessionCookieJar, SessionHttp } from '../../http/client.js';

const LOGIN_KEY = 'u2oh6Vu^HWe4_AES';
const LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';
const MANUAL_REJECTION = /验证码|安全验证|风险|扫码/;

const LoginResponseSchema = z.object({
  status: z.boolean(),
  msg2: z.string().optional(),
});

export async function encryptChaoxingLoginField(value: string): Promise<string> {
  return new AesCipher(LOGIN_KEY, LOGIN_KEY).encrypt(value);
}

export function chaoxingUserId(html: string): string | null {
  if (/passport2\.chaoxing\.com\/login/i.test(html) || /请登录/.test(html)) return null;
  const uid = /(?:uid|personid)["'=:\s]+(\d{3,})/i.exec(html)?.[1];
  if (uid === undefined || !/^[1-9]\d*$/.test(uid) || Number(uid) > Number.MAX_SAFE_INTEGER) return null;
  return uid;
}

export function chaoxingPasswordLaunch(input: {
  http: SessionHttp;
  jar: SessionCookieJar;
  clock: Clock;
  username: string;
  password: string;
}): AuthLaunch {
  return async (context) => {
    const form = new URLSearchParams({
      fid: '-1',
      uname: await encryptChaoxingLoginField(input.username),
      password: await encryptChaoxingLoginField(input.password),
      refer: 'https%3A%2F%2Fi.chaoxing.com',
      t: 'true',
      forbidotherlogin: '0',
      validate: '',
      doubleFactorLogin: '0',
      independentId: '0',
    });
    const response = await input.http.request({
      kind: 'write',
      method: 'POST',
      url: 'https://passport2.chaoxing.com/fanyalogin',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': LOGIN_UA,
      },
      body: form.toString(),
      signal: context.signal,
      followRedirects: false,
    });
    if (response.status !== 200) {
      context.fail({ code: 'PROTOCOL', message: `Chaoxing login returned HTTP ${response.status}`, retryAfterMs: null, operationId: null });
      return;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      context.fail({ code: 'PROTOCOL', message: 'Chaoxing login returned an invalid JSON envelope', retryAfterMs: null, operationId: null });
      return;
    }
    const parsed = LoginResponseSchema.safeParse(payload);
    if (!parsed.success) {
      context.fail({ code: 'PROTOCOL', message: 'Chaoxing login response lacks a status envelope', retryAfterMs: null, operationId: null });
      return;
    }
    if (parsed.data.status !== true) {
      const manual = typeof parsed.data.msg2 === 'string' && MANUAL_REJECTION.test(parsed.data.msg2);
      context.fail({
        code: 'AUTH_REQUIRED',
        message: manual
          ? 'Chaoxing requires captcha, risk, or second-factor verification in the official page'
          : 'Chaoxing rejected the credentials',
        retryAfterMs: null,
        operationId: null,
      });
      return;
    }

    try {
      const base = await input.http.request({
        kind: 'read',
        method: 'GET',
        url: 'https://i.chaoxing.com/base',
        headers: { 'user-agent': LOGIN_UA },
        signal: context.signal,
      });
      if (base.status !== 200) {
        context.fail({ code: 'AUTH_REQUIRED', message: `Chaoxing identity probe returned HTTP ${base.status}`, retryAfterMs: null, operationId: null });
        return;
      }
      const uid = chaoxingUserId(await base.text());
      if (uid === null) {
        context.fail({ code: 'AUTH_REQUIRED', message: 'Chaoxing login did not produce a verified safe user id', retryAfterMs: null, operationId: null });
        return;
      }
      await context.finish({
        schemaVersion: 1,
        platformUserId: uid,
        identityVerified: true,
        displayName: null,
        checkedAtMs: input.clock.nowMs(),
        cookieJar: await input.jar.serialize(),
      });
    } catch (error) {
      if (error instanceof LearningError && error.data.code === 'CANCELED') throw error;
      context.fail({
        code: 'UNCERTAIN',
        message: 'Chaoxing login request succeeded but identity verification is unknown; do not automatically resend the login form',
        retryAfterMs: null,
        operationId: null,
      });
    }
  };
}
