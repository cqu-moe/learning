import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

const tempRoots: string[] = [];

function runPackedCli(args: string[], home = mkdtempSync(resolve(tmpdir(), 'learning-e2e-'))) {
  if (!tempRoots.includes(home)) tempRoots.push(home);
  try {
    const stdout = execFileSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), ...args, '--home', home], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: home,
      env: { ...process.env, LEARNING_HOME: home },
    });
    return { stdout, stderr: '', exitCode: 0, home };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 1, home };
  }
}

afterAll(() => {
  for (const home of tempRoots) rmSync(home, { recursive: true, force: true });
});

describe('packed cli e2e (T31, A311/A312)', () => {
  it('--help works from built output', () => {
    const run = runPackedCli(['--help']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('learning');
  });

  it('version matches the package manifest', () => {
    const run = runPackedCli(['--version']);
    expect(run.stdout.trim()).toBe(pkg.version);
  });

  it('init/doctor run offline without any cloud configuration', () => {
    const init = runPackedCli(['init']);
    expect(init.exitCode).toBe(0);
    const doctor = runPackedCli(['doctor'], init.home);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).toContain('node:');
    const jobs = runPackedCli(['jobs', 'list', '--json'], init.home);
    expect(jobs.exitCode).toBe(0);
    expect(JSON.parse(jobs.stdout).data.jobs).toEqual([]);
  });

  it('no unapproved live platform writes happen in offline e2e', () => {
    const run = runPackedCli(['run', 'fixture-course', '--dry-run']);
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not initialized');
    expect(run.stdout).not.toContain('yuketang.cn');
    expect(run.stdout).not.toContain('xuetangx.com');
    expect(run.stdout).not.toContain('zhihuishu.com');
  });

  it('registers every current A02 command path in the built binary', () => {
    const paths = [
      'init', 'profile add', 'profile list', 'profile remove', 'profile unlock',
      'login', 'whoami', 'courses', 'outline', 'download', 'slide', 'run',
      'homework draft', 'homework apply', 'exam export', 'exam start', 'exam save', 'exam submit',
      'discuss draft', 'discuss post', 'answers match', 'live',
      'jobs list', 'jobs show', 'jobs resume', 'jobs cancel', 'jobs reconcile', 'doctor',
    ];
    expect(paths).toHaveLength(28);
    for (const path of paths) {
      const result = runPackedCli([...path.split(' '), '--help']);
      expect(result.exitCode, path).toBe(0);
      expect(result.stdout, path).toContain('Usage:');
    }
  }, 20_000);

  it('rejects malformed or unowned command inputs before any platform request', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'learning-e2e-negative-'));
    tempRoots.push(home);
    const fixture = resolve(home, 'empty-fixture.json');
    writeFileSync(fixture, JSON.stringify({ interactions: [] }));
    const entry = resolve(import.meta.dirname, '../dist/index.js');
    const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', preload, entry, '--home', home, ...args], {
      cwd: home, encoding: 'utf8', env: { ...process.env, LEARNING_FIXTURE_FILE: fixture, LEARNING_HOME: resolve(home, 'ignored-env') },
    });
    expect(run(['init']).status).toBe(0);
    expect(run(['profile', 'add', 'alpha', '--platform', 'ykt']).status).toBe(0);
    const cases = [
      ['profile', 'add', 'alpha', '--platform', 'zhs'],
      ['profile', 'remove', 'missing', '--yes'],
      ['login', '--profile', 'missing'],
      ['whoami', '--profile', 'missing'],
      ['courses', '--profile', 'missing'],
      ['outline', 'unknown', '--profile', 'alpha'],
      ['download', 'unknown', '--profile', 'alpha'],
      ['slide', 'not-a-url', '--profile', 'alpha'],
      ['run', 'unknown', '--profile', 'alpha'],
      ['homework', 'draft', 'unknown', '-o', resolve(home, 'draft.yaml'), '--profile', 'alpha'],
      ['homework', 'apply', resolve(home, 'missing.yaml'), '--profile', 'alpha'],
      ['exam', 'export', 'unknown', '--profile', 'alpha'],
      ['exam', 'start', 'unknown', '--profile', 'alpha'],
      ['exam', 'save', resolve(home, 'missing.yaml'), '--profile', 'alpha'],
      ['exam', 'submit', resolve(home, 'missing.yaml'), '--profile', 'alpha'],
      ['discuss', 'draft', 'unknown', '-o', resolve(home, 'discussion.json'), '--profile', 'alpha'],
      ['discuss', 'post', resolve(home, 'missing.json'), '--profile', 'alpha'],
      ['answers', 'match', resolve(home, 'missing.yaml'), '--source', resolve(home, 'feedback.yaml'), '--profile', 'alpha'],
      ['live', 'not-a-url', '--profile', 'alpha'],
      ['jobs', 'show', 'missing-job'],
      ['jobs', 'resume', 'missing-job', '--profile', 'alpha'],
      ['jobs', 'cancel', 'missing-job', '--profile', 'alpha'],
      ['jobs', 'reconcile', 'missing-job', '--profile', 'alpha'],
    ];
    for (const args of cases) {
      const result = run(args);
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).not.toBe(0);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(result.stderr, args.join(' ')).not.toContain('undeclared request');
    }
  }, 20_000);

  it('uses packed tarballs in an isolated consumer for QR, catalog, export and Range resume', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'learning-packed-e2e-'));
    tempRoots.push(directory);
    const sdkRoot = resolve(import.meta.dirname, '../../../packages/sdk');
    const cliRoot = resolve(import.meta.dirname, '..');
    const nodePath = `${dirname(process.execPath)}:${process.env.PATH ?? ''}`;
    const pack = (root: string) => {
      const result = spawnSync('pnpm', ['pack', '--pack-destination', directory], { cwd: root, env: { ...process.env, PATH: nodePath }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    pack(sdkRoot); pack(cliRoot);
    const sdkTar = resolve(directory, `learning-sdk-${pkg.version}.tgz`);
    const cliTar = resolve(directory, `learning-cli-${pkg.version}.tgz`);
    const listing = spawnSync('tar', ['-tf', cliTar], { encoding: 'utf8' });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain('package/dist/index.js');
    expect(listing.stdout).not.toContain('package/src/');
    expect(listing.stdout).not.toContain('package/tests/');
    mkdirSync(resolve(directory, 'node_modules/@learning'), { recursive: true });
    mkdirSync(resolve(directory, 'node_modules/.bin'), { recursive: true });
    for (const [name, tarball] of [['sdk', sdkTar], ['cli', cliTar]] as const) {
      const unpack = resolve(directory, `unpack-${name}`);
      mkdirSync(unpack);
      const extracted = spawnSync('tar', ['-xf', tarball, '-C', unpack], { encoding: 'utf8' });
      expect(extracted.status, extracted.stderr).toBe(0);
      renameSync(resolve(unpack, 'package'), resolve(directory, `node_modules/@learning/${name}`));
    }
    for (const name of ['pdf-lib', 'parse5', 'tough-cookie', 'yaml', 'zod']) symlinkSync(resolve(sdkRoot, 'node_modules', name), resolve(directory, 'node_modules', name));
    for (const name of ['commander', 'qrcode']) symlinkSync(resolve(cliRoot, 'node_modules', name), resolve(directory, 'node_modules', name));
    const entry = resolve(directory, 'node_modules/@learning/cli/dist/index.js');
    const bin = resolve(directory, 'node_modules/.bin/learning');
    symlinkSync('../@learning/cli/dist/index.js', bin);
    expect(statSync(entry).mode & 0o111).not.toBe(0);
    const help = spawnSync(bin, ['--help'], { cwd: directory, env: { ...process.env, PATH: nodePath }, encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('learning');
    const exports = spawnSync(process.execPath, ['--input-type=module', '-e', "import {createLearningClient} from '@learning/sdk'; import {SqliteStateStore} from '@learning/sdk/node'; import {LocalHeavyRenderer} from '@learning/sdk/render-node'; if (![createLearningClient,SqliteStateStore,LocalHeavyRenderer].every(x=>typeof x==='function')) process.exit(1)"], { cwd: directory, encoding: 'utf8' });
    expect(exports.status, exports.stderr).toBe(0);
    const preload = resolve(directory, 'fixture-fetch.mjs');
    copyFileSync(resolve(import.meta.dirname, 'fixture-fetch.mjs'), preload);
    const home = resolve(directory, 'data');
    const fixtureRoot = resolve(import.meta.dirname, '../../../packages/sdk/tests/fixtures');
    const run = (args: string[], fixture: string | null = null, expected = 0, cookie: string | null = null) => {
      const result = spawnSync(process.execPath, [...(fixture ? ['--import', preload] : []), entry, '--home', home, ...args], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, ...(fixture ? { LEARNING_FIXTURE_FILE: fixture } : {}), ...(cookie ? { LEARNING_ASSERT_COOKIE: cookie } : {}) },
      });
      expect(result.status, result.stderr).toBe(expected);
      return result.stdout;
    };
    expect(run(['init'])).toContain(home);
    const alpha = JSON.parse(run(['profile', 'add', 'alpha', '--platform', 'ykt', '--json'])).data as { scope: { profileId: string } };
    const beta = JSON.parse(run(['profile', 'add', 'beta', '--platform', 'xuetang', '--json'])).data as { scope: { profileId: string } };
    expect(JSON.parse(run(['login', '--profile', 'alpha', '--json'], resolve(fixtureRoot, 'ykt/qr-login.json'))).data.identityVerified).toBe(true);
    const courses = JSON.parse(run(['courses', '--profile', 'alpha', '--json'], resolve(fixtureRoot, 'ykt/courses-list.json'), 0, 'sessionid=sess-fixture')).data as { items: Array<{ ref: { key: string } }> };
    expect(courses.items.length).toBeGreaterThan(0);
    const outline = JSON.parse(run(['outline', courses.items[0]!.ref.key, '--profile', 'alpha', '--json'], resolve(fixtureRoot, 'ykt/nested-outline.json'))).data as { value: { roots: unknown[] } };
    expect(outline.value.roots.length).toBeGreaterThan(0);
    const seedScript = `import {SqliteStateStore} from '@learning/sdk/node'; const store=new SqliteStateStore(process.env.PACKED_HOME+'/state.db'); const a=(await store.get('cli:profile:alpha')).value.scope; const b=(await store.get('cli:profile:beta')).value.scope; const rows=[['cli:resource:fixture-exam',{course:{scope:a,key:'fixture-course',native:{kind:'ykt',classroomId:'28930736'}},key:'fixture-exam',native:{kind:'ykt',leafId:'510',leafInfoId:null}}],['cli:resource:fixture-video',{course:{scope:b,key:'fixture-course',native:{kind:'xuetang',classroomId:'100',courseSign:'SIGN-A',skuId:'1'}},key:'fixture-video',native:{kind:'xuetang',leafId:'7',leafInfoId:null}}]]; if(!await store.commit({expected:rows.map(([key])=>({key,revision:null})),changes:rows.map(([key,value])=>({key,value}))})) process.exit(2); store.close();`;
    const seeded = spawnSync(process.execPath, ['--input-type=module', '-e', seedScript], { cwd: directory, env: { ...process.env, PACKED_HOME: home }, encoding: 'utf8' });
    expect(seeded.status, seeded.stderr).toBe(0);
    const exported = JSON.parse(run(['exam', 'export', 'fixture-exam', '--profile', 'alpha', '--json'], resolve(fixtureRoot, 'ykt/exam-read.json'))).data as { job: { status: string }; files: string[] };
    expect(exported.job.status).toBe('succeeded');
    expect(JSON.parse(readFileSync(exported.files[0]!, 'utf8')).questions).toHaveLength(2);
    const base = JSON.parse(readFileSync(resolve(fixtureRoot, 'xuetang/media.json'), 'utf8')) as { interactions: unknown[] };
    const first = resolve(directory, 'first.json');
    writeFileSync(first, JSON.stringify({ interactions: [...base.interactions, { request: { method: 'GET', host: 'www.xuetangx.com', path: '/hd.mp4' }, response: { status: 200, headers: { etag: '"v1"', 'content-type': 'video/mp4' }, chunks: [Buffer.from('abc').toString('base64')], failAfterChunks: true } }] }));
    expect(run(['download', 'fixture-video', '--types', 'video', '--profile', 'beta', '--json'], first, 1)).toBe('');
    const paused = (JSON.parse(run(['jobs', 'list', '--json'])).data.jobs as Array<{ id: string; status: string; scope: { profileId: string } }>).find((job) => job.status === 'paused' && job.scope.profileId === beta.scope.profileId);
    expect(paused).toBeDefined();
    const second = resolve(directory, 'second.json');
    writeFileSync(second, JSON.stringify({ interactions: [...base.interactions, { request: { method: 'GET', host: 'www.xuetangx.com', path: '/hd.mp4', headers: { range: 'bytes=3-', 'if-range': '"v1"' } }, response: { status: 206, headers: { etag: '"v1"', 'content-range': 'bytes 3-5/6', 'content-type': 'video/mp4' }, base64: Buffer.from('def').toString('base64') } }] }));
    const resumed = JSON.parse(run(['jobs', 'resume', paused!.id, '--profile', 'beta', '--json'], second)).data as { job: { id: string; status: string }; files: string[] };
    expect(resumed.job).toMatchObject({ id: paused!.id, status: 'succeeded' });
    expect(readFileSync(resumed.files[0]!, 'utf8')).toBe('abcdef');
    expect(alpha.scope.profileId).not.toBe(beta.scope.profileId);
  }, 30_000);
});
