import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const fixtures = new URL('../../packages/sdk/tests/fixtures/', import.meta.url);
// An explicit allowlist: this proxy NEVER forwards a request to the Internet.
const hosts = ['www.yuketang.cn', 'www.xuetangx.com', 'passport.zhihuishu.com', 'onlineservice-api.zhihuishu.com', 'hikeservice.zhihuishu.com', 'studyservice-api.zhihuishu.com', 'open.weixin.qq.com', 'lp.open.weixin.qq.com', 'user.zhihuishu.com'];

export async function platformProxy(directory) {
  const ca = resolve(directory, 'test-ca.pem');
  const key = resolve(directory, 'test-key.pem');
  const config = resolve(directory, 'openssl.cnf');
  writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Learning synthetic platforms\n[ext]\nsubjectAltName=${hosts.map(h => 'DNS:' + h).join(',')}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n`);
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', ca], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
  } catch (error) {
    // Only certificate setup diagnostics: no platform traffic or private key output.
    const diagnostic = {
      tool: 'openssl', status: error.status, signal: error.signal, code: error.code,
      stderr: String(error.stderr ?? '').split(directory).join('<isolated-directory>').slice(-4000),
    };
    throw Object.assign(new Error(`platform TLS certificate setup failed (${error.code ?? error.status})`), { code: 'PLATFORM_TLS_SETUP', diagnostic });
  }
  let interactions = [], cookie, fault;
  const evidence = { requests: 0, tunnels: 0, deniedHosts: 0, rejectedRequests: 0 };
  const sockets = new Set();
  const secrets = ['beta-session-fixture', 'synthetic-zhs-cookie', 'sess-fixture', 'auth-secret-fixture', 'fixture.jwt.token', 'xtx-sess-fixture', 'uuid-fixture', 'qt-fixture', 'op-fixture', 'CODE1'];
  const secure = createTlsServer({ cert: readFileSync(ca), key: readFileSync(key) }, async (request, response) => {
    evidence.requests++;
    try {
      const expected = interactions.shift();
      assert.ok(expected, 'undeclared platform request');
      const url = new URL(request.url, 'https://' + request.headers.host);
      const match = expected.request;
      assert.equal(request.method, match.method, 'platform method mismatch');
      assert.equal(url.hostname, match.host, 'platform host mismatch');
      assert.equal(url.pathname, match.path, 'platform path mismatch');
      if (cookie) assert.ok(request.headers.cookie?.includes(cookie), 'persisted session cookie missing');
      for (const [name, value] of Object.entries(match.headers ?? {})) assert.equal(request.headers[name], value, 'platform header mismatch');
      let body = '';
      for await (const chunk of request) body += chunk;
      if (match.body !== undefined) assert.deepEqual(typeof match.body === 'string' ? body : JSON.parse(body), match.body, 'platform body mismatch');
      for (const [name, value] of Object.entries(match.query ?? {})) {
        // Time/encrypted ZHS request data is exercised by existing protocol tests.
        if (['date', 'secretStr', 'uuid'].includes(name)) assert.ok(url.searchParams.has(name));
        else assert.equal(url.searchParams.get(name), value, 'platform query mismatch');
      }
      response.writeHead(expected.response.status, expected.response.headers ?? {});
      response.end(expected.response.base64 ? Buffer.from(expected.response.base64, 'base64') : typeof expected.response.body === 'string' ? expected.response.body : JSON.stringify(expected.response.body ?? {}));
    } catch (error) {
      evidence.rejectedRequests++;
      fault ??= 'Platform traffic rejected: ' + error.message.split('\n')[0];
      response.writeHead(599); response.end('{}');
    }
  });
  const proxy = createServer((_request, response) => { fault = 'Unexpected plain HTTP request'; response.writeHead(599); response.end(); });
  proxy.on('connect', (request, client, head) => {
    evidence.tunnels++;
    const [host, port] = request.url.split(':');
    if (!hosts.includes(host) || port !== '443') {
      evidence.deniedHosts++;
      fault = 'Outbound destination rejected'; client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    const upstream = connect(secure.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  for (const server of [secure, proxy]) server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => {
      if (!['ECONNRESET', 'EPIPE'].includes(error.code)) fault ??= 'Local transport socket failure';
    });
  });
  try {
    for (const server of [secure, proxy]) await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await Promise.all([secure, proxy].filter(server => server.listening).map(server => new Promise(res => server.close(res))));
    throw error;
  }
  return {
    url: 'http://127.0.0.1:' + proxy.address().port, ca, secrets,
    evidence() { return { ...evidence, rejection: fault }; },
    use(name, options = {}) {
      assert.equal(interactions.length, 0, 'previous platform interactions unconsumed');
      interactions = (Array.isArray(name) ? name : [name]).flatMap(item => typeof item === 'string' ? JSON.parse(readFileSync(new URL(item + '.json', fixtures), 'utf8')).interactions : [item]);
      cookie = options.cookie;
    },
    assertHealthy() { assert.equal(fault, undefined, fault); },
    done() { assert.equal(fault, undefined, fault); assert.equal(interactions.length, 0, 'unconsumed platform responses'); cookie = undefined; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([secure, proxy].map(server => new Promise((res, rej) => server.close(error => error ? rej(error) : res()))));
    },
  };
}
