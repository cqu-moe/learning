import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { parseArgs } from 'node:util';
import { executable, releaseDirectory, root, bunVersion } from './build-cli.mjs';
import { egressBoundary, loopbackCommand } from './helpers/loopback-command.mjs';
import { platformProxy } from './helpers/platform-proxy.mjs';
import { fixture, strict, get, asset, media, slides, outline, xtHomework, embedded, red, blue, clip, largeClip, changedClip, segment, blueSegment, initSegment, fragment } from './helpers/export-fixtures.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  case: { type: 'string' }, fault: { type: 'string' },
} });
const cases = ['assessments', 'slides', 'direct', 'hls', 'range-206', 'range-ignored', 'range-validator', 'range-416', 'direct-kill', 'hls-kill', 'failures', 'cancel', 'hls-cancel', 'slide-cancel'];
const faults = ['wrong-bytes', 'wrong-pdf', 'missing-fixture', 'unregistered-route', 'cleanup-failure'];
assert.ok(values.case === undefined || cases.includes(values.case), 'unknown export case');
assert.ok(values.fault === undefined || faults.includes(values.fault), 'unknown fault control');
assert.ok(positionals.length <= 1, 'only one standalone artifact may be supplied');
const binary = resolve(positionals[0] ?? resolve(releaseDirectory, executable));
const reportDir = resolve(root, 'dist/e2e');
mkdirSync(reportDir, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1, suite: 'standalone-exports', platform: process.platform, arch: process.arch, bunVersion,
  control: values.fault ?? 'journey', selectedCase: values.case ?? 'all', egressBoundary,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  artifact: { name: basename(binary), sha256: existsSync(binary) ? sha256(readFileSync(binary)) : null }, runs: [],
};
const failures = [];
let attempted = 0;

function records(home, prefix) {
  assert.ok(['job:', 'download:', 'hls:'].some(allowed => prefix.startsWith(allowed)), 'read only non-secret evidence records');
  const db = new DatabaseSync(resolve(home, 'state.db'), { readOnly: true });
  try {
    return db.prepare('SELECT key, value FROM records WHERE key GLOB ? ORDER BY key').all(prefix + '*')
      .map(row => ({ key: row.key, value: JSON.parse(row.value) }));
  } finally { db.close(); }
}
async function until(observe, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = observe();
    if (value) return value;
    await delay(10);
  }
  assert.fail('timed out observing ' + label);
}
async function remove(directory) {
  let error;
  for (let attempt = 1; attempt <= 50; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      if (!existsSync(directory)) return { cleaned: true, cleanupAttempts: attempt };
    } catch (cause) {
      error = cause.code ?? cause.name;
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM', 'EMFILE', 'ENFILE'].includes(error)) break;
    }
    if (process.platform !== 'win32') break;
    await delay(100);
  }
  return { cleaned: !existsSync(directory), cleanupError: error };
}
const flatten = nodes => nodes.flatMap(node => [...node.resources, ...flatten(node.children)]);

