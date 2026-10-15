import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

const directory = resolve(root, 'dist/e2e');
mkdirSync(directory, { recursive: true });
const summary = { suite: 'standalone-jobs-controls', controls: [], status: 'running' };
const expectations = {
  'wrong-expectation': { phase: 'setup', message: /Expected values to be strictly equal/ },
  'missing-fixture': { phase: 'setup', message: /undeclared platform request/, network: true },
  'unregistered-route': { phase: 'setup', message: /platform path mismatch/, network: true },
  'unknown-duration-success': { phase: 'xtx-unknown-duration', message: /unknown duration must not create a study job/ },
  'reconcile-no-advance': { phase: 'xtx-sigkill-reconcile', message: /advanced schedule must confirm the pending heartbeat/ },
  'popup-write': { phase: 'zhs-popup-missing-answer', message: /unreviewed popup must not open a prelearning note/ },
  'cleanup-failure': { phase: 'setup', message: /intentional primary failure before cleanup denial/ },
};
try {
  for (const [fault, expected] of Object.entries(expectations)) {
    if (fault === 'cleanup-failure' && process.platform === 'win32') continue;
    const before = new Set(readdirSync(directory));
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-jobs.mjs'), ...(process.argv[2] ? [process.argv[2]] : []), '--fault', fault], {
      encoding: 'utf8', timeout: process.platform === 'win32' ? 600_000 : 180_000,
    });
    assert.equal(result.error, undefined, 'jobs fault control could not finish');
    assert.equal(result.signal, null, 'jobs fault runner must exit itself');
    assert.equal(result.status, 1, 'jobs fault control must fail nonzero');
    const names = readdirSync(directory).filter(name => !before.has(name) && name.startsWith('jobs-' + fault + '-'));
    assert.equal(names.length, 1, 'exactly one control report is required');
    const evidence = JSON.parse(readFileSync(resolve(directory, names[0]), 'utf8'));
    assert.equal(evidence.runs.length, 1, 'negative control must stop after its first failure');
    const [run] = evidence.runs;
    try {
      assert.equal(run.status, 'failed');
      assert.equal(run.childrenClosed, true);
      assert.equal(run.listenersClosed, true);
      assert.ok(run.commands.length >= 3, 'control must reach the real compiled CLI');
      assert.equal(run.commands.some(command => command.timedOut), false, 'an unrelated timeout is not a valid control');
      assert.equal(run.failures[0].phase, expected.phase);
      assert.match(run.failures[0].message, expected.message);
      if (expected.network) {
        assert.ok(run.network.rejectedRequests > 0);
        assert.match(run.network.rejection, expected.message);
      } else assert.equal(run.network.rejectedRequests, 0);
      if (fault === 'cleanup-failure') {
        assert.equal(run.cleaned, false);
        assert.equal(run.cleanupError, 'EACCES');
        assert.deepEqual(run.failures.map(failure => failure.phase), ['setup', 'directory-cleanup']);
        assert.match(result.stderr, /intentional primary failure/);
        assert.match(result.stderr, /isolated jobs directory still exists/);
      } else assert.equal(run.cleaned, true);
      summary.controls.push({ fault, evidence: names[0], sourceRevision: evidence.sourceRevision, sourceDirty: evidence.sourceDirty,
        artifact: evidence.artifact, phase: expected.phase, exitCode: result.status, cleanupRecovery: false });
    } finally {
      if (fault === 'cleanup-failure') {
        assert.match(run.directory, /^学习任务 [A-Za-z0-9]+$/);
        const isolated = resolve(root, 'dist', run.directory);
        chmodSync(isolated, 0o700);
        await rm(isolated, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        assert.equal(existsSync(isolated), false, 'control directory must be removed after restoring permissions');
        if (summary.controls.at(-1)?.fault === fault) summary.controls.at(-1).cleanupRecovery = true;
      }
    }
  }
  assert.equal(summary.controls.length, process.platform === 'win32' ? 6 : 7, 'zero or missing job controls');
  if (process.platform === 'win32') summary.cleanupDenial = 'not-run: POSIX mode denial; Windows real cleanup remains mandatory';
  summary.status = 'passed';
} finally {
  writeFileSync(resolve(directory, 'jobs-controls-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log('OK jobs negative controls: real authentication, strict fixture, unknown progress, uncertain writes, popup guard and cleanup');
