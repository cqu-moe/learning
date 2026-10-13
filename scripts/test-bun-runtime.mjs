import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pdfLib from '../packages/sdk/node_modules/pdf-lib/cjs/index.js';
import { NodeArtifactStore, SqliteStateStore } from '../packages/sdk/dist/runtime/node/index.js';
import { decryptJson, encryptJson } from '../packages/sdk/dist/session/crypto.js';
import { compile } from './build-cli.mjs';
const { PDFDocument } = pdfLib; const execFileAsync = promisify(execFile);
const aad = '["bun-runtime","probe","local","p1","test"]'; const masterKey = new Uint8Array(32).fill(23);
const cwd = mkdtempSync(join(tmpdir(), 'learning-bun-runtime-')); let server; let state;
async function artifactBytes(artifacts, id) { const chunks = []; for await (const chunk of await artifacts.open(id)) chunks.push(chunk); return Buffer.concat(chunks); }
try {
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const seed = JSON.stringify({ source: 'node', value: 'shared-secret' });
  state = new SqliteStateStore(join(home, 'state.db'));
  const put = (key, value) => state.commit({ expected: [{ key, revision: null }], changes: [{ key, value }] });
  assert.equal(await put('probe:state', { encrypted: await encryptJson(masterKey, seed, aad) }), true);
  assert.equal(await put('probe:stable', 'node'), true);
  state.close();
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/stream') {
      assert.equal(request.method, 'GET'); assert.equal(request.headers['x-probe'], 'bun');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-runtime-probe': 'headers' }); response.write('alpha-beta-'); response.end('gamma');
      return;
    }
    if (path === '/hang') { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.write('first-chunk'); return; }
    response.writeHead(404).end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const probe = join(cwd, process.platform === 'win32' ? 'probe.exe' : 'probe');
  compile('scripts/bun-runtime-probe.ts', probe);
  const childEnv = { ...process.env };
  for (const key of ['LEARNING_MODEL_BASE_URL', 'LEARNING_MODEL_NAME', 'LEARNING_MODEL_API_KEY']) delete childEnv[key];
  await execFileAsync(probe, [home, baseUrl], { cwd, env: childEnv, timeout: 30_000 });

  state = new SqliteStateStore(join(home, 'state.db'));
  const saved = (await state.get('probe:state'))?.value;
  assert.ok(typeof saved === 'object' && saved !== null && !Array.isArray(saved));
  const result = JSON.parse(await decryptJson(masterKey, saved.encrypted, aad));
  assert.equal(result.source, 'bun'); assert.equal(result.seed, seed); assert.equal(result.runtime, 'Bun');
  assert.equal(result.http.body, 'alpha-beta-gamma'); assert.equal(result.http.header, 'headers'); assert.equal(result.http.abortError, true); assert.equal(result.conflictRolledBack, true);
  assert.equal((await state.get('probe:stable'))?.value, 'node'); assert.equal(await state.get('probe:rollback'), null);
  await assert.rejects(decryptJson(masterKey, saved.encrypted, `${aad}-wrong`));
  state.close();

  const artifacts = new NodeArtifactStore(join(home, 'artifacts'));
  const pdf = await artifactBytes(artifacts, result.artifact.id);
  assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(pdf).digest('hex'), result.artifact.sha256);
  const document = await PDFDocument.load(pdf); assert.equal(document.getPageCount(), 1); assert.equal(document.getTitle(), 'Bun runtime PDF');
  await assert.rejects(artifactBytes(artifacts, result.canceledArtifactId));
  console.log(`Bun runtime interop passed (${pdf.length}-byte PDF, PNG/JPEG QR, SQLite, AES-GCM, loopback fetch)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server?.close();
  state?.close();
  rmSync(cwd, { recursive: true, force: true });
}
