import assert from 'node:assert/strict';
import { NodeFetchTransport } from '../packages/sdk/src/runtime/node/transport.js';

// This compiled transport probe only targets reserved .invalid destinations.
const url = process.argv[2]!;
assert.ok(new URL(url).hostname.endsWith('.invalid'));
const transport = new NodeFetchTransport();
try {
  const socket = await transport.connect({ url, headers: { Origin: 'https://fixture.invalid' }, signal: AbortSignal.timeout(3000) });
  try {
    await socket.send(JSON.stringify({ probe: 'client' }));
    assert.equal((await socket.messages[Symbol.asyncIterator]().next()).value, 'server');
  } finally { await socket.close(); }
  console.log('connected');
} catch {
  console.log('rejected');
  process.exitCode = 1;
}
