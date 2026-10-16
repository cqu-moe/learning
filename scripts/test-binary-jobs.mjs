import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, relative, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { URLSearchParams } from 'node:url';
import { bunVersion, executable, releaseDirectory, root } from './build-cli.mjs';
import { egressBoundary, loopbackCommand } from './helpers/loopback-command.mjs';
import { platformProxy } from './helpers/platform-proxy.mjs';
import { fixture, strict } from './helpers/export-fixtures.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  fault: { type: 'string' },
} });
const faults = ['wrong-expectation', 'missing-fixture', 'unregistered-route', 'reconcile-no-advance', 'unknown-duration-success', 'popup-write', 'cleanup-failure'];
assert.ok(values.fault === undefined || faults.includes(values.fault), 'unknown jobs fault control');
assert.ok(positionals.length <= 1, 'only one standalone artifact may be supplied');
const binary = resolve(positionals[0] ?? resolve(releaseDirectory, executable));
const reportDir = resolve(root, 'dist/e2e');
mkdirSync(reportDir, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const flatten = nodes => nodes.flatMap(node => [...node.resources, ...flatten(node.children)]);
const zhsVideoKey = Buffer.from('azp53h0kft7qi78q');
const zhsIv = Buffer.from('1g3qqdh4jvbskb9x');

function unsealZhsForm(body) {
  const form = new URLSearchParams(body);
  assert.deepEqual([...form.keys()].sort(), ['dateFormate', 'secretStr'], 'ZHS encrypted form fields mismatch');
  const dateFormate = Number(form.get('dateFormate'));
  assert.ok(Number.isSafeInteger(dateFormate) && dateFormate % 1000 === 0 && dateFormate <= Date.now() + 1000, 'ZHS dateFormate is invalid');
  const sealed = form.get('secretStr');
  assert.ok(sealed !== null && sealed !== '', 'ZHS secretStr is missing');
  const decipher = createDecipheriv('aes-128-cbc', zhsVideoKey, zhsIv);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed, 'base64')), decipher.final()]).toString('utf8'));
}

function zhsSealed(expected) {
  return body => {
    const payload = unsealZhsForm(body);
    const { dateFormate, ...fields } = payload;
    assert.ok(Number.isSafeInteger(dateFormate), 'decrypted ZHS dateFormate is invalid');
    assert.deepEqual(fields, expected, 'decrypted ZHS payload mismatch');
  };
}

function reverseZhsEv(encoded) {
  let out = '';
  for (let index = 0; index < encoded.length; index += 2) {
    const byte = Number.parseInt(encoded.slice(index, index + 2), 16);
    out += String.fromCharCode(byte ^ 'zzpttjd'.charCodeAt((index / 2) % 'zzpttjd'.length));
  }
  return out;
}
const report = {
  schemaVersion: 1,
  suite: 'standalone-jobs',
  platform: process.platform,
  arch: process.arch,
  bunVersion,
  control: values.fault ?? 'journey',
  egressBoundary,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  artifact: { name: basename(binary), sha256: existsSync(binary) ? sha256(readFileSync(binary)) : null },
  runs: [],
};
const failures = [];