try {
  assert.ok(existsSync(binary), 'standalone artifact missing');
  for (let pass = 1; pass <= 2; pass++) {
    const directory = mkdtempSync(resolve(root, 'dist/只读导出 '));
    const home = resolve(directory, '账号 数据');
    const output = resolve(directory, '课程 导出');
    const record = { pass, directory: basename(directory), status: 'running', commands: [], cases: [], files: [], interruptions: [], failures: [], cleaned: false };
    report.runs.push(record);
    let proxy, activeChild, stage = 'artifact-copy';
    const children = new Set();
    const fail = (error, phase) => {
      record.status = 'failed';
      // Preserve useful assertion reasons without retaining CLI output or request data.
      const message = error.message.split('\n')[0].split(directory).join('<isolated>');
      record.failures.push({ phase, code: error.code ?? error.name, message });
      failures.push(new Error(phase + ': ' + message));
    };
    try {
      const program = resolve(directory, executable);
      copyFileSync(binary, program);
      if (process.platform !== 'win32') chmodSync(program, 0o755);
      stage = 'platform-proxy-setup';
      proxy = await platformProxy(directory);
      const env = {
        PATH: '', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CI: '1', LEARNING_HOME: resolve(directory, 'unused-home'), LEARNING_TELEMETRY_DISABLED: '1',
        HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, ALL_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: relative(directory, proxy.ca),
      };
      const secrets = [...proxy.secrets, 'exam-session-fixture', 'crypt-fixture', 'xtx-crypt-fixture', 'xtx-exam-sess'];
      async function run(args, expected = 0, { killed = false, timeout = process.platform === 'win32' ? 75_000 : 15_000 } = {}) {
        const startedAt = Date.now();
        const [command, argv] = loopbackCommand(program, ['--home', home, ...args, '--json'], proxy.url);
        const child = spawn(command, argv, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
        activeChild = child;
        children.add(child);
        let stdout = '', stderr = '', timedOut = false, stdoutBytes = 0, stderrBytes = 0, spawnErrorCode;
        child.stdout.on('data', chunk => { stdout += chunk; stdoutBytes += chunk.length; });
        child.stderr.on('data', chunk => { stderr += chunk; stderrBytes += chunk.length; });
        child.once('error', error => { spawnErrorCode = error.code ?? error.name; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
        let result;
        try {
          result = await new Promise(res => {
            child.once('close', (code, signal) => { children.delete(child); res({ code, signal }); });
          });
        } finally { clearTimeout(timer); }
        const event = { command: args.slice(0, args[0] === 'jobs' ? 2 : 1).join(' '), ...result, timedOut, elapsedMs: Date.now() - startedAt, timeoutMs: timeout, stdoutBytes, stderrBytes, ...(spawnErrorCode ? { spawnErrorCode } : {}) };
        record.commands.push(event);
        assert.equal(timedOut, false, 'standalone command timed out in ' + stage);
        assert.equal(spawnErrorCode, undefined, 'standalone command could not launch');
        for (const secret of secrets) assert.ok(!(stdout + stderr).includes(secret), 'sensitive CLI output');
        proxy.assertHealthy();
        if (killed) {
          assert.equal(result.code, null, 'interrupted binary must not report success');
          assert.equal(result.signal, 'SIGKILL');
          return;
        }
        assert.equal(result.signal, null, 'standalone command terminated by signal');
        assert.ok(stdoutBytes + stderrBytes > 0, 'standalone command returned no JSON output');
        let envelope;
        try { envelope = JSON.parse(stdout || stderr); } catch { throw Object.assign(new Error('standalone JSON envelope missing'), { code: 'BINARY_JSON' }); }
        event.errorCode = envelope.error?.code;
        assert.equal(result.code, expected, 'command exit mismatch (' + (envelope.error?.code ?? 'none') + ')');
        return envelope;
      }
      const command = (profile, args, expected, options) => run([...args, '--profile', profile], expected, options);
      const download = (profile, resource, options = []) => ['download', resource.ref.key, '--types', resource.kind, '--output-dir', output, ...options, '--profile', profile];
      async function jobShow(id, profile) {
        return (await command(profile, ['jobs', 'show', id])).data;
      }
      async function jobList() { return (await run(['jobs', 'list'])).data.jobs; }
      function noPublished(job) {
        const path = resolve(output, job.id);
        assert.ok(!existsSync(path) || readdirSync(path).length === 0, 'incomplete user export was published');
        assert.ok(job.items.every(item => item.artifacts.length === 0), 'failed item published artifacts');
      }
      async function verify(result, expected, profile, outputRoot = output) {
        const { job, files } = result.data;
        assert.equal(job.status, 'succeeded');
        assert.equal(job.completed, job.total);
        assert.equal(files.length, expected.length, 'export file count');
        assert.equal(job.items.flatMap(item => item.artifacts).length, files.length);
        const artifacts = job.items.flatMap(item => item.artifacts);
        for (let index = 0; index < files.length; index++) {
          const bytes = readFileSync(files[index]);
          assert.equal(resolve(files[index]), resolve(outputRoot, job.id, artifacts[index].filename));
          assert.equal(bytes.length, artifacts[index].bytes);
          assert.equal(sha256(bytes), artifacts[index].sha256);
          if (Buffer.isBuffer(expected[index])) assert.ok(bytes.equals(expected[index]), 'export bytes mismatch');
          else expected[index](bytes);
          record.files.push({ case: stage, filename: artifacts[index].filename, bytes: bytes.length, sha256: sha256(bytes) });
        }
        assert.deepEqual(await jobShow(job.id, profile), job, 'saved public job differs from export result');
        return job;
      }
      async function failed(args, script, errorCode) {
        const before = new Set((await jobList()).map(job => job.id));
        const blobs = () => existsSync(resolve(home, 'artifacts')) ? readdirSync(resolve(home, 'artifacts')).filter(name => name.endsWith('.blob')).sort() : [];
        const publishedBefore = blobs();
        proxy.use(script);
        const result = await run(args, errorCode === 'UNSUPPORTED' ? 3 : 1);
        if (errorCode) assert.equal(result.error.code, errorCode);
        proxy.done();
        const added = (await jobList()).filter(job => !before.has(job.id));
        assert.equal(added.length, 1, 'failure must retain one real job');
        assert.equal(added[0].status, 'paused');
        noPublished(added[0]);
        assert.deepEqual(blobs(), publishedBefore, 'failed export left a newly published internal blob');
        record.failuresExpected ??= [];
        record.failuresExpected.push({ case: stage, errorCode: result.error.code, jobStatus: added[0].status });
        return added[0];
      }
      stage = 'public-login-and-catalog';
      await run(['init']);
      await run(['profile', 'add', 'ykt', '--platform', 'ykt']);
      proxy.use('ykt/qr-login');
      assert.equal((await command('ykt', ['login', '--qr-file', resolve(directory, 'qr.png')])).data.identityVerified, true);
      proxy.done();
      assert.equal(existsSync(resolve(directory, 'qr.png')), false);
      await run(['profile', 'add', 'xt', '--platform', 'xuetang']);
      const imported = resolve(directory, 'synthetic-cookies.json');
      writeFileSync(imported, JSON.stringify([{ name: 'sessionid', value: 'xtx-sess-fixture', domain: 'www.xuetangx.com', path: '/' }]));
      await command('xt', ['login', '--import', imported]);
      proxy.use(strict(fixture('xuetang/courses')));
      assert.equal((await command('xt', ['whoami'])).data.state, 'valid');
      proxy.done();
      const resources = {};
      for (const [profile, platform, listFixture] of [['ykt', 'ykt', 'ykt/courses-list'], ['xt', 'xuetang', 'xuetang/courses']]) {
        proxy.use(strict(fixture(listFixture)));
        const courses = (await command(profile, ['courses'])).data.items;
        proxy.done();
        proxy.use(outline(platform));
        const result = await command(profile, ['outline', courses[0].ref.key]);
        proxy.done();
        resources[profile] = Object.fromEntries(flatten(result.data.value.roots).map(resource => [resource.ref.native.leafId, resource]));
      }
      const slideArgs = ['slide', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--output-dir', output, '--profile', 'ykt'];
      const slideAssets = () => [
        asset('www.yuketang.cn', '/e2e/red.png', red, { mime: 'image/png' }),
        asset('www.yuketang.cn', '/e2e/blue.png', blue, { mime: 'image/png' }),
      ];
      const hlsPrefix = () => [...media('ykt'),
        get('www.yuketang.cn', '/hd.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n/e2e/list.m3u8\n'),
        get('www.yuketang.cn', '/e2e/list.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.4,\nred.ts\n#EXTINF:0.4,\nblue.ts\n#EXT-X-ENDLIST\n'),
      ];
      const selected = values.case ? [values.case] : cases;
      for (const name of selected) {
        stage = name;
        attempted++;
        if (name.endsWith('cancel') && process.platform === 'win32') {
          record.cases.push({ name, status: 'not-run', reason: 'Windows console Ctrl+C requires a console harness' });
          continue;
        }
        if (name === 'assessments') {
          const homeworkRead = fixture('ykt/exercise-read');
          homeworkRead[1].response.body.data.problems[0].content.Body += '<img src="/e2e/red.png" alt="示意图">';
          proxy.use([...strict(homeworkRead),
            get('www.yuketang.cn', '/fonts/fixture.woff', '', { status: 404 }),
            asset('www.yuketang.cn', '/e2e/red.png', red, { mime: 'image/png' }),
          ]);
          const hw = await command('ykt', ['download', resources.ykt['505'].ref.key, '--types', 'homework', '--output-dir', output], 4);
          proxy.done();
          const { job: homeworkJob, files: homeworkFiles } = hw.data;
          assert.equal(homeworkJob.status, 'partial');
          assert.equal(homeworkJob.items[0].state, 'partial');
          assert.equal(homeworkFiles.length, 3);
          const markdownPath = homeworkFiles.find(file => file.endsWith('题面.md'));
          const yamlPath = homeworkFiles.find(file => file.endsWith('answers.yaml'));
          const imagePath = homeworkFiles.find(file => file.endsWith('.png'));
          const markdown = readFileSync(markdownPath, 'utf8');
          assert.ok(markdown.includes('[不完整]') && markdown.includes('【未解码】'));
          assert.ok(markdown.includes('A. 甲'));
          assert.ok(markdown.includes(`assets/${sha256(red)}.png`));
          assert.ok(readFileSync(imagePath).equals(red));
          const { parseLearningDraft } = await import('../packages/sdk/dist/services/drafts.js');
          const homeworkDraft = parseLearningDraft(readFileSync(yamlPath, 'utf8'));
          assert.equal(homeworkDraft.ref.kind, 'homework');
          assert.equal(homeworkDraft.entries[0].answer.kind, 'unset');
          const artifacts = homeworkJob.items[0].artifacts;
          for (const [file, mimeType] of [[markdownPath, 'text/markdown'], [yamlPath, 'application/yaml'], [imagePath, 'image/png']]) {
            const bytes = readFileSync(file);
            const artifact = artifacts.find(value => value.mimeType === mimeType);
            assert.equal(bytes.length, artifact.bytes);
            assert.equal(sha256(bytes), artifact.sha256);
            assert.ok(!relative(output, file).startsWith('..'));
            record.files.push({ case: stage, filename: basename(file), bytes: bytes.length, sha256: sha256(bytes) });
          }
          const manifestPath = resolve(markdownPath, '..', '.hidden', 'manifest.json');
          const manifestBytes = readFileSync(manifestPath);
          assert.equal(sha256(manifestBytes), artifacts.find(value => value.mimeType === 'application/vnd.learning.homework+json').sha256);
          const manifest = JSON.parse(manifestBytes);
          assert.equal(manifest.questions[0].body.decodeState, 'partial');
          assert.equal(manifest.questions[0].myAnswer, null);
          assert.deepEqual(await jobShow(homeworkJob.id, 'ykt'), homeworkJob);
          proxy.use(xtHomework);
          await verify(await run(download('xt', resources.xt['31'])), [bytes => {
            const value = JSON.parse(bytes);
            assert.equal(value.questions[0].body.markdown, '<p>电阻 R = ? Ω</p>');
            assert.equal(value.questions[0].kind, 'fill-blank');
            assert.equal(value.questions[0].myAnswer, null);
          }], 'xt');
          proxy.done();
          for (const [profile, leaf, script] of [['ykt', '510', 'ykt/exam-read'], ['xt', '30', 'xuetang/exam-read']]) {
            proxy.use(strict(fixture(script)));
            await verify(await command(profile, ['exam', 'export', resources[profile][leaf].ref.key, '--output-dir', output]), [bytes => {
              const value = JSON.parse(bytes);
              assert.equal(value.ref.kind, 'exam');
              assert.equal(value.state, 'submitted');
              assert.equal(value.questions.length, 2);
              assert.equal(value.questions[0].id, '1');
              assert.equal(value.questions[0].myAnswer.keys[0], 'A');
              assert.equal(value.questions[1].myAnswer, null);
              if (profile === 'xt') assert.equal(value.questions[1].kind, 'unknown');
            }], profile);
            proxy.done();
          }
          proxy.use([embedded[0], ...embedded]);
          const draftPath = resolve(directory, '内嵌题.yaml');
          await command('ykt', ['homework', 'draft', resources.ykt['502'].ref.key, '-o', draftPath]);
          proxy.done();
          const require = createRequire(new URL('../packages/sdk/package.json', import.meta.url));
          const draft = require('yaml').parse(readFileSync(draftPath, 'utf8'));
          assert.equal(draft.entries.length, 1);
          assert.equal(draft.entries[0].answer.kind, 'unset');
          assert.equal(draft.ref.kind, 'embedded');
          assert.equal(draft.ref.assessmentId, '888');
          assert.equal(draft.entries[0].questionId, '11');
          assert.equal(draft.entries[0].evidence, null);
          const before = (await jobList()).length;
          assert.equal((await command('ykt', ['download', resources.ykt['504'].ref.key, '--types', 'homework', '--output-dir', output], 3)).error.code, 'UNSUPPORTED');
          assert.equal((await jobList()).length, before, 'unsupported content must not create a successful job');
        } else if (name === 'slides') {
          proxy.use([...slides(), ...slideAssets()]);
          await verify(await run([...slideArgs, '--format', 'images']), [red, blue], 'ykt');
          proxy.done();
          proxy.use([...slides(), ...slideAssets()]);
          const pdf = await run([...slideArgs, '--format', 'pdf']);
          proxy.done();
          await verify(pdf, [bytes => assert.ok(bytes.length > 0)], 'ykt');
          let result;
          try {
            result = execFileSync(process.env.LEARNING_PDF_PYTHON ?? 'python3', [resolve(root, 'scripts/helpers/verify-export-pdf.py'), pdf.data.files[0], ...(values.fault === 'wrong-pdf' ? ['wrong-pixels'] : [])], { encoding: 'utf8', timeout: 15_000 });
          } catch (error) {
            if (values.fault === 'wrong-pdf') assert.match(String(error.stderr), /AssertionError: PDF page pixels mismatch/);
            throw Object.assign(new Error('independent PDF verification failed'), { code: 'PDF_VERIFY_FAILED' });
          }
          record.pdf = JSON.parse(result);
        } else if (name === 'direct') {
          const bytes = ['wrong-bytes', 'cleanup-failure'].includes(values.fault) ? Buffer.from('corrupt external media') : clip;
          const script = [...media('xuetang', '/sd.mp4', 'sd'), asset('www.xuetangx.com', '/sd.mp4', bytes), ...strict(fixture('xuetang/lecture-note'))];
          if (values.fault === 'missing-fixture') script.length = 2;
          if (values.fault === 'unregistered-route') script[2].request.path = '/not-declared.mp4';
          proxy.use(script);
          await verify(await run(download('xt', resources.xt['7'], ['--quality', 'sd', '--subtitles'])), [clip, bytes => {
            assert.deepEqual(JSON.parse(bytes), { language: 'zh-CN', state: 'available', segments: [{ text: '本节讲述', startMs: 0, endMs: 4000 }] });
          }], 'xt');
          proxy.done();
        } else if (name === 'hls') {
          proxy.use([...hlsPrefix(), asset('www.yuketang.cn', '/e2e/red.ts', segment, { mime: 'video/mp2t' }),
            asset('www.yuketang.cn', '/e2e/blue.ts', blueSegment, { mime: 'video/mp2t' }), ...strict(fixture('ykt/transcript'))]);
          await verify(await run(download('ykt', resources.ykt['502'], ['--subtitles'])), [Buffer.concat([segment, blueSegment]), bytes => {
            assert.deepEqual(JSON.parse(bytes), { language: 'zh-CN', state: 'available', segments: [{ text: '第一句', startMs: 0, endMs: 2000 }] });
          }], 'ykt');
          proxy.done();
          proxy.use([...media('ykt'), get('www.yuketang.cn', '/hd.m3u8', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:0.4,\nfragment.m4s\n#EXT-X-ENDLIST\n'),
            asset('www.yuketang.cn', '/init.mp4', initSegment), asset('www.yuketang.cn', '/fragment.m4s', fragment)]);
          await verify(await run(download('ykt', resources.ykt['502'])), [Buffer.concat([initSegment, fragment])], 'ykt');
          proxy.done();
        } else if (name === 'slide-cancel') {
          const before = new Set((await jobList()).map(job => job.id));
          const image = slideAssets()[0];
          image.response.respond = async response => {
            response.write(red.subarray(0, 12));
            await until(() => records(home, 'job:').some(row => !before.has(row.value.id) && row.value.status === 'running'), 'running slide export');
            assert.ok(activeChild.kill('SIGINT'));
            await new Promise(res => { if (response.destroyed) res(); else response.once('close', res); });
          };
          proxy.use([...slides(), image]);
          await run([...slideArgs, '--format', 'pdf'], 3, { timeout: 3000 });
          proxy.done();
          const [job] = (await jobList()).filter(job => !before.has(job.id));
          assert.equal(job.status, 'paused');
          noPublished(job);
          assert.equal((await jobShow(job.id, 'ykt')).status, 'paused');
        } else if (name.startsWith('range-') || name === 'direct-kill' || name === 'hls-kill' || name.endsWith('cancel')) {
          const isHls = name.startsWith('hls-');
          const kill = name.endsWith('-kill');
          const cancel = name.endsWith('cancel');
          const profile = isHls ? 'ykt' : 'xt';
          const resource = resources[profile][isHls ? '502' : '7'];
          const before = new Set((await jobList()).map(job => job.id));
          const prefix = isHls ? blueSegment.subarray(0, 188) : largeClip.subarray(0, kill ? 8 * 1024 * 1024 : 256 * 1024);
          let interruptedId;
          const response = async response => {
            const owner = activeChild;
            response.write(prefix);
            await until(() => {
              const jobs = records(home, 'job:').map(row => row.value).filter(job => !before.has(job.id));
              if (jobs.length !== 1) return false;
              interruptedId = jobs[0].id;
              if (kill) {
                const saved = records(home, (isHls ? 'hls:' : 'download:') + interruptedId + ':')[0]?.value;
                if (isHls) return saved?.nextIndex === 1 && statSync(resolve(home, 'artifacts', sha256(saved.checkpoint.id) + '.part')).size > saved.bytes;
                return saved?.bytes === prefix.length;
              }
              const id = interruptedId + ':' + resource.ref.key + ':media';
              const path = resolve(home, 'artifacts', sha256(id) + '.part');
              return existsSync(path) && statSync(path).size >= prefix.length + (isHls ? segment.length : 0);
            }, 'real persisted partial');
            if (kill) {
              assert.equal((await command(profile, ['jobs', 'resume', interruptedId], 3)).error.code, 'CONFLICT', 'live writer must retain exclusive ownership');
              assert.equal(records(home, 'job:' + interruptedId)[0].value.status, 'running');
            }
            if (kill || cancel) {
              assert.ok(owner.kill(kill ? 'SIGKILL' : 'SIGINT'));
              await new Promise(res => { if (response.destroyed) res(); else response.once('close', res); });
            } else response.destroy();
          };
          proxy.use(isHls ? [...hlsPrefix(), asset('www.yuketang.cn', '/e2e/red.ts', segment, { mime: 'video/mp2t' }),
            asset('www.yuketang.cn', '/e2e/blue.ts', blueSegment, { mime: 'video/mp2t', respond: response })]
            : [...media('xuetang'), asset('www.xuetangx.com', '/hd.mp4', largeClip, { headers: { etag: '"version-1"' }, respond: response })]);
          // Windows process.kill is forced termination, not a console Ctrl+C.
          // Its forced-exit recovery is covered above; signal cancellation is POSIX-only.
          await run(download(profile, resource), cancel ? 3 : 1, { killed: kill, timeout: cancel ? 3000 : process.platform === 'win32' ? 75_000 : 15_000 });
          proxy.done();
          const interrupted = (await jobList()).filter(job => !before.has(job.id));
          assert.equal(interrupted.length, 1);
          noPublished(interrupted[0]);
          assert.equal(interrupted[0].status, kill ? 'running' : 'paused');
          const checkpoint = records(home, (isHls ? 'hls:' : 'download:') + interruptedId + ':')[0]?.value;
          assert.ok(checkpoint && checkpoint.bytes > 0, 'actual persisted download checkpoint missing');
          const partial = readFileSync(resolve(home, 'artifacts', sha256(checkpoint.checkpoint.id) + '.part'));
          assert.equal(sha256(partial.subarray(0, checkpoint.bytes)), checkpoint.checkpoint.sha256);
          record.interruptions.push({ case: name, status: interrupted[0].status, bytes: checkpoint.bytes, partBytes: partial.length, nextIndex: checkpoint.nextIndex, prefixSha256: checkpoint.checkpoint.sha256 });
          if (cancel) {
            assert.equal((await command(profile, ['jobs', 'cancel', interruptedId, '--yes'])).data.status, 'canceled');
            assert.equal((await jobShow(interruptedId, profile)).status, 'canceled');
          } else {
            let expected = largeClip;
            let script;
            if (isHls) {
              script = [...hlsPrefix(), asset('www.yuketang.cn', '/e2e/blue.ts', blueSegment, { mime: 'video/mp2t' })];
              expected = Buffer.concat([segment, blueSegment]);
            } else {
              const headers = { range: 'bytes=' + checkpoint.bytes + '-', 'if-range': '"version-1"' };
              const suffix = largeClip.subarray(checkpoint.bytes);
              const range = asset('www.xuetangx.com', '/hd.mp4', suffix, { status: 206, requestHeaders: headers,
                headers: { etag: '"version-1"', 'content-range': 'bytes ' + checkpoint.bytes + '-' + (largeClip.length - 1) + '/' + largeClip.length } });
              script = [...media('xuetang'), range];
              if (name === 'range-ignored') script[2] = asset('www.xuetangx.com', '/hd.mp4', largeClip, { requestHeaders: headers, headers: { etag: '"version-1"' } });
              if (name === 'range-validator') {
                range.response.headers.etag = '"version-2"';
                script.push(asset('www.xuetangx.com', '/hd.mp4', changedClip, { headers: { etag: '"version-2"' } }));
                expected = changedClip;
              }
              if (name === 'range-416') {
                script[2] = asset('www.xuetangx.com', '/hd.mp4', Buffer.alloc(0), { status: 416, requestHeaders: headers, headers: { 'content-range': 'bytes */' + clip.length } });
                script.push(asset('www.xuetangx.com', '/hd.mp4', clip, { headers: { etag: '"version-3"' } }));
                expected = clip;
              }
            }
            proxy.use(script);
            await verify(await command(profile, ['jobs', 'resume', interruptedId]), [expected], profile);
            proxy.done();
            assert.equal(records(home, (isHls ? 'hls:' : 'download:') + interruptedId + ':').length, 0, 'successful resume retained checkpoint');
          }
        } else if (name === 'failures') {
          const mediaArgs = download('xt', resources.xt['7']);
          await failed(mediaArgs, [...media('xuetang'), asset('www.xuetangx.com', '/hd.mp4', Buffer.alloc(0), { status: 404 })], 'PROTOCOL');
          await failed(mediaArgs, [...media('xuetang'), asset('www.xuetangx.com', '/hd.mp4', Buffer.alloc(0), { headers: { 'content-length': String(4 * 1024 ** 3 + 1) } })], 'BUDGET');
          for (const unsupported of ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nsegment.ts\n', '#EXTM3U\n#EXT-X-BYTERANGE:20@0\nsegment.ts\n']) {
            await failed(download('ykt', resources.ykt['502']), [...media('ykt'), get('www.yuketang.cn', '/hd.m3u8', unsupported)], 'UNSUPPORTED');
          }
          await failed(download('ykt', resources.ykt['502']), [...media('ykt'),
            get('www.yuketang.cn', '/hd.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsecond.m3u8\n'),
            get('www.yuketang.cn', '/second.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nthird.m3u8\n')], 'UNSUPPORTED');
          const images = slideAssets();
          images[1] = asset('www.yuketang.cn', '/e2e/blue.png', Buffer.from('broken image'), { mime: 'image/png' });
          await failed([...slideArgs, '--format', 'pdf'], [...slides(), ...images], 'INTEGRITY');
          const tooLarge = Buffer.from(red);
          tooLarge.writeUInt32BE(10000, 16); tooLarge.writeUInt32BE(10000, 20);
          await failed([...slideArgs, '--format', 'pdf'], [...slides([{ index: 0, cover: 'https://www.yuketang.cn/e2e/red.png' }]), asset('www.yuketang.cn', '/e2e/red.png', tooLarge, { mime: 'image/png' })], 'BUDGET');
          await failed([...slideArgs, '--format', 'pdf'], slides(Array.from({ length: 501 }, (_, index) => ({ index, cover: 'https://www.yuketang.cn/e2e/red.png' }))), 'BUDGET');
          if (process.platform !== 'win32') {
            const storage = resolve(home, 'artifacts');
            const denied = asset('www.xuetangx.com', '/hd.mp4', clip, { respond: response => {
              chmodSync(storage, 0o500);
              response.end(clip);
            } });
            try {
              await failed(mediaArgs, [...media('xuetang'), denied]);
              assert.equal(statSync(storage).mode & 0o777, 0o500, 'real artifact write denial must remain in force');
              record.artifactWriteFailure = { cause: 'POSIX EACCES', jobStatus: 'paused', published: false };
            } finally { chmodSync(storage, 0o700); }
          } else record.artifactWriteFailure = { status: 'not-run', reason: 'POSIX permission denial; blocked output path is tested on all platforms' };
          const blocker = resolve(directory, 'output-is-a-file');
          writeFileSync(blocker, 'preserve');
          const before = new Set((await jobList()).map(job => job.id));
          proxy.use([...media('xuetang'), asset('www.xuetangx.com', '/hd.mp4', clip)]);
          const badDisk = await command('xt', ['download', resources.xt['7'].ref.key, '--types', 'video', '--output-dir', blocker], 2);
          proxy.done();
          assert.equal(badDisk.ok, false);
          assert.equal(readFileSync(blocker, 'utf8'), 'preserve');
          const saved = (await jobList()).filter(job => !before.has(job.id));
          assert.equal(saved.length, 1);
          assert.equal(saved[0].status, 'succeeded', 'artifact success and publication failure are distinct');
          record.storageFailure = { code: badDisk.error.code, jobStatus: saved[0].status, published: false, cause: 'ENOTDIR output root' };
          await rm(blocker);
          mkdirSync(blocker);
          await verify(await command('xt', ['jobs', 'resume', saved[0].id]), [clip], 'xt', blocker);
          proxy.done();
          // Missing subtitles must keep the valid video; never substitute an empty transcript.
          const absent = strict(fixture('xuetang/lecture-note'));
          absent[0].response.body.data = [];
          proxy.use([...media('xuetang'), asset('www.xuetangx.com', '/hd.mp4', clip), ...absent]);
          await verify(await run(download('xt', resources.xt['7'], ['--subtitles'])), [clip], 'xt');
          proxy.done();
          const unavailable = strict(fixture('xuetang/lecture-note'))[0];
          unavailable.response = { status: 503, body: { success: false } };
          proxy.use([...media('xuetang'), asset('www.xuetangx.com', '/hd.mp4', clip), unavailable, unavailable, unavailable]);
          const preserved = await run(download('xt', resources.xt['7'], ['--subtitles']));
          await verify(preserved, [clip], 'xt');
          assert.equal(preserved.data.job.items[0].message, 'transcript unavailable; video kept');
          proxy.done();
        }
        record.cases.push({ name, status: 'passed' });
      }
      assert.equal(record.cases.filter(test => test.status === 'passed').length, selected.filter(name => process.platform !== 'win32' || !name.endsWith('cancel')).length);
      assert.equal(existsSync(env.LEARNING_HOME), false);
      assert.equal(existsSync(resolve(home, 'learning.lock')), false, 'writer lock remains');
      assert.equal(children.size, 0);
      proxy.done();
      record.status = 'passed';
    } catch (error) {
      fail(error, stage);
      if (values.fault === 'cleanup-failure') {
        assert.notEqual(process.platform, 'win32', 'POSIX cleanup denial control only');
        chmodSync(directory, 0o000);
      }
    }
    finally {
      for (const child of children) {
        child.kill('SIGKILL');
        await new Promise(res => child.once('close', res));
      }
      record.childrenClosed = children.size === 0;
      record.network = proxy?.evidence();
      try { await proxy?.close(); record.listenersClosed = true; } catch (error) { fail(error, 'proxy-close'); }
      try {
        Object.assign(record, await remove(directory));
        assert.equal(record.cleaned, true, 'isolated export directory still exists after cleanup');
      } catch (error) { fail(error, 'directory-cleanup'); }
    }
    if (failures.length) break;
  }
  if (failures.length) throw new AggregateError(failures, 'standalone exports failed; all failures retained');
  assert.ok(attempted > 0, 'zero export cases');
} finally {
  writeFileSync(resolve(reportDir, 'exports-' + report.control + '-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log('OK standalone exports: two isolated real-binary runs, independent artifacts and cleanup');
