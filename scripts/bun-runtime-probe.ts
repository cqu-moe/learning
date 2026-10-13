import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import jpeg from '../apps/cli/node_modules/jpeg-js/index.js';
import { PNG } from '../apps/cli/node_modules/pngjs/lib/png.js';
import qrcode from '../apps/cli/node_modules/qrcode/lib/index.js';
import { renderImageQrTerminal, renderTextQrTerminal } from '../apps/cli/src/qr-terminal.js';
import { LocalHeavyRenderer } from '../packages/sdk/dist/runtime/node/render.js';
import { NodeArtifactStore, NodeFetchTransport, SqliteStateStore } from '../packages/sdk/dist/runtime/node/index.js';
import { decryptJson, encryptJson } from '../packages/sdk/dist/session/crypto.js';
const aad = '["bun-runtime","probe","local","p1","test"]'; const key = new Uint8Array(32).fill(23);
const [homeInput, baseUrlInput] = process.argv.slice(2); assert.equal(typeof globalThis.Bun, 'object', 'probe must run under Bun');
assert.ok(homeInput && baseUrlInput, 'usage: bun-runtime-probe <home> <loopback-url>'); const baseUrl = new URL(baseUrlInput); assert.equal(baseUrl.protocol, 'http:');
assert.ok(['127.0.0.1', '[::1]'].includes(baseUrl.hostname), 'only loopback is allowed');
async function collect(response: Response) {
  assert.ok(response.body);
  let body = ''; for await (const chunk of response.body) body += new TextDecoder().decode(chunk, { stream: true }); return body;
}
async function abortHang(transport: NodeFetchTransport, url: string) {
  const controller = new AbortController();
  const response = await transport.fetch(new Request(url, { signal: controller.signal }));
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first-chunk');
  controller.abort();
  try { await reader.read(); return false; } catch (error) { return /abort/i.test(String((error as Error).name ?? error)); }
}

const home = resolve(homeInput);
const state = new SqliteStateStore(join(home, 'state.db'));
try {
  const saved = (await state.get('probe:state'))?.value;
  assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved));
  const seed = await decryptJson(key, saved.encrypted, aad);
  await assert.rejects(decryptJson(key, saved.encrypted, `${aad}-wrong`));
  const stable = await state.get('probe:stable');
  assert.equal(await state.commit({ expected: [{ key: 'probe:stable', revision: stable?.revision }, { key: 'probe:rollback', revision: 99 }], changes: [{ key: 'probe:stable', value: 'bun' }, { key: 'probe:rollback', value: 'bad' }] }), false);
  const conflictRolledBack = (await state.get('probe:stable'))?.value === 'node' && await state.get('probe:rollback') === null;

  const transport = new NodeFetchTransport();
  const stream = await transport.fetch(new Request(new URL('/stream', baseUrl), { headers: { 'x-probe': 'bun' } }));
  const http = { body: await collect(stream), header: stream.headers.get('x-runtime-probe'), abortError: await abortHang(transport, new URL('/hang', baseUrl).href) };

  const png = Buffer.from(await qrcode.toBuffer('learning:bun-runtime', { type: 'png', errorCorrectionLevel: 'M', margin: 4, scale: 8 }));
  const raster = PNG.sync.read(png);
  const jpegBytes = Buffer.from(jpeg.encode({ data: raster.data, width: raster.width, height: raster.height }, 95).data);
  const terminal = renderTextQrTerminal('learning:bun-runtime');
  assert.equal(renderImageQrTerminal(png), terminal);
  assert.equal(renderImageQrTerminal(jpegBytes), terminal);
  writeFileSync(join(home, 'qr.png'), png, { mode: 0o600 });
  writeFileSync(join(home, 'qr.jpg'), jpegBytes, { mode: 0o600 });

  const artifacts = new NodeArtifactStore(join(home, 'artifacts'));
  const source = await artifacts.create({ id: 'probe:png', mimeType: 'image/png' });
  await source.write(png); await source.finish();
  const renderer = new LocalHeavyRenderer({ artifacts, scope: { userId: 'local', profileId: 'p1', platform: 'ykt' } });
  const request = { type: 'pdf.compose' as const, imageArtifactIds: ['probe:png'], title: 'Bun runtime PDF' };
  await renderer.start({ taskId: 'output', attempt: 1, request, deadlineAtMs: Date.now() + 60_000 });
  const output = await renderer.status('output', 1);
  assert.equal(output.status, 'succeeded');
  assert.ok(output.status === 'succeeded' && output.result.type === 'pdf.compose');
  const artifact = output.result.artifact;

  await renderer.start({ taskId: 'cancel', attempt: 1, request: { ...request, title: 'Bun cancel PDF' }, deadlineAtMs: Date.now() + 60_000 });
  const canceled = await renderer.status('cancel', 1);
  assert.ok(canceled.status === 'succeeded' && canceled.result.type === 'pdf.compose');
  const canceledArtifactId = canceled.result.artifact.id;
  await renderer.cancel('cancel', 1); assert.equal((await renderer.status('cancel', 1)).status, 'missing');
  let cancellationRemoved = false;
  try { await artifacts.open(canceledArtifactId); } catch { cancellationRemoved = true; }

  const result = { source: 'bun', seed, runtime: 'Bun', http, conflictRolledBack, cancellationRemoved, artifact: { id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256 }, canceledArtifactId };
  const revision = (await state.get('probe:state'))?.revision;
  assert.equal(await state.commit({ expected: [{ key: 'probe:state', revision }], changes: [{ key: 'probe:state', value: { encrypted: await encryptJson(key, JSON.stringify(result), aad) } }] }), true);
} finally {
  state.close();
}