function records(home, prefix) {
  assert.ok(['job:', 'job-meta:', 'job-events:'].some(allowed => prefix.startsWith(allowed)), 'read only non-secret job records');
  const db = new DatabaseSync(resolve(home, 'state.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    return db.prepare('SELECT key, value FROM records WHERE key GLOB ? ORDER BY key').all(prefix + '*')
      .map(row => ({ key: row.key, value: JSON.parse(row.value) }));
  } finally {
    db.close();
  }
}

async function until(observe, label, timeout = process.platform === 'win32' ? 75_000 : 10_000, signal) {
  const startedAt = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    let value;
    try { value = observe(); }
    catch (error) {
      // A concurrent CLI can briefly hold SQLite's schema lock while opening.
      if (error.code !== 'ERR_SQLITE_ERROR' || (error.errcode & 255) !== 5) throw error;
    }
    if (value) return value;
    if (Date.now() - startedAt >= timeout) assert.fail('timed out observing ' + label);
    await delay(10, undefined, { signal });
  }
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

try {
  assert.ok(existsSync(binary), 'standalone artifact missing');
  for (let pass = 1; pass <= 2; pass++) {
    const directory = mkdtempSync(resolve(root, 'dist/学习任务 '));
    const home = resolve(directory, '账号 数据');
    const record = { pass, directory: basename(directory), status: 'running', commands: [], cases: [], interruptions: [], failures: [], cleaned: false };
    report.runs.push(record);
    let proxy;
    let stage = 'artifact-copy';
    const children = new Set();
    const fail = (error, phase) => {
      record.status = 'failed';
      const message = error.message.split('\n')[0].split(directory).join('<isolated>');
      record.failures.push({ phase, code: error.code ?? error.name, message });
      failures.push(new Error(phase + ': ' + message));
    };
    try {
      const program = resolve(directory, executable);
      copyFileSync(binary, program);
      if (process.platform !== 'win32') chmodSync(program, 0o755);
      proxy = await platformProxy(directory);
      const env = {
        PATH: '',
        HOME: directory,
        USERPROFILE: directory,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CI: '1',
        LEARNING_HOME: resolve(directory, 'unused-home'),
        LEARNING_TELEMETRY_DISABLED: '1',
        HTTPS_PROXY: proxy.url,
        HTTP_PROXY: proxy.url,
        ALL_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: relative(directory, proxy.ca),
      };
      const commandTimeoutMs = process.platform === 'win32' ? 75_000 : 30_000;
      async function run(args, expected = 0, options = {}) {
        options.signal?.throwIfAborted();
        const startedAt = Date.now();
        const timeout = Math.max(options.timeout ?? 0, commandTimeoutMs);
        const [command, argv] = loopbackCommand(program, ['--home', home, ...args, '--json', '--no-interactive'], proxy.url);
        const child = spawn(command, argv, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        const abortChild = () => child.kill('SIGKILL');
        options.signal?.addEventListener('abort', abortChild, { once: true });
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let spawnErrorCode;
        child.stdout.on('data', chunk => { stdout += chunk; stdoutBytes += chunk.length; });
        child.stderr.on('data', chunk => { stderr += chunk; stderrBytes += chunk.length; });
        child.once('error', error => { spawnErrorCode = error.code ?? error.name; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
        let killGateError;
        if (options.kill !== undefined) {
          void Promise.resolve(options.kill.when).then(() => child.kill(options.kill.signal)).catch(error => { killGateError = error; child.kill('SIGKILL'); });
        }
        const result = await new Promise(resolveClose => {
          child.once('close', (code, signal) => { children.delete(child); resolveClose({ code, signal }); });
        }).finally(() => { clearTimeout(timer); options.signal?.removeEventListener('abort', abortChild); });
        const event = {
          command: args.slice(0, args[0] === 'jobs' ? 2 : 1).join(' '),
          ...result,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: timeout,
          timedOut,
          stdoutBytes,
          stderrBytes,
          ...(spawnErrorCode ? { spawnErrorCode } : {}),
        };
        record.commands.push(event);
        if (killGateError) throw killGateError;
        assert.equal(timedOut, false, 'standalone jobs command timed out');
        assert.equal(spawnErrorCode, undefined, 'standalone jobs command could not launch');
        for (const secret of proxy.secrets) assert.ok(!(stdout + stderr).includes(secret), 'sensitive CLI output');
        proxy.assertHealthy();
        if (options.killed) {
          assert.equal(result.code, null, 'interrupted jobs command must not report success');
          assert.equal(result.signal, options.kill.signal);
          return { child, event };
        }
        assert.equal(result.signal, null, 'standalone jobs command terminated by signal');
        assert.ok(stdoutBytes + stderrBytes > 0, 'standalone jobs command returned no output');
        let envelope;
        try {
          envelope = JSON.parse(stdout || stderr);
        } catch {
          throw Object.assign(new Error('standalone jobs command returned invalid JSON'), { code: 'BINARY_JSON' });
        }
        event.errorCode = envelope.error?.code;
        assert.equal(result.code, expected, 'jobs command exit mismatch (' + (envelope.error?.code ?? 'none') + ')');
        return envelope;
      }
      async function command(profile, args, expected, options) {
        return run([...args, '--profile', profile], expected, options);
      }
      async function jobList(options) { return (await run(['jobs', 'list'], 0, options)).data.jobs; }
      async function jobShow(id, profile, options) { return (await command(profile, ['jobs', 'show', id], 0, options)).data; }
      function jobRecord(homeDir, id) { return records(homeDir, 'job:' + id)[0]?.value; }
      function waitForJobStatus(id, status) {
        return until(() => jobRecord(home, id)?.status === status, 'job status ' + status, 10_000);
      }

      stage = 'setup';
      await run(['init']);
      await run(['profile', 'add', 'ykt', '--platform', 'ykt']);
      proxy.use(values.fault === 'missing-fixture' ? [] : fixture('ykt/qr-login'));
      assert.equal((await command('ykt', ['login', '--qr-file', resolve(directory, 'qr.png')])).data.identityVerified, values.fault === 'wrong-expectation' ? false : true);
      proxy.done();
      if (values.fault === 'cleanup-failure') {
        writeFileSync(resolve(directory, 'cleanup-marker'), 'synthetic');
        chmodSync(directory, 0);
        throw Object.assign(new Error('intentional primary failure before cleanup denial'), { code: 'PRIMARY_CONTROL' });
      }
      proxy.use(strict(fixture('ykt/courses-list')), { cookie: 'sessionid=sess-fixture' });
      const courses = (await command('ykt', ['courses'])).data.items;
      proxy.done();
      const outlineItems = strict(fixture('ykt/nested-outline'));
      if (values.fault === 'unregistered-route') outlineItems[0].request.path = '/not-registered';
      proxy.use(outlineItems, { cookie: 'sessionid=sess-fixture' });
      const outline = (await command('ykt', ['outline', courses[0].ref.key])).data.value;
      proxy.done();
      const resource = flatten(outline.roots).find(item => item.ref.native.leafId === '502');
      assert.ok(resource, 'Yuketang video resource missing');

      const yktLeaf = (duration = 10) => ({
        tag: 'ykt-study-read',
        request: {
          method: 'GET',
          host: 'www.yuketang.cn',
          path: '/mooc-api/v1/lms/learn/leaf_info/28930736/502/',
          query: { classroom_id: '28930736' },
          headers: { xtbz: 'ykt' },
          cookie: 'sessionid=sess-fixture',
        },
        response: { status: 200, body: { success: true, data: { name: '权威进度视频', course_id: 5184094, user_id: 424242, sku_id: 901, content_info: { media: { ccid: 'CC1', duration } } } } },
      });
      const yktProgress = (rate, seconds = rate * 10, known = true) => ({
        tag: 'ykt-authoritative-read',
        request: {
          method: 'GET',
          host: 'www.yuketang.cn',
          path: '/video-log/get_video_watch_progress/',
          query: { cid: '5184094', user_id: '424242', classroom_id: '28930736', video_type: 'video', vtype: 'rate', video_id: '502', snapshot: '1', no_loading: 'true' },
          headers: { xtbz: 'ykt' },
          cookie: 'sessionid=sess-fixture',
        },
        response: { status: 200, body: { data: known ? { 502: { rate, completed: rate >= 1 ? 1 : 0, video_length: 10, last_point: seconds } } : {} } },
      });
      const yktNoMediaDuration = {
        tag: 'ykt-duration-read',
        request: {
          method: 'GET',
          host: 'www.yuketang.cn',
          path: '/api/open/audiovideo/playurl',
          query: { video_id: 'CC1', provider: 'cc', file_type: '1', is_single: '0', domain: 'www.yuketang.cn' },
          cookie: 'sessionid=sess-fixture',
        },
        response: { status: 200, body: { data: { playurl: { sources: {} } } } },
      };
      const yktHeartbeat = cp => ({
        tag: 'ykt-study-write',
        request: {
          method: 'POST',
          host: 'www.yuketang.cn',
          path: '/video-log/heartbeat/',
          headers: { 'content-type': 'application/json;charset=utf-8', xtbz: 'ykt', 'classroom-id': '28930736', 'x-requested-with': 'XMLHttpRequest' },
          cookie: 'sessionid=sess-fixture',
          bodyValidator: body => {
            const row = body.heart_data?.[0];
            assert.ok(row, 'Yuketang heartbeat row missing');
            assert.equal(row.et, 'heartbeat', 'Yuketang heartbeat et mismatch');
            assert.equal(row.cp, cp, 'Yuketang heartbeat cp mismatch');
            assert.equal(row.sp, 5, 'Yuketang heartbeat speed mismatch');
            assert.equal(row.sq, 1, 'Yuketang heartbeat sequence mismatch');
            assert.equal(String(row.c), '5184094', 'Yuketang heartbeat course mismatch');
            assert.equal(row.v, '502', 'Yuketang heartbeat video mismatch');
            assert.equal(row.classroomid, '28930736', 'Yuketang heartbeat classroom mismatch');
            assert.equal(row.cc, 'CC1', 'Yuketang heartbeat cc mismatch');
            assert.ok(Number(row.ts) <= Date.now() + 100, 'heartbeat has a future timestamp');
          },
        },
        response: { status: 200, body: { success: true } },
      });

      stage = 'ykt-unknown-progress';
      const beforeUnknown = new Set((await jobList()).map(job => job.id));
      proxy.use([yktLeaf(0), yktProgress(0, 0, false), yktNoMediaDuration]);
      const unknown = await command('ykt', ['run', '--resource', resource.ref.key, '--speed', '5', '--target', '0.5', '--dry-run', '--yes'], 3);
      assert.equal(unknown.error.code, 'INTERACTION_REQUIRED');
      assert.equal(unknown.ok, false);
      proxy.done();
      assert.deepEqual((await jobList()).map(job => job.id), [...beforeUnknown], 'unknown progress must not create a success job');
      record.cases.push({ name: 'ykt-unknown-duration', status: 'passed', jobsCreated: 0 });

      stage = 'ykt-authoritative-success';
      proxy.use([yktLeaf(), yktProgress(0), yktLeaf(), yktProgress(0), yktHeartbeat(5), yktLeaf(), yktProgress(0.5)]);
      const success = await command('ykt', ['run', '--resource', resource.ref.key, '--speed', '5', '--target', '0.5', '--yes']);
      proxy.done();
      const successJob = success.data;
      assert.equal(successJob.status, 'succeeded');
      assert.equal(successJob.completed, 1);
      assert.equal(successJob.items[0].state, 'succeeded');
      assert.deepEqual(await jobShow(successJob.id, 'ykt'), successJob, 'new process public job readback differs');
      const requestTags = proxy.evidence().requestLog.map(item => item.tag).filter(tag => tag === 'ykt-study-write');
      assert.equal(requestTags.length, 1, 'one authoritative write must be observed');
      record.cases.push({ name: 'ykt-authoritative-progress', status: 'passed', jobId: successJob.id, writes: requestTags.length });



      stage = 'ykt-embedded-review';
      const embeddedLeaf = () => {
        const item = yktLeaf();
        item.response.body.data.content_info.media.exercise_id = 888;
        return item;
      };
      const embeddedRead = right => ({
        tag: 'ykt-embedded-read',
        request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/exercise/leaf_video/problem/901/502/888/', query: { classroom_id: '28930736' }, headers: { xtbz: 'ykt' }, cookie: 'sessionid=sess-fixture' },
        response: { status: 200, body: { success: true, data: [{ problem_id: 11, content: { ProblemType: 1 }, user: { is_right: right } }] } },
      });
      const yktWritesBeforeQuestion = proxy.evidence().requestLog.filter(item => item.tag === 'ykt-study-write').length;
      proxy.use([embeddedLeaf(), yktProgress(1), embeddedLeaf(), yktProgress(1), embeddedRead(false)]);
      const embeddedJob = (await command('ykt', ['run', '--resource', resource.ref.key, '--yes'], 3)).data;
      proxy.done();
      assert.equal(embeddedJob.status, 'needs-input', 'even completed video cannot skip an unresolved embedded question');
      assert.match(embeddedJob.items[0].message, /embedded question/);
      assert.equal((await jobShow(embeddedJob.id, 'ykt')).status, 'needs-input');
      proxy.use([embeddedLeaf(), yktProgress(1), embeddedRead(true)]);
      assert.equal((await command('ykt', ['jobs', 'resume', embeddedJob.id])).data.job.status, 'succeeded');
      proxy.done();
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'ykt-study-write').length, yktWritesBeforeQuestion);
      record.cases.push({ name: 'ykt-embedded-missing-body-review-resume', status: 'passed', writes: 0 });

      stage = 'ykt-article';
      const article = flatten(outline.roots).find(item => item.ref.native.leafId === '504');
      assert.ok(article, 'article must come from the public outline');
      const articleRead = finish => ({
        tag: 'ykt-article-read',
        request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/leaf_info/28930736/504/', query: { classroom_id: '28930736' }, cookie: 'sessionid=sess-fixture' },
        response: { status: 200, body: { success: true, data: { leaf_type: 3, name: '合成图文讲义', finish, sku_id: 901 } } },
      });
      const articleWrite = () => ({
        tag: 'ykt-article-write',
        request: { method: 'GET', host: 'www.yuketang.cn', path: '/mooc-api/v1/lms/learn/user_article_finish/504/', query: { cid: '28930736', sid: '901' },
          headers: { xtbz: 'ykt', 'university-id': '7', 'uv-id': '7', 'classroom-id': '28930736', 'xt-agent': 'web' }, cookie: 'sessionid=sess-fixture' },
        response: { status: 200, body: { success: true } },
      });
      for (const visible of [false, true]) {
        proxy.use([articleRead(false), articleRead(false), fixture('ykt/nested-outline')[0], articleWrite(), articleRead(visible)]);
        const result = await command('ykt', ['run', '--resource', article.ref.key, '--yes'], visible ? 0 : 3);
        proxy.done();
        assert.equal(result.data.status, visible ? 'succeeded' : 'needs-input', 'article ACK alone cannot prove completion');
        assert.deepEqual(await jobShow(result.data.id, 'ykt'), result.data);
      }
      record.cases.push({ name: 'ykt-article-authoritative-completion', status: 'passed', ackWithoutCompletion: 'needs-input' });

      stage = 'ykt-article-lost-response';
      let articleSeen;
      const articleReceived = new Promise(resolveSeen => { articleSeen = resolveSeen; });
      const lostArticle = articleWrite();
      lostArticle.response.respond = async response => {
        articleSeen();
        await new Promise(resolveClose => response.once('close', resolveClose));
      };
      const beforeArticle = new Set((await jobList()).map(job => job.id));
      proxy.use([articleRead(false), articleRead(false), fixture('ykt/nested-outline')[0], lostArticle]);
      await command('ykt', ['run', '--resource', article.ref.key, '--yes'], 0, { killed: true, kill: { signal: 'SIGKILL', when: articleReceived } });
      proxy.done();
      const lostArticles = (await jobList()).filter(job => !beforeArticle.has(job.id));
      assert.equal(lostArticles.length, 1);
      const articleId = lostArticles[0].id;
      const articleWrites = proxy.evidence().requestLog.filter(item => item.tag === 'ykt-article-write').length;
      assert.equal((await command('ykt', ['jobs', 'resume', articleId], 5)).error.code, 'UNCERTAIN');
      proxy.use([articleRead(false)]);
      assert.equal((await command('ykt', ['jobs', 'reconcile', articleId], 5)).data.receipt.state, 'uncertain');
      proxy.done();
      proxy.use([articleRead(true)]);
      assert.equal((await command('ykt', ['jobs', 'reconcile', articleId])).data.receipt.state, 'confirmed');
      proxy.done();
      proxy.use([articleRead(true)]);
      assert.equal((await command('ykt', ['jobs', 'resume', articleId])).data.job.status, 'succeeded');
      proxy.done();
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'ykt-article-write').length, articleWrites, 'article reconciliation must not replay its write GET');
      record.cases.push({ name: 'ykt-article-sigkill-reconcile', status: 'passed', recoveryWrites: 0 });

      stage = 'xtx-setup';
      await run(['profile', 'add', 'xt', '--platform', 'xuetang']);
      const xtxCookieFile = resolve(directory, 'xt-session.json');
      writeFileSync(xtxCookieFile, JSON.stringify([
        { name: 'sessionid', value: 'xtx-sess-fixture', domain: '.xuetangx.com', path: '/', secure: true },
        { name: 'csrftoken', value: 'xtx-csrf-fixture', domain: '.xuetangx.com', path: '/', secure: true },
      ]));
      await command('xt', ['login', '--import', xtxCookieFile]);
      proxy.use(strict(fixture('xuetang/courses')), { cookie: 'sessionid=xtx-sess-fixture' });
      assert.equal((await command('xt', ['whoami'])).data.state, 'valid');
      proxy.done();
      proxy.use(strict(fixture('xuetang/courses')), { cookie: 'sessionid=xtx-sess-fixture' });
      const xtxCourses = (await command('xt', ['courses'])).data.items;
      proxy.done();
      proxy.use(fixture('xuetang/outline').slice(1), { cookie: 'sessionid=xtx-sess-fixture' });
      const xtxOutline = (await command('xt', ['outline', xtxCourses[0].ref.key])).data.value;
      proxy.done();
      const xtxResource = flatten(xtxOutline.roots).find(item => item.ref.native.leafId === '7');
      assert.ok(xtxResource, 'Xuetang video resource missing');

      const xtxSchedule = (rate, known = true) => ({
        tag: 'xtx-authoritative-read',
        request: {
          method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/course/schedule',
          query: { cid: '100', sign: 'SIGN-A' }, headers: { xtbz: 'xt' }, cookie: 'sessionid=xtx-sess-fixture',
        },
        response: { status: 200, body: { data: { leaf_schedules: known ? { 7: rate } : {} } } },
      });
      const xtxLeaf = (duration = 10) => ({
        tag: 'xtx-study-read',
        request: {
          method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/learn/leaf_info/100/7/',
          query: { sign: 'SIGN-A' }, headers: { xtbz: 'xt' }, cookie: 'sessionid=xtx-sess-fixture',
        },
        response: { status: 200, body: { success: true, data: { name: '学堂权威进度视频', id: 7, course_id: 5, user_id: 77, sku_id: 900, content_info: { media: { ccid: 'CCX1', duration } } } } },
      });
      const xtxNoDuration = {
        tag: 'xtx-duration-read',
        request: { method: 'GET', host: 'www.xuetangx.com', path: '/api/v1/lms/service/playurl/CCX1/', query: { appid: '10000' }, headers: { xtbz: 'xt' }, cookie: 'sessionid=xtx-sess-fixture' },
        response: { status: 200, body: { data: { sources: { quality20: ['https://www.xuetangx.com/no-duration.mp4'] } } } },
      };
      const xtxWrite = (events, cp, firstSq) => ({
        tag: 'xtx-study-write',
        request: {
          method: 'POST', host: 'www.xuetangx.com', path: '/video-log/heartbeat/',
          headers: { xtbz: 'xt', 'x-csrftoken': 'xtx-csrf-fixture', 'content-type': 'application/json;charset=utf-8' },
          cookie: 'sessionid=xtx-sess-fixture',
          bodyValidator: body => {
            const rows = body.heart_data;
            assert.ok(Array.isArray(rows), 'Xuetang heart_data missing');
            assert.deepEqual(rows.map(row => row.et), events, 'Xuetang heartbeat event order mismatch');
            rows.forEach((row, index) => {
              assert.equal(row.cp, cp, `Xuetang heartbeat position mismatch (expected ${cp}, actual ${String(row.cp)})`);
              assert.equal(row.sq, firstSq + index, 'Xuetang heartbeat sequence mismatch');
              assert.equal(row.lob, 'xt', 'Xuetang heartbeat lob mismatch');
              assert.equal(String(row.c), '5', 'Xuetang heartbeat course mismatch');
              assert.equal(String(row.v), '7', 'Xuetang heartbeat leaf mismatch');
              assert.equal(row.classroomid, '100', 'Xuetang heartbeat classroom mismatch');
              assert.equal(row.cc, 'CCX1', 'Xuetang heartbeat cc mismatch');
              assert.equal(row.d, 10, 'Xuetang heartbeat duration mismatch');
              assert.equal(row.skuid, '900', 'Xuetang heartbeat sku mismatch');
            });
          },
        },
        response: { status: 200, body: {} },
      });

      stage = 'xtx-unknown-duration';
      const beforeXtxUnknown = new Set((await jobList()).map(job => job.id));
      proxy.use([xtxSchedule(0, false), xtxLeaf(0), xtxLeaf(0), xtxNoDuration]);
      const xtxUnknown = await command('xt', ['run', '--resource', xtxResource.ref.key, '--speed', '2', '--target', '0.5', '--dry-run', '--yes'], 3);
      assert.equal(xtxUnknown.error.code, 'INTERACTION_REQUIRED');
      assert.equal(xtxUnknown.ok, false);
      proxy.done();
      const xtxUnknownJobs = (await jobList()).filter(job => !beforeXtxUnknown.has(job.id));
      assert.equal(xtxUnknownJobs.length, values.fault === 'unknown-duration-success' ? 1 : 0, 'unknown duration must not create a study job');
      record.cases.push({ name: 'xtx-unknown-duration', status: 'passed', jobsCreated: xtxUnknownJobs.length });

      stage = 'xtx-delayed-authoritative-success';
      proxy.use([
        xtxSchedule(0), xtxLeaf(),
        xtxSchedule(0), xtxLeaf(), xtxWrite(['loadstart', 'loadeddata', 'play'], 0, 1),
        xtxSchedule(0), xtxLeaf(), xtxWrite(['ratechange'], 0, 4),
        xtxSchedule(0), xtxLeaf(), xtxWrite(['heartbeat'], 5, 5),
        xtxSchedule(0.5),
      ]);
      const xtxSuccess = await command('xt', ['run', '--resource', xtxResource.ref.key, '--speed', '2', '--target', '0.5', '--yes'], 0, { timeout: 30_000 });
      proxy.done();
      assert.equal(xtxSuccess.data.status, 'succeeded');
      assert.equal(xtxSuccess.data.items[0].state, 'succeeded');
      assert.deepEqual(await jobShow(xtxSuccess.data.id, 'xt'), xtxSuccess.data, 'new process Xuetang job readback differs');
      const xtxWrites = proxy.evidence().requestLog.filter(item => item.tag === 'xtx-study-write').length;
      assert.equal(xtxWrites, 3, 'Xuetang must send start/rate/heartbeat once, then wait for authoritative schedule');
      record.cases.push({ name: 'xtx-delayed-authoritative-schedule', status: 'passed', jobId: xtxSuccess.data.id, writes: xtxWrites });


      stage = 'xtx-embedded-review';
      const xtxEmbeddedLeaf = () => {
        const item = xtxLeaf();
        item.response.body.data.content_info.media.exercise_id = 888;
        return item;
      };
      const xtxBeforeQuestion = proxy.evidence().requestLog.filter(item => item.tag === 'xtx-study-write').length;
      proxy.use([xtxSchedule(0), xtxEmbeddedLeaf(), xtxSchedule(0), xtxEmbeddedLeaf()]);
      const xtxEmbeddedJob = (await command('xt', ['run', '--resource', xtxResource.ref.key, '--yes'], 3)).data;
      proxy.done();
      assert.equal(xtxEmbeddedJob.status, 'needs-input');
      assert.match(xtxEmbeddedJob.items[0].message, /embedded question requires review/);
      assert.equal((await jobShow(xtxEmbeddedJob.id, 'xt')).status, 'needs-input');
      await command('xt', ['jobs', 'cancel', xtxEmbeddedJob.id, '--yes']);
      assert.equal((await jobShow(xtxEmbeddedJob.id, 'xt')).status, 'canceled');
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'xtx-study-write').length, xtxBeforeQuestion);
      record.cases.push({ name: 'xtx-embedded-review-cancel', status: 'passed', writes: 0 });

      stage = 'xtx-sigkill-reconcile';
      let xtxHeartbeatSeen;
      const xtxHeartbeatReceived = new Promise(resolve => { xtxHeartbeatSeen = resolve; });
      const delayedXtxHeartbeat = xtxWrite(['heartbeat'], 8, 5);
      delayedXtxHeartbeat.response.respond = async response => {
        xtxHeartbeatSeen();
        await new Promise(resolveClose => response.once('close', resolveClose));
      };
      proxy.use([
        xtxSchedule(0.1), xtxLeaf(),
        xtxSchedule(0.1), xtxLeaf(), xtxWrite(['loadstart', 'loadeddata', 'play'], 1, 1),
        xtxSchedule(0.1), xtxLeaf(), xtxWrite(['ratechange'], 1, 4),
        xtxSchedule(0.1), xtxLeaf(), delayedXtxHeartbeat,
      ]);
      const beforeXtxKill = new Set((await jobList()).map(job => job.id));
      await command('xt', ['run', '--resource', xtxResource.ref.key, '--speed', '2', '--target', '0.8', '--yes'], 0, {
        killed: true,
        kill: { signal: 'SIGKILL', when: xtxHeartbeatReceived },
        timeout: 30_000,
      });
      proxy.done();
      const xtxInterrupted = (await jobList()).filter(job => !beforeXtxKill.has(job.id));
      assert.equal(xtxInterrupted.length, 1, 'forced Xuetang process must retain one job');
      const xtxInterruptedId = xtxInterrupted[0].id;
      assert.equal(xtxInterrupted[0].status, 'running');
      const xtxMeta = records(home, 'job-meta:' + xtxInterruptedId)[0].value;
      assert.equal(xtxMeta.pendingOperationId, 'xtx-heartbeat:' + xtxInterruptedId + ':' + xtxResource.ref.key + ':5', 'forced Xuetang operation id');
      assert.equal(existsSync(resolve(home, 'learning.lock')), true, 'forced Xuetang exit must leave the stale lock');
      const xtxWritesBeforeRecovery = proxy.evidence().requestLog.filter(item => item.tag === 'xtx-study-write').length;
      record.interruptions.push({ platform: 'xtx', signal: 'SIGKILL', status: 'running', pendingOperation: true, staleLock: true });
      const xtxRefused = await command('xt', ['jobs', 'resume', xtxInterruptedId], 5);
      assert.equal(xtxRefused.error.code, 'UNCERTAIN');
      proxy.use([xtxSchedule(0.1)]);
      const xtxNoAdvance = await command('xt', ['jobs', 'reconcile', xtxInterruptedId], 5);
      proxy.done();
      assert.equal(xtxNoAdvance.data.receipt.state, 'uncertain');
      assert.equal((await jobShow(xtxInterruptedId, 'xt')).status, 'uncertain');
      assert.equal((await command('xt', ['jobs', 'resume', xtxInterruptedId], 5)).error.code, 'UNCERTAIN');
      record.cases.push({ name: 'xtx-no-advance-no-replay', status: 'passed' });
      const xtxReconcileRate = values.fault === 'reconcile-no-advance' ? 0.1 : 0.9;
      proxy.use([xtxSchedule(xtxReconcileRate)]);
      const xtxReconciled = await command('xt', ['jobs', 'reconcile', xtxInterruptedId], values.fault === 'reconcile-no-advance' ? 5 : 0);
      assert.equal(xtxReconciled.data.receipt.state, 'confirmed', 'advanced schedule must confirm the pending heartbeat');
      assert.equal(xtxReconciled.data.job.status, 'paused');
      proxy.done();
      assert.equal(existsSync(resolve(home, 'learning.lock')), false, 'Xuetang reconciliation must retire the stale lock');
      proxy.use([xtxSchedule(0.9)]);
      const xtxResumed = await command('xt', ['jobs', 'resume', xtxInterruptedId]);
      proxy.done();
      assert.equal(xtxResumed.data.job.status, 'succeeded');
      assert.deepEqual(await jobShow(xtxInterruptedId, 'xt'), xtxResumed.data.job);
      const xtxRecoveryWrites = proxy.evidence().requestLog.filter(item => item.tag === 'xtx-study-write').length - xtxWritesBeforeRecovery;
      assert.equal(xtxRecoveryWrites, 0, 'Xuetang recovery must not resend the lost heartbeat');
      record.cases.push({ name: 'xtx-sigkill-reconcile-resume', status: 'passed', recoveryWrites: xtxRecoveryWrites, staleLockRetired: true });

      stage = 'ykt-sigkill-reconcile';
      let heartbeatSeen;
      const heartbeatReceived = new Promise(resolve => { heartbeatSeen = resolve; });
      const delayedHeartbeat = yktHeartbeat(8);
      delayedHeartbeat.response.respond = async response => {
        heartbeatSeen();
        await new Promise(resolveClose => response.once('close', resolveClose));
      };
      proxy.use([yktLeaf(), yktProgress(0.1), yktLeaf(), yktProgress(0.1), delayedHeartbeat]);
      const beforeKill = new Set((await jobList()).map(job => job.id));
      await command('ykt', ['run', '--resource', resource.ref.key, '--speed', '5', '--target', '0.8', '--yes'], 0, {
        killed: true,
        kill: { signal: 'SIGKILL', when: heartbeatReceived },
        timeout: 30_000,
      });
      proxy.done();
      const interruptedJobs = (await jobList()).filter(job => !beforeKill.has(job.id));
      assert.equal(interruptedJobs.length, 1, 'forced study process must retain exactly one new job');
      const interruptedId = interruptedJobs[0].id;
      assert.equal(interruptedJobs[0].status, 'running', 'forced study process status');
      const interruptedMeta = records(home, 'job-meta:' + interruptedId)[0].value;
      assert.equal(interruptedMeta.pendingOperationId, 'heartbeat:' + interruptedId + ':' + resource.ref.key + ':1', 'forced heartbeat operation id');
      assert.equal(existsSync(resolve(home, 'learning.lock')), true, 'forced exit must leave the stale lock for safe recovery');
      const writesBeforeRecovery = proxy.evidence().requestLog.filter(item => item.tag === 'ykt-study-write').length;
      record.interruptions.push({ platform: 'ykt', signal: 'SIGKILL', status: 'running', pendingOperation: true, staleLock: true });

      const refused = await command('ykt', ['jobs', 'resume', interruptedId], 5);
      assert.equal(refused.error.code, 'UNCERTAIN');
      assert.equal(jobRecord(home, interruptedId).status, 'running', 'unsafe resume must not mutate the job');
      proxy.use([yktLeaf(), yktProgress(0.1)]);
      const yktNoAdvance = await command('ykt', ['jobs', 'reconcile', interruptedId], 5);
      proxy.done();
      assert.equal(yktNoAdvance.data.receipt.state, 'uncertain');
      assert.equal((await jobShow(interruptedId, 'ykt')).status, 'uncertain');
      assert.equal((await command('ykt', ['jobs', 'resume', interruptedId], 5)).error.code, 'UNCERTAIN');
      record.cases.push({ name: 'ykt-no-advance-no-replay', status: 'passed' });
      const reconcileRate = 0.9;
      proxy.use([yktLeaf(), yktProgress(reconcileRate)]);
      {
        const reconciled = await command('ykt', ['jobs', 'reconcile', interruptedId]);
        record.reconciliationReadback = { receipt: reconciled.data.receipt.state, jobStatus: reconciled.data.job.status, completed: reconciled.data.job.completed };
        assert.equal(reconciled.data.receipt.state, 'confirmed');
        assert.equal(reconciled.data.job.status, 'paused');
        proxy.done();
        assert.equal(existsSync(resolve(home, 'learning.lock')), false, 'stale lock must be safely retired');
        proxy.use([yktLeaf(), yktProgress(0.9)]);
        const resumed = await command('ykt', ['jobs', 'resume', interruptedId]);
        proxy.done();
        record.resumeReadback = { status: resumed.data.job.status, completed: resumed.data.job.completed, items: resumed.data.job.items.map(item => ({ key: item.key, state: item.state, message: item.message })) };
        assert.equal(resumed.data.job.status, 'succeeded');
        assert.deepEqual(await jobShow(interruptedId, 'ykt'), resumed.data.job);
        const recoveryWrites = proxy.evidence().requestLog.filter(item => item.tag === 'ykt-study-write').length - writesBeforeRecovery;
        assert.equal(recoveryWrites, 0, 'recovery must not duplicate the lost write');
        record.cases.push({ name: 'ykt-sigkill-reconcile-resume', status: 'passed', recoveryWrites, staleLockRetired: true });
      }

      stage = 'zhs-setup';
      await run(['profile', 'add', 'zhs', '--platform', 'zhs']);
      const zhsLogin = fixture('zhs/qr-login');
      zhsLogin[2].response.headers['set-cookie'] = ['CASLOGC=u1; Path=/; Domain=zhihuishu.com'];
      proxy.use(zhsLogin);
      await command('zhs', ['login', '--variant', 'native', '--qr-file', resolve(directory, 'native.png')]);
      proxy.done();
      assert.equal(existsSync(resolve(directory, 'native.png')), false, 'native QR file must be removed');
      const zhsIdentity = {
        tag: 'zhs-identity-read',
        request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/login/getLoginUserInfo', query: {} },
        response: { status: 200, body: { code: 0, data: { uuid: 'u1', name: 'Synthetic study reader' } } },
      };
      proxy.use([zhsIdentity]);
      assert.equal((await command('zhs', ['whoami'])).data.state, 'valid');
      proxy.done();
      proxy.use(['zhs/share-list', 'zhs/hike-list']);
      const zhsCourses = (await command('zhs', ['courses'])).data.items;
      proxy.done();
      const zhsShareCourse = zhsCourses.find(item => item.ref.native.kind === 'zhs-share');
      assert.ok(zhsShareCourse, 'ZHS share course missing');
      proxy.use(fixture('zhs/share-outline'));
      const zhsOutline = (await command('zhs', ['outline', zhsShareCourse.ref.key])).data.value;
      proxy.done();
      const zhsResource = flatten(zhsOutline.roots).find(item => item.ref.native.kind === 'zhs-share' && item.ref.native.videoId === 'V1');
      assert.ok(zhsResource, 'ZHS share video resource missing');

      const zhsHeaders = { origin: 'https://studyvideoh5.zhihuishu.com', referer: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1', 'content-type': 'application/x-www-form-urlencoded' };
      const zhsPost = (tag, path, expected, body) => ({
        tag,
        request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1' + path, headers: zhsHeaders, bodyValidator: zhsSealed(expected) },
        response: { status: 200, body },
      });
      const zhsReadState = (seconds, { duration = 10, statePresent = true } = {}) => [
        {
          tag: 'zhs-session-read', request: { method: 'GET', host: 'studyservice-api.zhihuishu.com', path: '/login/gologin', query: { fromurl: 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=R1' } },
          response: { status: 200, body: {} },
        },
        zhsPost('zhs-course-read', '/learning/queryCourse', { recruitAndCourseId: 'R1' }, { code: 0, data: { recruitId: 9, courseInfo: { courseId: 44 } } }),
        zhsPost('zhs-video-read', '/learning/videolist', { recruitAndCourseId: 'R1' }, { code: 0, data: { courseId: 55, videoChapterDtos: [{ id: 1, name: '第一章', videoLessons: [{ id: 10, name: '智慧树权威进度视频', videoId: 'V1', videoSec: duration }] }] } }),
        zhsPost('zhs-watch-read', '/learning/queryStuyInfo', { lessonIds: [10], lessonVideoIds: [], recruitId: 9 }, { code: 0, data: statePresent ? { lv: {}, lesson: { 10: { watchState: seconds >= duration ? 1 : 0, studyTotalTime: seconds } } } : {} }),
      ];
      const zhsPopup = points => zhsPost('zhs-popup-read', '/popupAnswer/loadVideoPointerInfo', {
        lessonId: '10', lessonVideoId: '0', recruitId: '9', courseId: '55',
      }, { code: 0, data: { questionPoint: points } });
      const zhsPrelearning = () => zhsPost('zhs-prelearning-write', '/learning/prelearningNote', {
        ccCourseId: '55', chapterId: '1', isApply: 1, lessonId: '10', lessonVideoId: '0', recruitId: '9', videoId: 'V1',
      }, { code: 0, data: { studiedLessonDto: { id: 77 } } });
      const zhsSave = () => ({
        tag: 'zhs-save-write',
        request: { method: 'POST', host: 'studyservice-api.zhihuishu.com', path: '/gateway/t/v1/learning/saveDatabaseIntervalTimeV2', headers: zhsHeaders,
          bodyValidator: body => {
            const payload = unsealZhsForm(body);
            const { dateFormate, ...fields } = payload;
            assert.ok(Number.isSafeInteger(dateFormate), 'decrypted ZHS save dateFormate is invalid');
            assert.deepEqual(Object.keys(fields).sort(), ['courseId', 'ewssw', 'sdsew', 'zwsds'], 'ZHS save fields mismatch');
            assert.equal(fields.ewssw, '0,1,2', 'ZHS save watch point mismatch');
            assert.equal(fields.zwsds, 'Nzc=', 'ZHS save prelearning token mismatch');
            assert.equal(fields.courseId, '44', 'ZHS save course mismatch');
            assert.deepEqual(reverseZhsEv(fields.sdsew).split(';'), ['9', '10', '0', 'V1', '1', '0', '1', '1', '0:00:01', 'u1zhs'], 'ZHS encrypted ev field order mismatch');
          } },
        response: { status: 200, body: { code: 0, data: {} } },
      });

      stage = 'zhs-unknown-state';
      const beforeZhsUnknown = new Set((await jobList()).map(job => job.id));
      proxy.use(zhsReadState(0, { statePresent: false }));
      const zhsUnknown = await command('zhs', ['run', '--resource', zhsResource.ref.key, '--speed', '1', '--target', '0.5', '--dry-run', '--yes'], 1);
      assert.equal(zhsUnknown.error.code, 'PROTOCOL');
      proxy.done();
      const zhsUnknownJobs = (await jobList()).filter(job => !beforeZhsUnknown.has(job.id));
      assert.equal(zhsUnknownJobs.length, 0, 'missing ZHS watch state must not create a study job');
      record.cases.push({ name: 'zhs-unknown-watch-state', status: 'passed', jobsCreated: zhsUnknownJobs.length });

      stage = 'zhs-popup-missing-answer';
      const beforeZhsPopup = new Set((await jobList()).map(job => job.id));
      proxy.use([...zhsReadState(0), ...zhsReadState(0), zhsPopup([{ timeSec: 1 }])]);
      const zhsPopupJob = await command('zhs', ['run', '--resource', zhsResource.ref.key, '--speed', '1', '--target', '0.5', '--yes'], 3, { timeout: 30_000 });
      proxy.done();
      assert.equal(zhsPopupJob.data.status, 'needs-input');
      assert.match(zhsPopupJob.data.items[0].message, /popup question requires a reviewed answer/);
      const popupJobs = (await jobList()).filter(job => !beforeZhsPopup.has(job.id));
      assert.equal(popupJobs.length, 1, 'popup pause must retain one job');
      assert.equal(popupJobs[0].status, 'needs-input');
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'zhs-prelearning-write').length, values.fault === 'popup-write' ? 1 : 0, 'unreviewed popup must not open a prelearning note');
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'zhs-save-write').length, 0, 'unreviewed popup must not save progress');
      await command('zhs', ['jobs', 'cancel', popupJobs[0].id, '--yes']);
      assert.equal((await jobShow(popupJobs[0].id, 'zhs')).status, 'canceled');
      record.cases.push({ name: 'zhs-popup-missing-answer', status: 'passed', prelearningWrites: 0, saveWrites: 0 });

      stage = 'zhs-authoritative-success';
      proxy.use([...zhsReadState(0), ...zhsReadState(0), zhsPopup([]), zhsPrelearning(), ...zhsReadState(0), zhsSave(), ...zhsReadState(5)]);
      const zhsSuccess = await command('zhs', ['run', '--resource', zhsResource.ref.key, '--speed', '1', '--target', '0.1', '--yes'], 0, { timeout: 30_000 });
      proxy.done();
      assert.equal(zhsSuccess.data.status, 'succeeded');
      assert.deepEqual(await jobShow(zhsSuccess.data.id, 'zhs'), zhsSuccess.data, 'new process ZHS job readback differs');
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'zhs-prelearning-write').length, 1, 'ZHS must open exactly one prelearning note');
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'zhs-save-write').length, 1, 'ZHS must save exactly once before authoritative readback');
      record.cases.push({ name: 'zhs-share-encrypted-save', status: 'passed', jobId: zhsSuccess.data.id, prelearningWrites: 1, saveWrites: 1 });

      stage = 'zhs-sigkill-reconcile';
      let zhsSaveSeen;
      const zhsSaveReceived = new Promise(resolve => { zhsSaveSeen = resolve; });
      const delayedZhsSave = zhsSave();
      delayedZhsSave.response.respond = async response => {
        zhsSaveSeen();
        await new Promise(resolveClose => response.once('close', resolveClose));
      };
      proxy.use([...zhsReadState(0), ...zhsReadState(0), zhsPopup([]), zhsPrelearning(), ...zhsReadState(0), delayedZhsSave]);
      const beforeZhsKill = new Set((await jobList()).map(job => job.id));
      await command('zhs', ['run', '--resource', zhsResource.ref.key, '--speed', '1', '--target', '0.1', '--yes'], 0, {
        killed: true,
        kill: { signal: 'SIGKILL', when: zhsSaveReceived },
        timeout: 30_000,
      });
      proxy.done();
      const zhsInterrupted = (await jobList()).filter(job => !beforeZhsKill.has(job.id));
      assert.equal(zhsInterrupted.length, 1, 'forced ZHS process must retain one job');
      const zhsInterruptedId = zhsInterrupted[0].id;
      assert.equal(zhsInterrupted[0].status, 'running');
      const zhsMeta = records(home, 'job-meta:' + zhsInterruptedId)[0].value;
      assert.equal(zhsMeta.pendingOperationId, 'share-save:' + zhsInterruptedId + ':' + zhsResource.ref.key + ':1', 'forced ZHS save operation id');
      assert.equal(existsSync(resolve(home, 'learning.lock')), true, 'forced ZHS exit must leave the stale lock');
      const zhsSavesBeforeRecovery = proxy.evidence().requestLog.filter(item => item.tag === 'zhs-save-write').length;
      record.interruptions.push({ platform: 'zhs-share', signal: 'SIGKILL', status: 'running', pendingOperation: true, staleLock: true });
      const zhsRefused = await command('zhs', ['jobs', 'resume', zhsInterruptedId], 5);
      assert.equal(zhsRefused.error.code, 'UNCERTAIN');
      proxy.use(zhsReadState(0));
      const zhsNoAdvance = await command('zhs', ['jobs', 'reconcile', zhsInterruptedId], 5);
      proxy.done();
      assert.equal(zhsNoAdvance.data.receipt.state, 'uncertain');
      assert.equal((await jobShow(zhsInterruptedId, 'zhs')).status, 'uncertain');
      assert.equal((await command('zhs', ['jobs', 'resume', zhsInterruptedId], 5)).error.code, 'UNCERTAIN');
      record.cases.push({ name: 'zhs-no-advance-no-replay', status: 'passed' });
      const zhsReconcileSeconds = 5;
      proxy.use(zhsReadState(zhsReconcileSeconds));
      const zhsReconciled = await command('zhs', ['jobs', 'reconcile', zhsInterruptedId]);
      assert.equal(zhsReconciled.data.receipt.state, 'confirmed');
      assert.equal(zhsReconciled.data.job.status, 'paused');
      proxy.done();
      assert.equal(existsSync(resolve(home, 'learning.lock')), false, 'ZHS reconciliation must retire the stale lock');
      proxy.use(zhsReadState(5));
      const zhsResumed = await command('zhs', ['jobs', 'resume', zhsInterruptedId]);
      proxy.done();
      assert.equal(zhsResumed.data.job.status, 'succeeded');
      assert.deepEqual(await jobShow(zhsInterruptedId, 'zhs'), zhsResumed.data.job);
      const zhsRecoverySaves = proxy.evidence().requestLog.filter(item => item.tag === 'zhs-save-write').length - zhsSavesBeforeRecovery;
      assert.equal(zhsRecoverySaves, 0, 'ZHS recovery must not resend the lost save');
      record.cases.push({ name: 'zhs-sigkill-reconcile-resume', status: 'passed', recoverySaves: zhsRecoverySaves, staleLockRetired: true });



      stage = 'zhs-prelearning-lost-response';
      let noteSeen;
      const noteReceived = new Promise(resolveSeen => { noteSeen = resolveSeen; });
      const lostNote = zhsPrelearning();
      lostNote.response.respond = async response => {
        noteSeen();
        await new Promise(resolveClose => response.once('close', resolveClose));
      };
      const beforeNote = new Set((await jobList()).map(job => job.id));
      proxy.use([...zhsReadState(0), ...zhsReadState(0), zhsPopup([]), lostNote]);
      await command('zhs', ['run', '--resource', zhsResource.ref.key, '--speed', '1', '--target', '0.1', '--yes'], 0, {
        killed: true, kill: { signal: 'SIGKILL', when: noteReceived },
      });
      proxy.done();
      const notes = (await jobList()).filter(job => !beforeNote.has(job.id));
      assert.equal(notes.length, 1);
      const noteId = notes[0].id;
      const noteWrites = proxy.evidence().requestLog.filter(item => item.tag === 'zhs-prelearning-write').length;
      const unreconciledNote = await command('zhs', ['jobs', 'reconcile', noteId], 5);
      assert.equal(unreconciledNote.data.receipt.state, 'uncertain');
      assert.match(unreconciledNote.data.receipt.message, /cannot be proven/);
      assert.equal((await command('zhs', ['jobs', 'resume', noteId], 5)).error.code, 'UNCERTAIN');
      assert.equal((await jobShow(noteId, 'zhs')).status, 'uncertain');
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'zhs-prelearning-write').length, noteWrites);
      record.cases.push({ name: 'zhs-prelearning-loss-no-replay', status: 'passed', receipt: 'uncertain', recoveryWrites: 0 });

      stage = 'zhs-hike-setup';
      const hikeCourse = zhsCourses.find(item => item.ref.native.kind === 'zhs-hike');
      assert.ok(hikeCourse, 'hike course must come from the public catalog');
      const hikeTree = (seconds, duration = 10) => ({
        tag: 'hike-authoritative-read',
        request: { method: 'GET', host: 'studyresources.zhihuishu.com', path: '/studyResources/stuResouce/queryResourceMenuTree',
          query: { courseId: '77' }, queryValidator: query => {
            assert.deepEqual([...query.keys()].sort(), ['_', 'courseId']);
            assert.ok(Number.isSafeInteger(Number(query.get('_'))));
          } },
        response: { status: 200, body: { code: 0, rt: [{ id: 'f2', name: '合成校内视频', dataType: 3, studyTime: seconds, totalTime: duration, childList: [] }] } },
      });
      proxy.use([hikeTree(0)]);
      const hikeOutline = (await command('zhs', ['outline', hikeCourse.ref.key])).data.value;
      proxy.done();
      const hikeResource = flatten(hikeOutline.roots).find(item => item.ref.native.fileId === 'f2');
      assert.ok(hikeResource, 'hike resource must come from the public outline');
      const hikeSave = rt => ({
        tag: 'hike-save-write',
        request: { method: 'GET', host: 'hike-teaching.zhihuishu.com', path: '/stuStudy/saveStuStudyRecord', queryValidator: query => {
          assert.deepEqual([...query.keys()].sort(), ['_', 'courseId', 'endDate', 'endWatchTime', 'fileId', 'signature', 'startDate', 'startWatchTime', 'studyTotalTime', 'uuid'].sort());
          assert.equal(query.get('uuid'), 'u1');
          assert.equal(query.get('courseId'), '77');
          assert.equal(query.get('fileId'), 'f2');
          assert.equal(query.get('startWatchTime'), '0');
          assert.equal(query.get('endWatchTime'), '1');
          assert.equal(query.get('studyTotalTime'), '1');
          const start = Number(query.get('startDate')), end = Number(query.get('endDate'));
          assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end - start >= 1000 && end <= Date.now() + 100);
          assert.equal(query.get('_'), String(end));
          // External wire oracle: fixed documented field order, Node crypto, no SDK import.
          const signed = 'o6xpt3b#Qy$Z' + 'u1' + '77' + 'f2' + '1' + start + end + '1' + '0' + 'u1';
          assert.equal(query.get('signature'), createHash('md5').update(signed).digest('hex'), 'hike signature wire contract');
        } },
        response: { status: 200, body: { status: 200, rt } },
      });
      const hikeArgs = ['run', '--resource', hikeResource.ref.key, '--speed', '1', '--target', '0.1', '--yes'];
      const beforeHikeUnknown = (await jobList()).map(job => job.id);
      proxy.use([hikeTree(0, 0)]);
      assert.equal((await command('zhs', [...hikeArgs, '--dry-run'], 3)).error.code, 'INTERACTION_REQUIRED');
      proxy.done();
      assert.deepEqual((await jobList()).map(job => job.id), beforeHikeUnknown);
      proxy.use([hikeTree(0), hikeTree(0), hikeTree(0), hikeSave(1)]);
      const hikeSuccess = (await command('zhs', hikeArgs)).data;
      proxy.done();
      assert.equal(hikeSuccess.status, 'succeeded');
      assert.match(hikeSuccess.items[0].message, /target reached; server completion is not claimed/);
      assert.deepEqual(await jobShow(hikeSuccess.id, 'zhs'), hikeSuccess);
      proxy.use([hikeTree(1)]);
      await command('zhs', [...hikeArgs, '--dry-run']);
      proxy.done();
      record.cases.push({ name: 'hike-signed-save-authoritative-rt', status: 'passed', unknownDuration: 'INTERACTION_REQUIRED', serverCompleted: false });

      stage = 'hike-stalled-rt';
      proxy.use([hikeTree(0), hikeTree(0), ...Array.from({ length: 3 }, () => [hikeTree(0), hikeSave(0)]).flat()]);
      const stalledHike = (await command('zhs', hikeArgs, 3)).data;
      proxy.done();
      assert.equal(stalledHike.status, 'needs-input');
      assert.match(stalledHike.items[0].message, /rt stalled three times/);
      assert.equal((await jobShow(stalledHike.id, 'zhs')).status, 'needs-input');
      record.cases.push({ name: 'hike-stalled-authoritative-rt', status: 'passed', writes: 3, state: 'needs-input' });

      stage = 'hike-sigkill-reconcile';
      let hikeSeen;
      const hikeReceived = new Promise(resolveSeen => { hikeSeen = resolveSeen; });
      const lostHike = hikeSave(1);
      lostHike.response.respond = async response => {
        hikeSeen();
        await new Promise(resolveClose => response.once('close', resolveClose));
      };
      const beforeHikeKill = new Set((await jobList()).map(job => job.id));
      proxy.use([hikeTree(0), hikeTree(0), hikeTree(0), lostHike]);
      await command('zhs', hikeArgs, 0, { killed: true, kill: { signal: 'SIGKILL', when: hikeReceived } });
      proxy.done();
      const hikeKilled = (await jobList()).filter(job => !beforeHikeKill.has(job.id));
      assert.equal(hikeKilled.length, 1);
      const hikeId = hikeKilled[0].id;
      assert.equal(hikeKilled[0].status, 'running');
      assert.equal(existsSync(resolve(home, 'learning.lock')), true);
      const hikeWrites = proxy.evidence().requestLog.filter(item => item.tag === 'hike-save-write').length;
      assert.equal((await command('zhs', ['jobs', 'resume', hikeId], 5)).error.code, 'UNCERTAIN');
      proxy.use([hikeTree(0)]);
      assert.equal((await command('zhs', ['jobs', 'reconcile', hikeId], 5)).data.receipt.state, 'uncertain');
      proxy.done();
      assert.equal((await command('zhs', ['jobs', 'resume', hikeId], 5)).error.code, 'UNCERTAIN');
      proxy.use([hikeTree(1)]);
      assert.equal((await command('zhs', ['jobs', 'reconcile', hikeId])).data.receipt.state, 'confirmed');
      proxy.done();
      proxy.use([hikeTree(1)]);
      assert.equal((await command('zhs', ['jobs', 'resume', hikeId])).data.job.status, 'succeeded');
      proxy.done();
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'hike-save-write').length, hikeWrites);
      assert.equal(existsSync(resolve(home, 'learning.lock')), false);
      record.cases.push({ name: 'hike-sigkill-reconcile-resume', status: 'passed', recoveryWrites: 0, staleLockRetired: true });


      stage = 'study-graceful-pause-resume';
      if (process.platform !== 'win32') {
        const pauses = [
          { profile: 'ykt', resource, signal: 'SIGINT', speed: '5', target: '0.5',
            initial: [yktLeaf(), yktProgress(0), yktLeaf(), yktProgress(0), yktHeartbeat(5), yktLeaf(), yktProgress(0)], resumed: [yktLeaf(), yktProgress(0.9)] },
          { profile: 'xt', resource: xtxResource, signal: 'SIGTERM', speed: '2', target: '0.5',
            initial: [xtxSchedule(0), xtxLeaf(), xtxSchedule(0), xtxLeaf(), xtxWrite(['loadstart', 'loadeddata', 'play'], 0, 1)], resumed: [xtxSchedule(0.9)] },
          { profile: 'zhs', resource: zhsResource, signal: 'SIGINT', speed: '1', target: '0.1',
            initial: [...zhsReadState(0), ...zhsReadState(0), zhsPopup([]), zhsPrelearning()], resumed: zhsReadState(5) },
          { profile: 'zhs', resource: hikeResource, signal: 'SIGTERM', speed: '1', target: '0.1',
            initial: [hikeTree(0), hikeTree(0)], resumed: [hikeTree(1)] },
        ];
        for (const scenario of pauses) {
          const before = new Set((await jobList()).map(job => job.id));
          let id;
          const beforeRequests = proxy.evidence().requests;
          const waiting = until(() => proxy.evidence().requests > beforeRequests, 'study transport ready').then(() => until(() => {
            id = records(home, 'job:').find(row => !before.has(row.value.id) && row.value.status === 'waiting')?.value.id;
            return id;
          }, 'study ready for graceful pause'));
          proxy.use(scenario.initial);
          const result = await command(scenario.profile, ['run', '--resource', scenario.resource.ref.key, '--speed', scenario.speed, '--target', scenario.target, '--yes'], 3, {
            kill: { signal: scenario.signal, when: waiting },
          });
          proxy.done();
          assert.equal(result.error.code, 'CANCELED');
          const paused = await jobShow(id, scenario.profile);
          assert.equal(paused.status, 'paused');
          assert.equal(records(home, 'job-meta:' + id)[0].value.pendingOperationId, null, 'safe pause cannot invent a pending write');
          assert.equal(existsSync(resolve(home, 'learning.lock')), false);
          const writes = proxy.evidence().requestLog.filter(item => /-write$/.test(item.tag ?? '')).length;
          proxy.use(scenario.resumed);
          assert.equal((await command(scenario.profile, ['jobs', 'resume', id])).data.job.status, 'succeeded');
          proxy.done();
          assert.equal((await jobShow(id, scenario.profile)).status, 'succeeded');
          assert.equal(proxy.evidence().requestLog.filter(item => /-write$/.test(item.tag ?? '')).length, writes, 'resume after credited progress must not replay work');
          record.cases.push({ name: scenario.resource === hikeResource ? 'hike-pause-resume' : scenario.profile + '-pause-resume', status: 'passed', signal: scenario.signal });
        }
      } else record.signalBoundary = 'not-run: Windows kill is not console Ctrl+C/SIGTERM; forced recovery is exercised separately';

      stage = 'jobs-profile-isolation';
      const owned = await jobShow(successJob.id, 'ykt');
      assert.equal((await command('xt', ['jobs', 'show', successJob.id], 3)).error.code, 'FORBIDDEN');
      assert.equal((await command('xt', ['jobs', 'resume', successJob.id], 3)).error.code, 'FORBIDDEN');
      assert.deepEqual(await jobShow(successJob.id, 'ykt'), owned, 'wrong-profile access cannot mutate a job');
      record.cases.push({ name: 'jobs-profile-isolation', status: 'passed' });

      stage = 'ykt-live-gap';
      const checkin = {
        tag: 'ykt-live-checkin',
        request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' }, cookie: 'sessionid=sess-fixture' },
        response: { status: 200, headers: { 'set-auth': 'fixture-jwt' }, body: { code: 0, data: { lessonToken: 'fixture-lesson-token' } } },
      };
      const liveSocket = respond => ({
        kind: 'websocket',
        tag: 'ykt-live-wss',
        request: { host: 'www.yuketang.cn', path: '/wsapp/' },
        message: { op: 'hello', userid: '424242', role: 'student', auth: 'fixture-lesson-token', lessonid: '9000' },
        respond,
      });
      const beforeLive = new Set((await jobList()).map(job => job.id));
      proxy.use([checkin, liveSocket(async socket => {
        for (let duplicate = 0; duplicate < 2; duplicate++) {
          socket.send(JSON.stringify({ op: 'unlockproblem', problem: { prob: 11, limit: 30 }, msgid: 2 }));
          await delay(25);
        }
        await delay(50);
        socket.close();
      }), liveSocket(async socket => {
        socket.send(JSON.stringify({ op: 'lessonfinished' }));
      })]);
      const live = await command('ykt', ['live', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--yes'], 0, { timeout: 30_000 });
      proxy.done();
      const liveJobs = (await jobList()).filter(job => !beforeLive.has(job.id));
      assert.equal(liveJobs.length, 1);
      const liveId = liveJobs[0].id;
      assert.equal(live.data.status, 'succeeded');
      const events = records(home, 'job-events:' + liveId)[0].value;
      record.liveReadback = events.filter(event => event.type === 'question').map(event => ({ phaseId: event.phaseId, questionId: event.question.id, closesAtMs: event.closesAtMs }));
      assert.equal(record.liveReadback.length, 1, 'duplicate live mailbox frame must not duplicate a question');
      const question = events.find(event => event.type === 'question');
      const gap = events.filter(event => event.type === 'gap');
      assert.ok(question, 'live question event missing');
      assert.equal(question.question.kind, 'unknown');
      assert.equal(question.question.body.decodeState, 'unavailable');
      assert.equal(question.question.options.length, 0);
      assert.equal(gap.length, 1, 'reconnection gap missing or duplicated');
      assert.match(gap[0].message, /disconnect|process exit/);
      assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'ykt-live-answer').length, 0, 'missing question body must not produce an answer write');
      record.cases.push({ name: 'ykt-live-gap-missing-question', status: 'passed', answerWrites: 0, gaps: gap.length });


      stage = 'live-pause-confirmed-rejoin';
      for (const signal of process.platform === 'win32' ? ['SIGKILL'] : ['SIGINT', 'SIGTERM', 'SIGKILL']) {
        const before = new Set((await jobList()).map(job => job.id));
        let id;
        const beforeUpgrades = proxy.evidence().wsUpgrades;
        const ready = until(() => proxy.evidence().wsUpgrades > beforeUpgrades, 'live transport ready').then(() => until(() => {
          id = records(home, 'job:').find(row => !before.has(row.value.id) && row.value.status === 'waiting')?.value.id;
          return id;
        }, 'live session persisted and waiting'));
        const closedBefore = proxy.evidence().wsClosed;
        proxy.use([checkin, liveSocket(async socket => {
          socket.send(JSON.stringify({ op: 'unlockproblem', problem: { prob: 13, problemType: 1, limit: 30 }, msgid: 4 }));
        })]);
        await command('ykt', ['live', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--yes'], signal === 'SIGKILL' ? 0 : 3, {
          killed: signal === 'SIGKILL', kill: { signal, when: ready },
        });
        proxy.done();
        await until(() => proxy.evidence().wsClosed === closedBefore + 1, 'terminated live socket closure');
        const interrupted = await jobShow(id, 'ykt');
        if (signal === 'SIGKILL') assert.ok(['waiting', 'running'].includes(interrupted.status), `interrupted live job status must be waiting or running, got ${interrupted.status}`);
        else assert.equal(interrupted.status, 'paused');
        const checkins = proxy.evidence().requestLog.filter(item => item.tag === 'ykt-live-checkin').length;
        assert.equal((await command('ykt', ['jobs', 'resume', id], 3)).error.code, 'CONFIRMATION_REQUIRED');
        assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'ykt-live-checkin').length, checkins, 'rejoin requires explicit confirmation');
        proxy.use([checkin, liveSocket(async socket => { socket.send(JSON.stringify({ op: 'lessonfinished' })); })]);
        assert.equal((await command('ykt', ['jobs', 'resume', id, '--yes'])).data.job.status, 'succeeded');
        proxy.done();
        assert.equal((await jobShow(id, 'ykt')).status, 'succeeded');
        assert.equal(proxy.evidence().requestLog.filter(item => item.tag === 'ykt-live-checkin').length, checkins + 1, 'rejoin must perform exactly one confirmed checkin');
        const gaps = records(home, 'job-events:' + id)[0].value.filter(event => event.type === 'gap');
        assert.equal(gaps.length, 1);
        assert.match(gaps[0].message, /process exit/);
        assert.equal(existsSync(resolve(home, 'learning.lock')), false);
        record.cases.push({ name: 'live-' + signal + '-confirmed-rejoin-close', status: 'passed', gaps: 1, interruptedStatus: interrupted.status });
      }

      stage = 'jobs-cancel';
      proxy.use([checkin, liveSocket(async socket => {
        socket.send(JSON.stringify({ op: 'unlockproblem', problem: { prob: 12, limit: 30 }, msgid: 3 }));
      })]);
      const beforeCancel = new Set((await jobList()).map(job => job.id));
      let cancelJobId;
      let activeLockConflict;
      const upgradesBeforeCancel = proxy.evidence().wsUpgrades;
      const cancelController = new globalThis.AbortController();
      const { signal } = cancelController;
      const readinessTimeoutMs = process.platform === 'win32' ? 75_000 : 10_000;
      // Two readiness waits, four serial commands, then one command budget to exit.
      // Only this owner's lifetime includes the nested checks; child limits stay unchanged.
      const activeLockLifetimeMs = 2 * readinessTimeoutMs + 100 + 4 * commandTimeoutMs + commandTimeoutMs;
      let cancelGateCompleted = false;
      const cancelWait = until(() => proxy.evidence().wsUpgrades > upgradesBeforeCancel, 'cancel transport ready', readinessTimeoutMs, signal)
        .then(() => until(() => records(home, 'job:').find(row => !beforeCancel.has(row.value.id) && row.value.status === 'waiting')?.value.id, 'live waiting job', readinessTimeoutMs, signal));
      const cancelGate = (async () => {
        cancelJobId = await cancelWait;
        assert.ok(cancelJobId, 'live cancellation job did not become waiting');
        await delay(100, undefined, { signal });
        const lockBefore = readFileSync(resolve(home, 'learning.lock'), 'utf8');
        assert.equal((await jobShow(cancelJobId, 'ykt', { signal })).status, 'waiting');
        assert.equal((await jobList({ signal })).find(job => job.id === cancelJobId).status, 'waiting');
        activeLockConflict = await command('ykt', ['jobs', 'resume', cancelJobId], 3, { signal });
        assert.equal(activeLockConflict.error.code, 'CONFLICT');
        assert.equal((await command('ykt', ['jobs', 'cancel', cancelJobId, '--yes'], 3, { signal })).error.code, 'CONFLICT');
        assert.equal(readFileSync(resolve(home, 'learning.lock'), 'utf8'), lockBefore, 'contenders must preserve the active owner token');
        assert.equal(existsSync(resolve(home, 'learning.lock')), true, 'active writer lock must not be deleted');
        cancelGateCompleted = true;
        return cancelJobId;
      })();
      let canceledInvocation;
      try {
        canceledInvocation = await command('ykt', ['live', 'https://www.yuketang.cn/lesson?lesson_id=9000', '--yes'], process.platform === 'win32' ? 0 : 3, {
          killed: process.platform === 'win32',
          kill: { signal: process.platform === 'win32' ? 'SIGKILL' : 'SIGINT', when: cancelGate },
          timeout: activeLockLifetimeMs,
        });
        assert.equal(cancelGateCompleted, true, 'live owner exited before its active-lock checks completed');
      } finally {
        cancelController.abort();
        // Join the aborted observer/contender before outer cleanup can remove its files.
        await cancelGate.catch(() => {});
      }
      if (process.platform === 'win32') assert.equal(canceledInvocation.event.signal, 'SIGKILL');
      else assert.equal(canceledInvocation.error.code, 'CANCELED');
      await waitForJobStatus(cancelJobId, process.platform === 'win32' ? 'waiting' : 'paused');
      const canceled = await command('ykt', ['jobs', 'cancel', cancelJobId, '--yes']);
      assert.equal(canceled.data.status, 'canceled');
      assert.equal((await jobShow(cancelJobId, 'ykt')).status, 'canceled');
      assert.equal(existsSync(resolve(home, 'learning.lock')), false, 'cancellation path must leave no writer lock');
      record.cases.push({
        name: 'jobs-list-show-cancel-active-lock',
        status: 'passed',
        activeLockConflict: 'CONFLICT',
        readinessTimeoutMs, childTimeoutMs: commandTimeoutMs, lifetimeTimeoutMs: activeLockLifetimeMs,
        signal: process.platform === 'win32' ? 'SIGKILL' : 'SIGINT',
      });
      assert.equal(existsSync(env.LEARNING_HOME), false);
      assert.equal(children.size, 0, 'all standalone children must close');
      proxy.done();
      await until(() => proxy.evidence().wsClosed === proxy.evidence().wsUpgrades, 'all native live sockets closed');
      assert.ok(proxy.evidence().requests > 0, 'jobs journey must use the local proxy');
      assert.equal(record.cases.length, process.platform === 'win32' ? 25 : 31, 'zero or missing jobs scenarios');
      record.status = 'passed';
    } catch (error) {
      fail(error, stage);
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
        await new Promise(resolveClose => child.once('close', resolveClose));
      }
      record.childrenClosed = children.size === 0;
      record.network = proxy?.evidence();
      try {
        await proxy?.close();
        record.listenersClosed = true;
        record.network = proxy?.evidence();
      } catch (error) {
        fail(error, 'proxy-close');
      }
      try {
        Object.assign(record, await remove(directory));
        assert.equal(record.cleaned, true, 'isolated jobs directory still exists after cleanup');
      } catch (error) {
        fail(error, 'directory-cleanup');
      }
    }
    if (failures.length) break;
  }
  if (!failures.length) assert.equal(report.runs.length, 2, 'two fresh jobs runs are required');
  if (failures.length) throw new AggregateError(failures, 'standalone jobs failed; all failures retained');
} finally {
  writeFileSync(resolve(reportDir, 'jobs-' + (values.fault ?? 'journey') + '-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log('OK standalone jobs: real study/live recovery, reconciliation, locks and request readback');
