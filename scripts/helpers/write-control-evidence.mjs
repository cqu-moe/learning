import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from '../build-cli.mjs';

export function writeControlEvidence({ code, signal, timedOut, stdout }, name) {
  assert.equal(timedOut, false, name + ' timeout');
  assert.equal(signal, null, name + ' terminated');
  assert.equal(code, 1, name + ' must fail with exit 1');
  const paths = stdout.trim().split(/\r?\n/).map(line => line.replaceAll('\\', '/'))
    .filter(line => /^dist\/e2e\/writes-[^/]+\.json$/.test(line));
  assert.equal(paths.length, 1, name + ' requires exactly one evidence path');
  const [path] = paths;
  return { path, evidence: JSON.parse(readFileSync(resolve(root, path))) };
}
