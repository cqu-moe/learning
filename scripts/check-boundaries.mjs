#!/usr/bin/env node
// T01 check: exactly two workspace packages, manifest/boundary rules, and the
// public/root static import graph (A011/A012). Includes a self-test proving the
// import-graph checker rejects Node/CLI leakage (negative case).
import fs from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const failures = [];
const fail = (message) => failures.push(message);
const rel = (p) => relative(root, p);

// --- import graph checker (pure, reusable for the self-test) -----------------
export function collectImportViolations(entryFile, srcRoot) {
  const violations = [];
  const seen = new Set();
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!fs.existsSync(file)) {
      violations.push({ file, spec: null, reason: 'missing' });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const specs = [
      ...text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s+)?['"]([^'"]+)['"]/g),
      ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('node:')) {
        violations.push({ file, spec, reason: 'node-builtin' });
        continue;
      }
      if (!spec.startsWith('.')) continue; // bare specifiers gated by manifest rules
      const base = resolve(dirname(file), spec);
      const candidates = spec.endsWith('.js')
        ? [base.replace(/\.js$/, '.ts')]
        : [base, `${base}.ts`, resolve(base, 'index.ts')];
      const target = candidates.find((c) => fs.existsSync(c));
      if (!target) {
        violations.push({ file, spec, reason: 'unresolved' });
        continue;
      }
      const inSrc = relative(srcRoot, target);
      if (inSrc.startsWith('runtime/node/') || inSrc.includes('/runtime/node/')) {
        violations.push({ file, spec, reason: 'node-runtime-import' });
        continue;
      }
      if (target.includes('/apps/cli/')) {
        violations.push({ file, spec, reason: 'cli-import' });
        continue;
      }
      stack.push(target);
    }
  }
  return violations;
}

