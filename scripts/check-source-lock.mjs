#!/usr/bin/env node
// Validate the reference manifest and any available fixed-revision checkouts.
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const lockPath = resolve(root, 'docs/source-lock.json');
const failures = [];
const notes = [];
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--allow-missing-references')) {
  console.error('Usage: node scripts/check-source-lock.mjs [--allow-missing-references]');
  process.exit(2);
}
const allowMissing = args.includes('--allow-missing-references');
let verified = 0;
let missing = 0;

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

if (lock?.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!Array.isArray(lock?.repositories) || lock.repositories.length !== 3) {
  fail(`repositories must be an array of 3 entries`);
}

const expectedDirs = new Set(['ykt-cli', 'xuetang-cli', 'zhs-cli']);
const seenDirs = new Set();

for (const repo of Array.isArray(lock?.repositories) ? lock.repositories : []) {
  if (!repo || !['name', 'ref', 'directory'].every(key => typeof repo[key] === 'string' && repo[key].trim())) {
    fail(`repository entry missing name/ref/directory: ${JSON.stringify(repo)}`);
    continue;
  }
  if (!/^[0-9a-f]{40}$/.test(repo.ref)) {
    fail(`${repo.name}: ref must be 40-char hex, got ${repo.ref}`);
    continue;
  }
  if (!expectedDirs.has(repo.directory)) {
    fail(`${repo.name}: directory must be one of ykt-cli/xuetang-cli/zhs-cli, got ${repo.directory}`);
    continue;
  }
  if (seenDirs.has(repo.directory)) fail(`duplicate repository directory: ${repo.directory}`);
  if (repo.name !== `cqu-moe/${repo.directory}`) fail(`${repo.directory}: unexpected repository name ${repo.name}`);
  seenDirs.add(repo.directory);

  const dir = resolve(root, '.reference', repo.directory);
  if (!lstatSync(dir, { throwIfNoEntry: false })) {
    missing += 1;
    notes.push(`${allowMissing ? 'SKIP' : 'MISSING'} reference repo=${repo.name} ref=${repo.ref} path=.reference/${repo.directory} gap=private-repo-access-required`);
    if (!allowMissing) fail(`${repo.name}: reference missing; protocol evidence remains unverified`);
    continue;
  }
  if (!existsSync(resolve(dir, '.git'))) {
    fail(`${repo.name}: reference directory exists but is not a Git checkout`);
    continue;
  }
  let head;
  let detached;
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
  if (head === repo.ref && detached) verified += 1;
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
console.log(`OK source-lock: manifest valid; ${verified} checkouts verified; ${missing} missing`);
