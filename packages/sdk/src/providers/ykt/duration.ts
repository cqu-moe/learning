import type { Options, Runtime } from '../../runtime/types.js';
import type { SessionHttp } from '../../http/client.js';
import { hostAllowed } from '../../http/client.js';
import { LearningError } from '../../types/errors.js';
import { fetchYktPlaySources } from './resources.js';

export type YktDurationResolver = (http: SessionHttp, ccid: string, options?: Options) => Promise<number | null>;

// Cache only real durations, within one client; signed URLs are never persisted.
export function createYktDurationResolver(probe: Runtime['probeMediaDuration']): YktDurationResolver {
  const durations = new Map<string, number>();
  return async (http, ccid, options) => {
    if (probe === undefined) return null;
    const cached = durations.get(ccid);
    if (cached !== undefined) return cached;
    let sources: Record<string, string[]>;
    try { sources = await fetchYktPlaySources(http, ccid, options); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof LearningError && ['NETWORK', 'TIMEOUT', 'PROTOCOL'].includes(error.data.code)) return null;
      throw error;
    }
    const url = sources.quality20?.[0] || sources.quality10?.[0];
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    let mediaUrl: URL;
    try { mediaUrl = new URL(url); } catch { return null; }
    if (!hostAllowed(mediaUrl.hostname, ['yuketang.cn', 'xuetangx.com']) || mediaUrl.username || mediaUrl.password) return null;
    const duration = await probe(url, options);
    if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
    durations.set(ccid, duration);
    return duration;
  };
}
