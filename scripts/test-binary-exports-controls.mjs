import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './build-cli.mjs';

const reportDir = resolve(root, 'dist/e2e');
mkdirSync(reportDir, { recursive: true });
const summary = { suite: 'standalone-export-controls', controls: [], status: 'running' };
try {
  for (const fault of ['wrong-bytes', 'wrong-pdf', 'missing-fixture', 'unregistered-route', ...(process.platform === 'win32' ? [] : ['cleanup-failure'])]) {
    const before = new Set(readdirSync(reportDir));
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-binary-exports.mjs'), ...(process.argv[2] ? [process.argv[2]] : []),
      '--case', fault === 'wrong-pdf' ? 'slides' : 'direct', '--fault', fault], { encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.error, undefined, 'export fault control could not finish');
    assert.equal(result.status, 1, 'export fault control must fail nonzero');
    const files = readdirSync(reportDir).filter(name => !before.has(name) && name.startsWith('exports-' + fault + '-'));
    assert.equal(files.length, 1, 'fault evidence missing');
    const [run] = JSON.parse(readFileSync(resolve(reportDir, files[0]), 'utf8')).runs;
    try {
      assert.equal(run.status, 'failed');
      assert.equal(run.childrenClosed, true);
      assert.equal(run.listenersClosed, true);
      assert.ok(run.commands.length > 10, 'fault must reach the real authenticated export');
      if (fault === 'wrong-pdf') {
        assert.equal(run.failures[0].phase, 'slides');
        assert.equal(run.failures[0].code, 'PDF_VERIFY_FAILED');
      } else if (['wrong-bytes', 'cleanup-failure'].includes(fault)) {
        assert.equal(run.failures[0].phase, 'direct');
        assert.match(run.failures[0].message, /export bytes mismatch/);
      } else {
        assert.equal(run.failures[0].phase, 'direct');
        assert.match(run.network.rejection, fault === 'missing-fixture' ? /undeclared platform request/ : /platform path mismatch/);
        assert.ok(run.network.rejectedRequests > 0);
      }
      if (fault === 'cleanup-failure') {
        assert.equal(run.cleaned, false);
        assert.equal(run.cleanupError, 'EACCES');
        assert.deepEqual(run.failures.map(error => error.phase), ['direct', 'directory-cleanup']);
        assert.match(result.stderr, /export bytes mismatch/);
        assert.match(result.stderr, /isolated export directory still exists/);
      } else assert.equal(run.cleaned, true);
      summary.controls.push({ fault, evidence: files[0], expectedFailure: run.failures[0].code, cleanupRecovery: false });
    } finally {
      if (fault === 'cleanup-failure') {
        assert.ok(/^只读导出 /.test(run.directory), 'only remove this control directory');
        const directory = resolve(root, 'dist', run.directory);
        chmodSync(directory, 0o700);
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        assert.equal(existsSync(directory), false, 'fault control cleanup recovery failed');
        if (summary.controls.at(-1)?.fault === fault) summary.controls.at(-1).cleanupRecovery = true;
      }
    }
  }
  if (process.platform === 'win32') summary.cleanupDenial = 'not-run: POSIX mode denial; Windows async cleanup enforced by both real runs';
  assert.equal(summary.controls.length, process.platform === 'win32' ? 4 : 5, 'zero or missing export fault controls');
  summary.status = 'passed';
} finally {
  writeFileSync(resolve(reportDir, 'export-controls-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log('OK export fault controls: independent bytes/PDF, strict fixture, primary+cleanup failure propagation');
