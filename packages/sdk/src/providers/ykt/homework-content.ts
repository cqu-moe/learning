import { inspectHomeworkHtml } from '../../content/html.js';
import type { Artifact } from '../../types/models.js';
import type { Scope } from '../../types/refs.js';
import type { Options, Runtime } from '../../runtime/types.js';
import type { SessionHttp } from '../../http/client.js';
import { LearningError } from '../../types/errors.js';
import { sha256Hex } from '../../types/sha256.js';
import { isCancellation, reportError } from '../../runtime/diagnostics.js';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function failure(message: string): LearningError {
  return new LearningError({ code: 'CONTENT_UNREADABLE', message, operationId: null, retryAfterMs: null });
}

function imageExtension(bytes: Uint8Array): string {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  const prefix = new TextDecoder().decode(bytes.subarray(0, 12));
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'gif';
  if (prefix.startsWith('RIFF') && prefix.endsWith('WEBP')) return 'webp';
  throw failure('unsupported or invalid homework image');
}

async function store(runtime: Runtime, scope: Scope, bytes: Uint8Array, extension: string, mimeType: string): Promise<Artifact> {
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
  const id = `homework:${scope.userId}:${scope.profileId}:${sha256}`;
  let exists = false;
  try { const stream = await runtime.artifacts.open(id); await stream.cancel(); exists = true; }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  if (!exists) {
    await runtime.artifacts.remove(id);
    const writer = await runtime.artifacts.create({ id, mimeType });
    try { await writer.write(bytes); await writer.finish(); }
    catch (error) { await writer.abort(); throw error; }
  }
  return { id, scope, filename: `${sha256}.${extension}`, mimeType, bytes: bytes.length, sha256, createdAtMs: runtime.clock.nowMs() };
}

/** Download once per response, before any renderer sees HTML or platform credentials. */
export async function prepareHomeworkContent(http: SessionHttp, runtime: Runtime | undefined, scope: Scope, fields: string[], font: string | null | undefined, options?: Options) {
  const inspected = fields.map(inspectHomeworkHtml);
  const characters = [...new Set(inspected.flatMap(item => item.characters))];
  const urls = [...new Set(inspected.flatMap(item => item.images))];
  const decoded = new Map<string, string>();
  const images = new Map<string, string>();
  const assets: Artifact[] = [];
  if (runtime === undefined) return { decoded, images, assets };
  const recover = (stage: string, error: unknown) => {
    if (isCancellation(error, options?.signal)) throw error;
    reportError(runtime.log, stage, error, { platform: 'ykt', recovered: true });
  };
  if (characters.length && font && runtime.heavy !== null) {
    let artifact: Artifact | undefined;
    const taskId = `homework-font:${scope.profileId}:${sha256Hex(JSON.stringify([font, characters]))}`;
    try {
      const response = await http.request({ kind: 'read', method: 'GET', url: new URL(font, 'https://www.yuketang.cn/').href, ...options });
      if (response.status !== 200) throw failure(`homework font returned HTTP ${response.status}`);
      const bytes = await response.bytes(MAX_ASSET_BYTES);
      artifact = await store(runtime, scope, bytes, 'font', 'application/octet-stream');
      await runtime.heavy.start({ taskId, attempt: 1, request: { type: 'font.decode', fontArtifactId: artifact.id, characters }, deadlineAtMs: runtime.clock.nowMs() + 120_000 }, options);
      const state = await runtime.heavy.status(taskId, 1);
      if (state.status !== 'succeeded' || state.result.type !== 'font.decode') throw state.status === 'failed' ? new LearningError(state.error) : failure('font decoding did not finish');
      for (const pair of state.result.decoded.mapping) if (!state.result.decoded.unresolved.includes(pair.from)) decoded.set(pair.from, pair.to);
    } catch (error) { recover('homework.font', error); }
    finally {
      await runtime.heavy.cancel(taskId, 1);
      if (artifact !== undefined) await runtime.artifacts.remove(artifact.id);
    }
  }
  let total = 0;
  for (const url of urls.slice(0, 200)) {
    try {
      if (total >= MAX_TOTAL_BYTES) throw failure('homework images exceed 64 MiB');
      const response = await http.request({ kind: 'read', method: 'GET', url: new URL(url, 'https://www.yuketang.cn/').href, ...options });
      if (response.status !== 200) throw failure(`homework image returned HTTP ${response.status}`);
      const bytes = await response.bytes(Math.min(MAX_ASSET_BYTES, MAX_TOTAL_BYTES - total));
      total += bytes.length;
      const ext = imageExtension(bytes);
      const asset = await store(runtime, scope, bytes, ext, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
      images.set(url, `assets/${asset.filename}`);
      if (!assets.some(item => item.id === asset.id)) assets.push(asset);
    } catch (error) { recover('homework.image', error); }
  }
  return { decoded, images, assets };
}
