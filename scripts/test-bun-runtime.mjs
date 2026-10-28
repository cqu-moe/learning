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
const sockets = new Set();
let socketMessages = 0;
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
  // Minimal RFC 6455 fixture: accept one short masked text frame, reply and close.
  // It is deliberately independent of Bun and of the production Socket wrapper.
  server.on('upgrade', (request, socket) => {
    assert.equal(request.url, '/socket');
    assert.equal(request.headers['sec-websocket-version'], '13');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { if (error.code !== 'ECONNRESET') throw error; });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        assert.equal(buffer[1] & 0x80, 0x80, 'client frames must be masked');
        const length = buffer[1] & 0x7f;
        assert.ok(length < 126, 'fixture accepts only short frames');
        if (buffer.length < length + 6) return;
        const opcode = buffer[0] & 0x0f;
        const payload = buffer.subarray(6, 6 + length).map((byte, index) => byte ^ buffer[2 + index % 4]);
        buffer = buffer.subarray(length + 6);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        assert.equal(opcode, 1);
        assert.equal(payload.toString(), 'hello from bun');
        socketMessages++;
        socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ws-ok')]));
      }
    });
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
  assert.equal(socketMessages, 1);

  state = new SqliteStateStore(join(home, 'state.db'));
  const saved = (await state.get('probe:state'))?.value;
  assert.ok(typeof saved === 'object' && saved !== null && !Array.isArray(saved));
  const result = JSON.parse(await decryptJson(masterKey, saved.encrypted, aad));
  assert.equal(result.source, 'bun'); assert.equal(result.seed, seed); assert.equal(result.runtime, 'Bun');
  assert.equal(result.http.body, 'alpha-beta-gamma'); assert.equal(result.http.header, 'headers'); assert.equal(result.http.abortError, true); assert.equal(result.conflictRolledBack, true);
  assert.equal(result.websocket, 'ws-ok');
  assert.equal((await state.get('probe:stable'))?.value, 'node'); assert.equal(await state.get('probe:rollback'), null);
  await assert.rejects(decryptJson(masterKey, saved.encrypted, `${aad}-wrong`));
  state.close();

  const artifacts = new NodeArtifactStore(join(home, 'artifacts'));
  const pdf = await artifactBytes(artifacts, result.artifact.id);
  assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(pdf).digest('hex'), result.artifact.sha256);
  const document = await PDFDocument.load(pdf); assert.equal(document.getPageCount(), 1); assert.equal(document.getTitle(), 'Bun runtime PDF');
  await assert.rejects(artifactBytes(artifacts, result.canceledArtifactId));
  console.log(`Bun runtime interop passed (${pdf.length}-byte PDF, PNG QR file, SQLite, AES-GCM, loopback fetch/WebSocket)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server?.close();
  for (const socket of sockets) socket.destroy();
  state?.close();
  rmSync(cwd, { recursive: true, force: true });
}
