import { SessionCookieJar } from '../http/client.js';
import { hostAllowed } from '../http/client.js';
import { LearningError } from '../types/errors.js';
import type { Warning } from '../types/errors.js';
import type { SessionView } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Runtime } from '../runtime/types.js';
import { readSessionGeneration, writeSession } from '../session/store.js';

export interface LegacyCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number | null;
}

/** Local-only cookie-array import: no network, identity stays unverified (S03). */
export async function importLegacyCookies(
  runtime: Runtime,
  scope: Scope,
  cookies: LegacyCookie[],
): Promise<{ value: SessionView; warnings: Warning[] }> {
  const jar = new SessionCookieJar();
  const hosts = scope.platform === 'ykt' ? ['yuketang.cn', 'xuetangx.com'] : scope.platform === 'xuetang' ? ['xuetangx.com'] : ['zhihuishu.com'];
  for (const cookie of cookies) {
    const host = cookie.domain.replace(/^\./, '').toLowerCase();
    const path = cookie.path ?? '/';
    if (!/^[a-z0-9.-]+$/.test(host) || !hostAllowed(host, hosts) || !path.startsWith('/') || /[;\r\n]/.test(cookie.name + cookie.value + path) || cookie.name === '' ||
      cookie.secure !== undefined && typeof cookie.secure !== 'boolean' || cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean' ||
      cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite) ||
      cookie.expires !== undefined && cookie.expires !== null && (!Number.isFinite(cookie.expires) || cookie.expires < -1)) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'legacy cookie has invalid scope or attributes', retryAfterMs: null, operationId: null });
    }
    const attributes = [`${cookie.name}=${cookie.value}`, `Path=${path}`];
    if (cookie.domain.startsWith('.')) attributes.push(`Domain=${host}`);
    if (cookie.secure) attributes.push('Secure');
    if (cookie.httpOnly) attributes.push('HttpOnly');
    if (cookie.sameSite !== undefined) attributes.push(`SameSite=${cookie.sameSite}`);
    if (cookie.expires !== undefined && cookie.expires !== null && cookie.expires >= 0) attributes.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
    await jar.absorb(new URL(`https://${host}/`), [attributes.join('; ')]);
  }
  const generation = (await readSessionGeneration(runtime.state, runtime.masterKey, scope)) + 1;
  const checkedAtMs = runtime.clock.nowMs();
  await writeSession(runtime.state, runtime.masterKey, {
    schemaVersion: 1,
    scope,
    generation,
    platformUserId: null,
    identityVerified: false,
    cookieJar: await jar.serialize(),
    displayName: null,
    checkedAtMs,
  });
  return {
    value: {
      scope,
      generation,
      displayName: null,
      platformUserId: null,
      identityVerified: false,
      checkedAtMs,
    },
    warnings: [
      {
        code: 'import.unverified',
        message: 'imported cookies were not verified online; identityVerified stays false',
        resourceKey: null,
      },
    ],
  };
}