// --- self-test: the checker must reject Node/CLI leakage (A012 negative) ----
function selfTest() {
  const dir = fs.mkdtempSync(resolve(tmpdir(), 'learning-boundaries-'));
  try {
    fs.writeFileSync(resolve(dir, 'bad-import.ts'), "import { readFileSync } from 'node:fs';\nexport const x = 1;\n");
    const bad = collectImportViolations(resolve(dir, 'bad-import.ts'), dir);
    if (!bad.some((v) => v.reason === 'node-builtin')) {
      fail('self-test: checker did not reject a node: builtin import');
    }
    fs.writeFileSync(resolve(dir, 'entry.ts'), "export * from './chain.js';\n");
    fs.writeFileSync(resolve(dir, 'chain.ts'), "export const chain = 'ok';\n");
    const good = collectImportViolations(resolve(dir, 'entry.ts'), dir);
    if (good.length > 0) {
      fail(`self-test: clean graph flagged ${JSON.stringify(good)}`);
    }
    const nested = resolve(dir, 'nested', 'src');
    fs.mkdirSync(resolve(nested, 'runtime', 'node'), { recursive: true });
    fs.mkdirSync(resolve(nested, 'providers'), { recursive: true });
    fs.writeFileSync(resolve(nested, 'index.ts'), "export * from './providers/uses-node.js';\n");
    fs.writeFileSync(resolve(nested, 'providers', 'uses-node.ts'), "export * from '../runtime/node/index.js';\n");
    fs.writeFileSync(resolve(nested, 'runtime', 'node', 'index.ts'), "export const nodeOnly = true;\n");
    const leak = collectImportViolations(resolve(nested, 'index.ts'), nested);
    if (!leak.some((v) => v.reason === 'node-runtime-import')) {
      fail('self-test: checker did not reject runtime/node import from public graph');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- workspace rules ---------------------------------------------------------
const sdkManifestPath = resolve(root, 'packages/sdk/package.json');
const cliManifestPath = resolve(root, 'apps/cli/package.json');
const manifestPaths = [sdkManifestPath, cliManifestPath];
for (const p of manifestPaths) {
  if (!fs.existsSync(p)) fail(`${rel(p)} missing`);
}
const manifests = manifestPaths.filter((p) => fs.existsSync(p)).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
if (manifests.length === 2) {
  const names = manifests.map((m) => m.name);
  if (names[0] !== '@learning/sdk') fail(`packages/sdk name must be @learning/sdk, got ${names[0]}`);
  if (names[1] !== '@learning/cli') fail(`apps/cli name must be @learning/cli, got ${names[1]}`);
  for (const m of manifests) {
    if (m.private !== true) fail(`${m.name} must be private`);
  }
  const cliSdkDep = manifests[1].dependencies?.['@learning/sdk'];
  if (typeof cliSdkDep !== 'string' || !cliSdkDep.startsWith('workspace:')) {
    fail('apps/cli must depend on @learning/sdk via workspace: protocol');
  }
}

for (const forbidden of ['apps/web', 'apps/executor', 'packages/sdk/src/runtime/cloudflare']) {
  if (fs.existsSync(resolve(root, forbidden))) fail(`forbidden path exists: ${forbidden}`);
}

const workspacePath = resolve(root, 'pnpm-workspace.yaml');
if (!fs.existsSync(workspacePath)) {
  fail('pnpm-workspace.yaml missing');
} else {
  const ws = fs.readFileSync(workspacePath, 'utf8');
  const entries = [...ws.matchAll(/^\s*-\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (entries.length !== 2 || !entries.includes('packages/sdk') || !entries.includes('apps/cli')) {
    fail(`workspace must list exactly [packages/sdk, apps/cli], got ${JSON.stringify(entries)}`);
  }
}

const rootManifestPath = resolve(root, 'package.json');
if (!fs.existsSync(rootManifestPath)) {
  fail('root package.json missing');
} else {
  const rootPkg = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
  const allowed = new Set(['lint', 'typecheck', 'test', 'build', 'cli', 'test:e2e']);
  for (const key of Object.keys(rootPkg.scripts ?? {})) {
    if (!allowed.has(key)) fail(`root script not allowed: ${key}`);
  }
  for (const banned of ['test:worker', 'dev:web', 'deploy:web']) {
    if (rootPkg.scripts?.[banned]) fail(`root script ${banned} must not exist`);
  }
  if (rootPkg.name !== 'learning' || rootPkg.private !== true) fail('root manifest must be private name=learning');
}

const bannedDep = (name) =>
  /^react(-|$)/.test(name) || /^vite(-|$)/.test(name) || /^hono(-|$)/.test(name) ||
  /^wrangler(-|$)/.test(name) || /^@cloudflare\//.test(name) ||
  /^next($|-)/.test(name) || /^@sveltejs\//.test(name) || /^astro($|-)/.test(name);
const allPkgs = [
  ['root', fs.existsSync(rootManifestPath) ? JSON.parse(fs.readFileSync(rootManifestPath, 'utf8')) : null],
  ['sdk', manifests[0] ?? null],
  ['cli', manifests[1] ?? null],
];
for (const [label, pkg] of allPkgs) {
  if (!pkg) continue;
  for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
    if (bannedDep(dep)) fail(`${label} depends on banned dependency ${dep}`);
  }
}

// --- public/root import graph over real sources ------------------------------
const sdkSrc = resolve(root, 'packages/sdk/src');
for (const entry of ['index.ts', 'public.ts']) {
  const entryPath = resolve(sdkSrc, entry);
  if (!fs.existsSync(entryPath)) {
    fail(`sdk entry packages/sdk/src/${entry} missing`);
    continue;
  }
  for (const v of collectImportViolations(entryPath, sdkSrc)) {
    fail(`sdk ${entry} import violation: ${v.spec ?? ''} (${v.reason})`);
  }
}

// --- exports sanity: every sdk export subpath maps to a real source file -----
if (manifests[0]?.exports) {
  for (const [subpath, def] of Object.entries(manifests[0].exports)) {
    const target = typeof def === 'string' ? def : def.import ?? def.default;
    if (typeof target !== 'string') continue;
    const srcFile = resolve(
      root,
      'packages/sdk',
      target.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
    );
    if (!fs.existsSync(srcFile)) {
      fail(`sdk export ${subpath} points to ${target} with no source counterpart`);
    }
  }
}
if (manifests[1] && !manifests[1].bin?.learning) fail('apps/cli must declare bin learning');

selfTest();
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('OK boundaries: two-package workspace, no web/cloud deps, public graph clean');
