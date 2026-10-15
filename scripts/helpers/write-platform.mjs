import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as tlsServer } from 'node:https';
import { connect } from 'node:net';
import { resolve } from 'node:path';

// Separate from LEARNING-03's proxy: no forwarding and no product-side seams.
export async function writePlatform(directory) {
  const hosts = ['www.yuketang.cn', 'www.xuetangx.com', 'examination.xuetangx.com'];
  writeFileSync(resolve(directory, 'openssl.cnf'), `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic write platform\n[ext]\nsubjectAltName=${hosts.map(h => 'DNS:' + h).join(',')}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', 'openssl.cnf', '-keyout', 'test-key.pem', '-out', 'test-ca.pem'], { cwd: directory, stdio: 'ignore', timeout: 15_000 });
  const ca = resolve(directory, 'test-ca.pem');
  let queue = [], fault;
  const sockets = new Set();
  const evidence = { requests: 0, mutations: [], rejected: 0, tunnels: 0 };
  const secure = tlsServer({ cert: readFileSync(ca), key: readFileSync(resolve(directory, 'test-key.pem')) }, async (request, response) => {
    evidence.requests++;
    try {
      const expected = queue.shift();
      assert.ok(expected, 'unregistered platform request');
      const url = new URL(request.url, 'https://' + request.headers.host);
      const match = expected.request;
      assert.equal(request.method, match.method, 'method');
      assert.equal(url.hostname, match.host, 'host');
      assert.equal(url.pathname, match.path, 'path');
      assert.deepEqual(Object.fromEntries(url.searchParams), match.query ?? {}, 'query');
      for (const [name, value] of Object.entries(match.headers ?? {})) assert.equal(request.headers[name], value, 'header ' + name);
      if (match.cookie) assert.ok(request.headers.cookie?.includes(match.cookie), 'persisted session cookie');
      let raw = '';
      for await (const part of request) { raw += part; assert.ok(raw.length < 1024 * 1024, 'request body bound'); }
      const body = raw ? JSON.parse(raw) : undefined;
      if (match.validate) match.validate(body);
      else assert.deepEqual(body, match.body, 'body');
      // The platform ledger changes ONLY after a validated wire mutation.
      if (expected.accept) {
        expected.accept(body);
        evidence.mutations.push({ method: request.method, host: url.hostname, path: url.pathname });
      }
      if (expected.loseResponse) { request.socket.destroy(); return; }
      const result = expected.response;
      response.writeHead(result.status ?? 200, result.headers ?? {});
      const value = typeof result.body === 'function' ? result.body() : result.body;
      response.end(typeof value === 'string' ? value : JSON.stringify(value ?? {}));
    } catch (error) {
      evidence.rejected++;
      fault ??= error.message.split('\n')[0];
      if (!response.headersSent) response.writeHead(599);
      response.end('{}');
    }
  });
  secure.on('tlsClientError', () => { fault ??= 'TLS client error'; });
  const proxy = createServer((_request, response) => { fault ??= 'plain HTTP forbidden'; response.writeHead(599); response.end(); });
  proxy.on('connect', (request, client, head) => {
    evidence.tunnels++;
    const [host, port] = request.url.split(':');
    if (!hosts.includes(host) || port !== '443') { fault ??= 'destination forbidden'; evidence.rejected++; client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = connect(secure.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  for (const server of [secure, proxy]) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  });
  try {
    for (const server of [secure, proxy]) await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await Promise.all([secure, proxy].filter(s => s.listening).map(s => new Promise(res => s.close(res))));
    throw error;
  }
  return {
    ca, url: 'http://127.0.0.1:' + proxy.address().port,
    use(items) { assert.equal(queue.length, 0, 'unconsumed interactions'); queue = items; },
    done() { assert.equal(fault, undefined, fault); assert.equal(queue.length, 0, 'unconsumed interactions'); },
    evidence() { return JSON.parse(JSON.stringify({ ...evidence, fault })); },
    async close() {
      const closing = [...sockets].map(s => new Promise(res => { s.once('close', res); s.destroy(); }));
      await Promise.all([...closing, ...[secure, proxy].map(s => new Promise((res, rej) => s.close(e => e ? rej(e) : res())))]);
      assert.equal(sockets.size, 0, 'sockets remain');
      assert.equal(secure.listening || proxy.listening, false, 'listeners remain');
    },
  };
}
