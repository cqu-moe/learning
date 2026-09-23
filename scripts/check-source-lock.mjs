#!/usr/bin/env node
// T00 check: docs/source-lock.json integrity vs .reference checkouts (A001/A002).
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const lockPath = resolve(root, 'docs/source-lock.json');
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

if (!existsSync(lockPath)) {
  console.error(`FAIL docs/source-lock.json missing; create it from docs/SOURCES.md fixed refs`);
  process.exit(1);
}

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, 'utf8'));
} catch (error) {
  console.error(`FAIL docs/source-lock.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(lock.repositories) || lock.repositories.length !== 3) {
  fail(`repositories.length must be 3, got ${JSON.stringify(lock.repositories?.length)}`);
}

const expectedDirs = new Set(['ykt-cli', 'xuetang-cli', 'zhs-cli']);
const seenDirs = new Set();

for (const repo of lock.repositories ?? []) {
  if (!repo.name || !repo.ref || !repo.directory) {
    fail(`repository entry missing name/ref/directory: ${JSON.stringify(repo)}`);
    continue;
  }
  if (!/^[0-9a-f]{40}$/.test(repo.ref)) {
    fail(`${repo.name}: ref must be 40-char hex, got ${repo.ref}`);
  }
  if (!expectedDirs.has(repo.directory)) {
    fail(`${repo.name}: directory must be one of ykt-cli/xuetang-cli/zhs-cli, got ${repo.directory}`);
  }
  seenDirs.add(repo.directory);

  const dir = resolve(root, '.reference', repo.directory);
  if (!existsSync(resolve(dir, '.git'))) {
    // A001: list repo/ref + permission gap explicitly; never suggest a public fork.
    notes.push(`missing-reference repo=${repo.name} ref=${repo.ref} path=.reference/${repo.directory} gap=private-repo-access-required`);
    fail(`${repo.name}: .reference/${repo.directory} missing; provider stays paused, public forks are not a substitute`);
    continue;
  }
  let head;
  let detached = false;
  try {
    head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    detached = branch === 'HEAD';
  } catch (error) {
    fail(`${repo.name}: cannot read .reference/${repo.directory} git state: ${error.message}`);
    continue;
  }
  if (head !== repo.ref) {
    fail(`${repo.name}: .reference HEAD ${head} != locked ref ${repo.ref}`);
  }
  if (!detached) {
    fail(`${repo.name}: .reference must be detached at the locked ref`);
  }
}

for (const dir of expectedDirs) {
  if (!seenDirs.has(dir)) {
    fail(`repositories missing entry for ${dir}`);
  }
}

for (const note of notes) console.log(note);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('OK source-lock: 3 repositories locked and checked out at fixed refs');
