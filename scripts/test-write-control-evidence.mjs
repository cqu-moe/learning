import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { root } from './build-cli.mjs';
import { writeControlEvidence } from './helpers/write-control-evidence.mjs';

function journey(args) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-writes.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.error, undefined, 'real journey child must start and finish');
  assert.equal(result.signal, null, 'real journey child must exit itself');
  return { code: result.status, signal: result.signal, stdout: result.stdout, timedOut: false };
}

test('negative child report is readable with POSIX and Windows separators and CRLF', () => {
  const result = journey(['--case=']);
  assert.equal(result.code, 1);
  for (const stdout of [result.stdout.replaceAll('\\', '/'), result.stdout.trim().replaceAll('/', '\\') + '\r\n']) {
    const { evidence } = writeControlEvidence({ ...result, stdout }, 'empty selection');
    assert.equal(evidence.runs.length, 0);
    assert.match(evidence.failure, /nonempty known scenario selection required/);
  }
});

test('positive native matching child is rejected as a negative control', () => {
  const result = journey(['--case', 'matching']);
  assert.equal(result.code, 0);
  const path = result.stdout.trim().split(/\r?\n/)[0];
  const evidence = JSON.parse(readFileSync(resolve(root, path)));
  assert.equal(evidence.runs.length, 2);
  assert.ok(evidence.runs.every(run => run.status === 'passed' && run.cases.length === 1 && run.cases[0].name === 'matching'
    && run.childrenClosed && run.listenersClosed && run.cleaned && run.platform.mutations.length === 0));
  assert.throws(() => writeControlEvidence(result, 'positive child'), /positive child must fail/);
});
