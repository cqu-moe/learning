import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { root } from './build-cli.mjs';

mkdirSync(resolve(root, 'dist/e2e'), { recursive: true });
const directory = mkdtempSync(resolve(root, 'dist/write-controls-'));
const report = { schemaVersion: 1, controls: [], cleaned: false };
const failures = [];
async function control(name, args, verify) {
  const child = spawn(process.execPath, [resolve(root, 'scripts/test-binary-writes.mjs'), ...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
  const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); }).finally(() => clearTimeout(timer));
  assert.equal(timedOut, false, name + ' timeout'); assert.notEqual(code, 0, name + ' must fail'); assert.notEqual(code, null, name + ' terminated');
  const path = stdout.trim().split('\n').find(line => /^dist\/e2e\/writes-.*\.json$/.test(line)); assert.ok(path, name + ' evidence missing');
  const evidence = JSON.parse(readFileSync(resolve(root, path)));
  verify(evidence);
  assert.ok(evidence.runs.every(r => r.childrenClosed && r.listenersClosed && (r.cleaned || r.controlRecoveryCleaned)), name + ' leaked resources');
  report.controls.push({ name, code, evidence: path });
}
try {
  await control('empty selection', ['--case='], e => { assert.equal(e.runs.length, 0); assert.match(e.failure, /nonempty known scenario/); });
  await control('missing artifact', ['--binary', resolve(directory, 'absent')], e => { assert.equal(e.artifact.sha256, null); assert.match(e.failure, /artifact missing/); });
  if (process.platform === 'win32') report.controls.push({ name: 'empty output', status: 'not-run', reason: 'POSIX executable control' });
  else {
    const empty = resolve(directory, 'empty'); writeFileSync(empty, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await control('empty output', ['--binary', empty], e => { assert.equal(e.runs[0].commands[0].code, 0); assert.equal(e.runs[0].commands[0].stdoutBytes, 0); assert.equal(e.runs[0].status, 'failed'); });
  }
  await control('wrong answer assertion', ['--case', 'matching', '--control', 'wrong-answer'], e => { assert.equal(e.runs[0].failures[0].phase, 'matching'); assert.equal(e.runs[0].platform.rejected, 0); assert.equal(e.runs[0].platform.mutations.length, 0); });
  await control('missing fixture', ['--case', 'matching', '--control', 'missing-fixture'], e => { assert.ok(e.runs[0].platform.rejected > 0); assert.equal(e.runs[0].platform.fault, 'unregistered platform request'); });
  if (process.platform === 'win32') report.controls.push({ name: 'primary and cleanup failure', status: 'not-run', reason: 'POSIX chmod denial; Windows permission diagnostics owned separately' });
  else await control('primary and cleanup failure', ['--case', 'matching', '--control', 'cleanup'], e => {
    assert.equal(e.runs[0].cleaned, false); assert.equal(e.runs[0].controlRecoveryCleaned, true);
    assert.deepEqual(e.runs[0].failures.map(f => f.phase), ['matching', 'directory-cleanup']); assert.equal(e.runs[0].failures[1].code, 'EACCES');
  });
} catch (error) { failures.push(error); }
finally {
  try { await rm(directory, { recursive: true, force: true }); report.cleaned = !existsSync(directory); assert.ok(report.cleaned); } catch (error) { failures.push(error); }
  const path = resolve(root, `dist/e2e/write-controls-${Date.now()}-${process.pid}.json`); writeFileSync(path, JSON.stringify(report, null, 2) + '\n'); console.log(relative(root, path));
}
if (failures.length) throw new AggregateError(failures, 'write controls failed');
console.log('OK compiled write journey failure controls');
