import { SessionCookieJar } from '../http/client.js';
import type { Warning } from '../types/errors.js';
import type { SessionView } from '../types/models.js';
import type { Scope } from '../types/refs.js';
import type { Runtime } from '../runtime/types.js';
import { readSession, writeSession } from '../session/store.js';

export interface LegacyCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

/** Local-only cookie-array import: no network, identity stays unverified (S03). */
export async function importLegacyCookies(
  runtime: Runtime,
  scope: Scope,
  cookies: LegacyCookie[],
): Promise<{ value: SessionView; warnings: Warning[] }> {
  const jar = new SessionCookieJar();
  for (const cookie of cookies) {
    const path = cookie.path ?? '/';
    const line = `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${path}`;
    await jar.absorb(new URL(`https://${cookie.domain}/`), [line]);
  }
  const current = await readSession(runtime.state, runtime.masterKey, scope);
  const generation = (current?.generation ?? 0) + 1;
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
