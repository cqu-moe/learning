import assert from 'node:assert/strict';

// macOS enforces this for the whole child process, including native WebSocket.
// Other CI hosts use the separately probed native proxy; do not claim OS isolation.
export const egressBoundary = process.platform === 'darwin' ? 'sandbox: proxy loopback port only' : 'native proxy: no OS firewall';

export function loopbackCommand(program, args, proxyUrl) {
  const proxy = new URL(proxyUrl);
  assert.equal(proxy.hostname, '127.0.0.1');
  assert.match(proxy.port, /^\d+$/);
  if (process.platform !== 'darwin') return [program, args];
  return ['/usr/bin/sandbox-exec', ['-p', `(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${proxy.port}"))`, program, ...args]];
}
