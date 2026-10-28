import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(resolve(root, '.source-lock-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(resolve(dir, 'scripts'));
  mkdirSync(resolve(dir, 'docs'));
  copyFileSync(resolve(root, 'scripts/check-source-lock.mjs'), resolve(dir, 'scripts/check-source-lock.mjs'));
  const lock = JSON.parse(readFileSync(resolve(root, 'docs/source-lock.json'), 'utf8'));
  const save = () => writeFileSync(resolve(dir, 'docs/source-lock.json'), JSON.stringify(lock));
  save();
  const run = (...args) => {
    const result = spawnSync(process.execPath, [resolve(dir, 'scripts/check-source-lock.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    return { code: result.status, output: result.stdout + result.stderr };
  };
  return { dir, lock, save, run };
}

test('CI can skip absent references without claiming checkout verification', t => {
  const { run } = fixture(t);
  const result = run('--allow-missing-references');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /SKIP.*cqu-moe\/ykt-cli/);
  assert.match(result.output, /0 checkouts verified/);
  assert.match(result.output, /3 missing/);
  assert.equal(run().code, 1, 'default invocation still requires reference checkouts');
});

test('allowing missing checkouts never hides invalid manifests', async t => {
  for (const [name, mutate] of [
    ['invalid ref', lock => { lock.repositories[0].ref = 'main'; }],
    ['missing repository', lock => { lock.repositories.pop(); }],
    ['duplicate directory', lock => { lock.repositories[1] = lock.repositories[0]; }],
    ['non-array repositories', lock => { lock.repositories = {}; }],
    ['null repository', lock => { lock.repositories[0] = null; }],
  ]) {
    await t.test(name, t => {
      const { lock, save, run } = fixture(t);
      mutate(lock);
      save();
      const result = run('--allow-missing-references');
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /FAIL/);
    });
  }
});

test('malformed JSON fails even when references are optional', t => {
  const { dir, run } = fixture(t);
  writeFileSync(resolve(dir, 'docs/source-lock.json'), '{');
  const result = run('--allow-missing-references');
  assert.equal(result.code, 1);
  assert.match(result.output, /not valid JSON/);
});

test('present invalid checkout cannot be treated as a missing private repository', t => {
  const { dir, run } = fixture(t);
  mkdirSync(resolve(dir, '.reference/ykt-cli'), { recursive: true });
  const result = run('--allow-missing-references');
  assert.equal(result.code, 1);
  assert.match(result.output, /FAIL.*ykt-cli/);
});

test('broken checkout link is an error rather than an optional missing reference', t => {
  const { dir, run } = fixture(t);
  mkdirSync(resolve(dir, '.reference'));
  symlinkSync(resolve(dir, 'missing-checkout'), resolve(dir, '.reference/ykt-cli'), 'junction');
  const result = run('--allow-missing-references');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL.*ykt-cli/);
});

test('real checkouts must match the locked commit and stay detached', t => {
  const { dir, lock, save, run } = fixture(t);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sha = git('-C', root, 'rev-parse', 'HEAD');
  for (const repo of lock.repositories) {
    const checkout = resolve(dir, '.reference', repo.directory);
    git('clone', '--quiet', '--shared', '--no-checkout', root, checkout);
    git('-C', checkout, 'update-ref', '--no-deref', 'HEAD', sha);
    repo.ref = sha;
  }
  save();
  const passing = run();
  assert.equal(passing.code, 0, passing.output);
  assert.match(passing.output, /3 checkouts verified/);

  lock.repositories[0].ref = '0'.repeat(40);
  save();
  const mismatch = run('--allow-missing-references');
  assert.equal(mismatch.code, 1, mismatch.output);
  assert.match(mismatch.output, /HEAD.*!= locked ref/);

  lock.repositories[0].ref = sha;
  save();
  const checkout = resolve(dir, '.reference/ykt-cli');
  git('-C', checkout, 'update-ref', 'refs/heads/attached', sha);
  git('-C', checkout, 'symbolic-ref', 'HEAD', 'refs/heads/attached');
  const attached = run('--allow-missing-references');
  assert.equal(attached.code, 1, attached.output);
  assert.match(attached.output, /must be detached/);
});
