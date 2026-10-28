import assert from 'node:assert/strict';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { executable, releaseDirectory, root } from './build-cli.mjs';
import { egressBoundary, loopbackCommand } from './helpers/loopback-command.mjs';
import { writePlatform } from './helpers/write-platform.mjs';
import { fixture, writeFixtures, yt, xt } from './helpers/write-fixtures.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' }, case: { type: 'string' }, control: { type: 'string' } } });
const cases = ['matching', 'homework', 'embedded', 'exam', 'discussion', 'uncertain'];
const selected = values.case === undefined ? cases : values.case.split(',').filter(Boolean);
const binary = resolve(values.binary ?? resolve(releaseDirectory, executable));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const yaml = createRequire(new URL('../packages/sdk/package.json', import.meta.url))('yaml');
const { exportDraftYaml, parseLearningDraft } = await import('../packages/sdk/dist/index.js');
mkdirSync(resolve(root, 'dist/e2e'), { recursive: true });
const report = { schemaVersion: 1, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: root }).trim() !== '', artifact: { name: executable, sha256: existsSync(binary) ? sha(readFileSync(binary)) : null }, platform: process.platform + '-' + process.arch, egressBoundary, control: values.control ?? null, runs: [] };
const failures = [];
try {
  assert.ok(selected.length > 0 && selected.every(name => cases.includes(name)), 'nonempty known scenario selection required');
  assert.ok(existsSync(binary), 'compiled CLI artifact missing');
  assert.ok(!values.control || ['wrong-answer', 'missing-fixture', 'cleanup'].includes(values.control), 'unknown control');
  for (let pass = 1; pass <= 2; pass++) {
    const directory = mkdtempSync(resolve(root, 'dist/写操作 独立目录 '));
    const home = resolve(directory, '账号 数据');
    const program = resolve(directory, executable);
    const record = { pass, cases: [], commands: [], artifacts: [], cleaned: false, failures: [] };
    report.runs.push(record);
    const children = new Set();
    let proxy, stage = 'setup';
    const blocked = resolve(directory, 'blocked');
    const fail = (error, phase) => { failures.push(new Error(phase + ': ' + error.message)); record.failures.push({ phase, code: error.code ?? error.name }); };
    try {
      copyFileSync(binary, program); if (process.platform !== 'win32') chmodSync(program, 0o755);
      proxy = await writePlatform(directory);
      const env = { PATH: '', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory, CI: '1', LEARNING_HOME: resolve(directory, 'ignored-home'), LEARNING_TELEMETRY_DISABLED: '1', HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, ALL_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: relative(directory, proxy.ca), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
      async function processRun(command, argv, options = {}) {
        const child = spawn(command, argv, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
        children.add(child);
        let stdout = '', stderr = '', timedOut = false, spawnError;
        child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        child.once('error', error => { spawnError = error.code; });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, process.platform === 'win32' ? 75_000 : 20_000);
        const result = await new Promise(res => child.once('close', (code, signal) => { children.delete(child); res({ code, signal }); })).finally(() => clearTimeout(timer));
        assert.equal(spawnError, undefined, 'child failed to start'); assert.equal(timedOut, false, 'child timeout'); assert.equal(result.signal, null, 'child signal');
        return { ...result, stdout, stderr };
      }
      async function run(profile, args, expected = 0) {
        const result = await processRun(...loopbackCommand(program, ['--home', home, ...(profile ? ['--profile', profile] : []), ...args, '--json'], proxy.url));
        record.commands.push({ command: args.map(a => a.split(directory).join('<isolated-directory>')), profile, code: result.code, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) });
        let diagnostic; try { diagnostic = JSON.parse(result.stdout).error?.code; } catch { /* checked below */ }
        record.commands.at(-1).errorCode = diagnostic;
        assert.equal(result.code, expected, 'CLI exit: ' + args[0] + ' ' + args[1] + ' (' + (diagnostic ?? 'none') + ')');
        assert.ok(result.stdout.trim(), 'empty CLI result');
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.schemaVersion, 1); assert.equal(envelope.exitCode, expected); assert.equal(envelope.ok, expected === 0);
        for (const secret of ['sess-fixture', 'xtx-sess-fixture', 'csrf-fixture', 'xtx-crypt-fixture', 'xtx-exam-sess']) assert.equal((result.stdout + result.stderr).includes(secret), false, 'secret leaked');
        assert.equal(existsSync(resolve(home, 'learning.lock')), false, 'CLI lock remains');
        return envelope;
      }
      async function call(profile, args, interactions = [], expected = 0) { proxy.use(interactions); const value = await run(profile, args, expected); proxy.done(); return value; }
      const file = (name, value, json = false) => { const path = resolve(directory, name); writeFileSync(path, json ? JSON.stringify(value) : yaml.stringify(value), { mode: 0o600 }); return path; };
      const draftFile = (name, draft) => { const path = resolve(directory, name); writeFileSync(path, exportDraftYaml(draft), { mode: 0o600 }); return path; };
      const readDraft = path => parseLearningDraft(readFileSync(path, 'utf8'));
      const answerSimplifiedDraft = (source, answers, name = '手工作业.yaml') => {
        const value = yaml.parse(readFileSync(source, 'utf8'));
        assert.equal(value.format, 'learning-homework/v1');
        assert.ok(value.answers !== null && typeof value.answers === 'object' && !Array.isArray(value.answers));
        return file(name, { ...value, answers: { ...value.answers, ...answers } });
      };
      const legacyAnswerDraft = (source, answers) => {
        const simplified = answerSimplifiedDraft(source, answers, '旧版手工作业.simple.yaml');
        return draftFile('旧版手工作业.yaml', readDraft(simplified));
      };
      const remember = path => record.artifacts.push({ name: relative(directory, path), sha256: sha(readFileSync(path)), bytes: readFileSync(path).length });
      // Independent public platform HTTP consumer, not an SDK store or result seed.
      async function readback(interaction) {
        proxy.use([interaction]);
        const req = interaction.request;
        const url = new URL('https://' + req.host + req.path); for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
        const args = ['-q', '--silent', '--show-error', '--fail', '--http1.1', '--noproxy', '', '--proxy', proxy.url, '--cacert', proxy.ca, '--header', 'Cookie: ' + req.cookie, ...Object.entries(req.headers).flatMap(([k, v]) => ['--header', k + ': ' + v]), url.href];
        const curl = process.platform === 'win32' ? resolve(process.env.SystemRoot, 'System32/curl.exe') : '/usr/bin/curl';
        const result = await processRun(...loopbackCommand(curl, args, proxy.url));
        assert.equal(result.code, 0, 'public platform readback'); proxy.done();
        record.commands.push({ command: ['platform-readback', req.path], code: result.code }); return JSON.parse(result.stdout);
      }
      await call(null, ['init']);
      for (const [profile, platform, host, cookie] of [['ykt', 'ykt', yt, 'sess-fixture'], ['xt', 'xuetang', xt, 'xtx-sess-fixture'], ['other', 'ykt', yt, 'sess-fixture']]) {
        await call(null, ['profile', 'add', profile, '--platform', platform]);
        const imported = file(profile + '-cookies.json', [{ name: 'sessionid', value: cookie, domain: host, path: '/' }, { name: 'csrftoken', value: platform === 'ykt' ? 'ykt-csrf-fixture' : 'xtx-csrf-fixture', domain: host, path: '/' }], true);
        await call(profile, ['login', '--import', imported]);
        const probe = platform === 'ykt' ? { request: { method: 'GET', host, path: '/v2/api/web/userinfo', query: {} }, response: { body: { errcode: 0, data: { user_id: 77, name: 'synthetic' } } } } : fixture('xuetang/courses')[0];
        assert.equal((await call(profile, ['whoami'], [probe])).data.state, 'valid');
      }
      const resources = {};
      for (const [profile, platform, list] of [['ykt', 'ykt', 'ykt/courses-list'], ['xt', 'xuetang', 'xuetang/courses']]) {
        const courses = (await call(profile, ['courses'], fixture(list))).data.items;
        const items = fixture(platform === 'ykt' ? 'ykt/nested-outline' : 'xuetang/outline');
        if (platform === 'ykt') items[2].response.body.data.course_chapter[0].section_leaf_list.push({ id: 505, leafinfo_id: 605, name: '写作业', leaf_type: 6, chapter_id: 11, order: 3 }, { id: 510, leafinfo_id: 610, name: '雨课堂考试', leaf_type: 5, chapter_id: 11, order: 4 });
        else { items.shift(); items[0].response.body.data.course_chapter.leaf_list.push(...[[31, 6], [30, 5], [32, 4]].map(([id, type]) => ({ id, leafinfo_id: id + 100, name: '合成写入资源', leaf_type: type, chapter_id: 150, order: id }))); }
        const outline = (await call(profile, ['outline', courses[0].ref.key], items)).data.value.roots;
        const flatten = nodes => nodes.flatMap(n => [...n.resources, ...flatten(n.children ?? [])]);
        resources[profile] = Object.fromEntries(flatten(outline).filter(n => n.ref).map(n => [n.ref.native.leafId, n.ref.key]));
      }
      const f = writeFixtures();
      let hw, matched, xtDraft, embeddedDraft, examDraft, discussDraft;
      // All draft files originate from public compiled CLI commands.
      hw = resolve(directory, '作业.yaml');
      await call('ykt', ['homework', 'draft', resources.ykt['505'], '-o', hw], [f.leaf('ykt', 505, 6, 888001), f.hwRead('ykt')]);
      assert.equal(yaml.parse(readFileSync(hw, 'utf8')).format, 'learning-homework/v1');
      assert.equal(readDraft(hw).entries.length, 4); assert.ok(readDraft(hw).entries.every(e => e.answer.kind === 'unset' && e.evidence === null)); remember(hw);
      for (const name of selected) {
        stage = name; const before = proxy.evidence().mutations.length;
        if (name === 'matching') {
          const source = file('反馈.json', { problems: f.problems.map((p, i) => ({ ...p, content: { ...p.content, ...(i === 0 ? { Answers: ['B'] } : {}) } })) }, true);
          matched = resolve(directory, '匹配.yaml');
          const exact = await call('ykt', ['answers', 'match', hw, '--source', source, '-o', matched], [f.hwRead('ykt')]);
          assert.deepEqual(exact.data.matches.map(m => m.state), ['exact', 'missing', 'missing', 'missing']); assert.equal(exact.data.applied, 1);
          assert.deepEqual(readDraft(matched).entries[0].answer, { kind: 'choice', keys: [values.control === 'wrong-answer' ? 'A' : 'B'] });
          assert.ok(readDraft(matched).entries.slice(1).every(e => e.answer.kind === 'unset')); remember(matched);
          const one = file('冲突甲.json', { problems: [{ ...f.problems[2], content: { ...f.problems[2].content, Answers: ['A'] } }] }, true);
          const two = file('冲突乙.json', { problems: [{ ...f.problems[2], content: { ...f.problems[2].content, Answers: ['B'] } }] }, true);
          const ambiguous = resolve(directory, '歧义.yaml');
          const conflict = await call('ykt', ['answers', 'match', hw, '--source', one, two, '-o', ambiguous], [f.hwRead('ykt')]);
          assert.equal(conflict.data.matches[2].state, 'ambiguous', 'conflicting feedback must not select first source'); assert.equal(conflict.data.applied, 0); assert.equal(readDraft(ambiguous).entries[2].answer.kind, 'unset'); remember(ambiguous);
          const reordered = answer => ({ problems: [{ ...f.problems[2], content: { ...f.problems[2].content, Options: [{ key: 'A', value: '乙' }, { key: 'B', value: '甲' }], Answers: [answer] } }] });
          const semanticConflict = file('相同字母不同含义.json', reordered('A'), true);
          const semanticAgreement = file('不同字母相同含义.json', reordered('B'), true);
          for (const [label, source] of [['选项含义冲突', semanticConflict], ['选项含义一致', semanticAgreement]]) {
            const path = resolve(directory, label + '.yaml');
            const result = await call('ykt', ['answers', 'match', hw, '--source', source, '-o', path], [f.hwRead('ykt')]);
            assert.equal(result.data.matches[2].state, 'missing', label + ': option edits change question identity');
            assert.equal(result.data.applied, 0);
            assert.equal(result.data.matches[2].answer, null);
            assert.equal(readDraft(path).entries[2].answer.kind, 'unset'); remember(path);
          }
          const nonexistent = file('不存在选项.json', { problems: [{ ...f.problems[0], content: { ...f.problems[0].content, Answers: ['Z'] } }] }, true);
          assert.equal((await call('ykt', ['answers', 'match', hw, '--source', nonexistent], [f.hwRead('ykt')])).data.matches[0].state, 'missing');
          const suggested = file('建议.json', { problems: [{ ...f.problems[3], problem_id: 999, content: { ...f.problems[3].content, Answers: ['B'] } }] }, true);
          const suggestionPath = resolve(directory, '建议.yaml');
          assert.equal((await call('ykt', ['answers', 'match', hw, '--source', suggested, '-o', suggestionPath], [f.hwRead('ykt')])).data.matches[3].state, 'suggested'); assert.equal(readDraft(suggestionPath).entries[3].answer.kind, 'unset');
          assert.equal((await call('other', ['answers', 'match', hw, '--source', source], [], 3)).error.code, 'FORBIDDEN');
          const malformed = resolve(directory, '坏反馈.json'); writeFileSync(malformed, '{broken');
          assert.equal((await call('ykt', ['answers', 'match', hw, '--source', malformed], [], 2)).error.code, 'INVALID_INPUT');
          const oldHash = sha(readFileSync(matched)); assert.equal((await call('ykt', ['answers', 'match', hw, '--source', source, '-o', matched], [f.hwRead('ykt')], 3)).error.code, 'CONFLICT'); assert.equal(sha(readFileSync(matched)), oldHash);
        } else if (name === 'homework') {
          const answered = answerSimplifiedDraft(hw, { 11: 'B', 12: 'B' });
          assert.equal((await call('ykt', ['homework', 'apply', hw, '--yes'], [], 2)).error.code, 'INVALID_INPUT');
          assert.equal((await call('ykt', ['homework', 'apply', answered], [], 3)).error.code, 'CONFIRMATION_REQUIRED');
          assert.equal((await call('other', ['homework', 'apply', answered, '--yes'], [], 3)).error.code, 'FORBIDDEN');
          const invalid = yaml.parse(readFileSync(answered, 'utf8')); invalid.answers[11] = { kind: 'judgement', value: true };
          assert.equal((await call('ykt', ['homework', 'apply', file('错误答案类型.yaml', invalid), '--yes'], [], 2)).error.code, 'INVALID_INPUT');
          const unchanged = f.hwRead('ykt');
          await call('ykt', ['homework', 'apply', answered, '--dry-run'], [unchanged, unchanged, unchanged]);
          const isolated = answerSimplifiedDraft(hw, { 11: 'B' }, '全隔离作业.yaml');
          const staleQuestion = f.hwRead('ykt', [11]);
          assert.equal((await call('ykt', ['homework', 'apply', isolated, '--yes'], [staleQuestion, staleQuestion], 2)).error.code, 'INVALID_INPUT');
          const legacy = legacyAnswerDraft(hw, { 11: 'B' });
          assert.equal((await call('ykt', ['homework', 'apply', legacy, '--yes'], [staleQuestion, staleQuestion], 2)).error.code, 'PRECONDITION_CHANGED');
          const changedSelected = f.hwRead('ykt', [12]);
          const partial = await call('ykt', ['homework', 'apply', answered, '--yes'], [unchanged, unchanged, unchanged, unchanged, f.homeworkWrite('ykt'), changedSelected], 4);
          assert.equal(partial.data.receipts.length, 1);
          assert.equal(partial.data.receipts[0].receipt.state, 'confirmed');
          assert.equal(partial.data.skipped.length, 1);
          assert.equal(partial.data.skipped[0].questionId, '12');
          assert.equal(partial.data.skipped[0].code, 'PRECONDITION_CHANGED');
          const homeworkReadback = await readback(f.hwRead('ykt'));
          assert.deepEqual(homeworkReadback.data.problems[0].user, { my_count: 1, answer: ['B'] });
          assert.deepEqual(homeworkReadback.data.problems[1].user, { my_count: 0, answer: null });
          xtDraft = resolve(directory, '学堂作业.yaml');
          await call('xt', ['homework', 'draft', resources.xt['31'], '-o', xtDraft], [f.leaf('xt', 31, 6, 888), f.hwRead('xt')]);
          const x = readDraft(xtDraft); x.entries[0].answer = { kind: 'choice', keys: ['B'] }; const xp = file('学堂答案.yaml', x);
          assert.equal((await call('xt', ['homework', 'apply', xp, '--yes'], [f.hwRead('xt'), f.homeworkWrite('xt')])).data.receipts[0].receipt.state, 'confirmed');
          assert.deepEqual((await readback(f.hwRead('xt'))).data.problems[0].user.answer, ['B']);
          assert.equal((await call('xt', ['homework', 'apply', xp, '--yes'], [f.hwRead('xt')], 2)).error.code, 'PRECONDITION_CHANGED');
        } else if (name === 'embedded') {
          embeddedDraft = resolve(directory, '内嵌.yaml'); const reads = f.embeddedRead();
          await call('ykt', ['homework', 'draft', resources.ykt['502'], '-o', embeddedDraft], [reads[0], ...f.embeddedRead()]);
          const d = readDraft(embeddedDraft); assert.equal(d.ref.kind, 'embedded'); d.entries[0].answer = { kind: 'choice', keys: ['B'] }; const path = file('内嵌答案.yaml', d);
          assert.equal((await call('ykt', ['homework', 'apply', path, '--yes'], [...f.embeddedRead(), ...f.embeddedRead(), f.embeddedRead()[0], f.embeddedWrite()])).data.receipts[0].receipt.state, 'confirmed');
          assert.equal((await readback(f.embeddedRead()[1])).data[0].user.is_right, true);
          assert.equal((await call('ykt', ['homework', 'apply', path, '--yes'], f.embeddedRead(), 2)).error.code, 'PRECONDITION_CHANGED');
        } else if (name === 'exam') {
          examDraft = resolve(directory, '考试.yaml');
          await call('xt', ['exam', 'draft', resources.xt['30'], '-o', examDraft], [f.leaf('xt', 30, 5, 3908258), ...f.examRead()]);
          const d = readDraft(examDraft); assert.ok(d.entries.every(e => e.answer.kind === 'unset')); d.entries[0].answer = { kind: 'choice', keys: ['B'] }; const path = file('考试答案.yaml', d);
          assert.equal((await call('xt', ['exam', 'start', resources.xt['30']], [], 3)).error.code, 'CONFIRMATION_REQUIRED');
          await call('xt', ['exam', 'start', resources.xt['30'], '--dry-run'], [f.leaf('xt', 30, 5, 3908258), f.cover()]);
          assert.equal((await call('xt', ['exam', 'save', path, '--yes'], f.examRead(), 2)).error.code, 'PRECONDITION_CHANGED');
          assert.equal((await call('xt', ['exam', 'start', resources.xt['30'], '--yes'], [f.leaf('xt', 30, 5, 3908258), f.cover(), f.cover(), ...f.sso(), f.startWrite()])).data.receipt.state, 'confirmed');
          assert.equal((await readback(f.cover())).data.data.result.status, 1);
          assert.equal((await call('xt', ['exam', 'save', path], [], 3)).error.code, 'CONFIRMATION_REQUIRED');
          assert.equal((await call('other', ['exam', 'save', path, '--yes'], [], 3)).error.code, 'FORBIDDEN');
          await call('xt', ['exam', 'save', path, '--dry-run'], f.examRead());
          const unverified = JSON.parse(JSON.stringify(d)); unverified.entries[1].answer = { kind: 'fill-blank', blanks: [{ id: '1', text: 'synthetic' }] };
          assert.equal((await call('xt', ['exam', 'save', file('未验证题型.yaml', unverified), '--yes'], f.examRead(), 3)).error.code, 'UNSUPPORTED');
          assert.equal((await call('xt', ['exam', 'save', path, '--yes'], [...f.examRead(), f.cover(), ...f.sso(), f.saveWrite()])).data.receipt.state, 'confirmed');
          assert.equal(f.state.examStatus, 1, 'save must not finalize');
          const exported = await call('xt', ['exam', 'export', resources.xt['30'], '--output-dir', resolve(directory, '读回')], [f.leaf('xt', 30, 5, 3908258), ...f.examRead()]);
          const resultPath = exported.data.files[0]; const paper = JSON.parse(readFileSync(resultPath)); assert.equal(paper.state, 'in-progress'); assert.deepEqual(paper.questions[0].myAnswer, { kind: 'choice', keys: ['B'] }); remember(resultPath);
          assert.equal((await call('xt', ['exam', 'submit', path], [], 2)).error.code, 'INVALID_INPUT');
          const gated = await call('xt', ['exam', 'submit', path, '--yes', '--final'], [], 3); assert.ok(gated.data.blockers.some(b => b.startsWith('E05:')));
          const yd = resolve(directory, '雨课堂考试.yaml'); await call('ykt', ['exam', 'draft', resources.ykt['510'], '-o', yd], fixture('ykt/exam-read'));
          assert.equal((await call('ykt', ['exam', 'save', yd, '--yes'], [], 3)).error.code, 'UNSUPPORTED');
        } else if (name === 'discussion') {
          discussDraft = resolve(directory, '讨论.json'); await call('xt', ['discuss', 'draft', resources.xt['32'], '-o', discussDraft], [f.topic(), f.topic(), f.comments()]);
          const d = JSON.parse(readFileSync(discussDraft)); assert.equal(d.text, ''); assert.equal(d.origin, 'user');
          assert.equal((await call('xt', ['discuss', 'post', discussDraft, '--yes'], [], 2)).error.code, 'INVALID_INPUT');
          d.text = '仅合成平台讨论回复'; const path = file('讨论答案.json', d, true);
          assert.equal((await call('xt', ['discuss', 'post', path], [], 3)).error.code, 'CONFIRMATION_REQUIRED');
          assert.equal((await call('other', ['discuss', 'post', path, '--yes'], [], 3)).error.code, 'FORBIDDEN');
          await call('xt', ['discuss', 'post', path, '--dry-run'], [f.topic()]);
          const changed = { ...d, sourceHash: 'changed' }; assert.equal((await call('xt', ['discuss', 'post', file('讨论过期.json', changed, true), '--yes'], [f.topic()], 2)).error.code, 'PRECONDITION_CHANGED');
          assert.equal((await call('xt', ['discuss', 'post', path, '--yes'], [f.topic(), f.discussionWrite()])).data.receipt.state, 'confirmed');
          const replies = (await readback(f.comments())).data.results; assert.equal(replies.length, 1); assert.equal(replies[0].content.text, d.text);
          assert.equal((await call('ykt', ['discuss', 'draft', resources.ykt['505'], '-o', resolve(directory, '不支持.json')], [], 3)).error.code, 'UNSUPPORTED'); assert.equal(existsSync(resolve(directory, '不支持.json')), false);
        } else if (name === 'uncertain') {
          // Fresh file prepared by the CLI even when this scenario is selected alone.
          const path = resolve(directory, '丢响应讨论.json'); await call('xt', ['discuss', 'draft', resources.xt['32'], '-o', path], [f.topic(), f.topic(), f.comments()]);
          const d = JSON.parse(readFileSync(path)); d.text = '仅合成平台讨论回复'; writeFileSync(path, JSON.stringify(d));
          const lost = await call('xt', ['discuss', 'post', path, '--yes'], [f.topic(), f.discussionWrite(true)], 5); assert.equal(lost.error.code, 'UNCERTAIN'); const id = lost.error.operationId; assert.match(id, /^operation-/);
          const afterSend = proxy.evidence().mutations.length;
          for (let i = 0; i < 2; i++) { const reconciled = await call('xt', ['operations', 'reconcile', id], [], 5); assert.equal(reconciled.data.operationId, id); assert.equal(reconciled.data.state, 'uncertain'); }
          assert.equal((await call('other', ['operations', 'reconcile', id], [], 3)).error.code, 'FORBIDDEN');
          assert.equal(proxy.evidence().mutations.length, afterSend, 'restart/reconcile must not resubmit');
          assert.equal((await readback(f.comments())).data.results.length, selected.includes('discussion') ? 2 : 1);
          record.uncertain = { operationId: id, acceptedRequests: 1, reconciliationProcesses: 2, state: 'uncertain', automaticResubmissions: 0 };
        }
        if (name === 'matching') assert.equal(proxy.evidence().mutations.length, before, 'matching sent a write');
        record.cases.push({ name, status: 'passed', mutations: proxy.evidence().mutations.length - before });
      }
      if (values.control === 'missing-fixture') { proxy.use([]); await run('xt', ['courses']); }
      if (values.control === 'cleanup') { mkdirSync(blocked); writeFileSync(resolve(blocked, 'kept'), 'cleanup control'); chmodSync(blocked, 0); assert.fail('deliberate primary failure'); }
      assert.ok(record.cases.length > 0, 'zero scenarios cannot succeed');
      assert.equal(existsSync(env.LEARNING_HOME), false); assert.ok(existsSync(resolve(home, 'state.db')));
      record.status = 'passed';
    } catch (error) { fail(error, stage); record.status = 'failed'; }
    finally {
      for (const child of children) child.kill('SIGKILL');
      if (children.size) await new Promise(res => setTimeout(res, 50));
      record.childrenClosed = children.size === 0;
      if (!record.childrenClosed) fail(new Error('child remains'), 'children-cleanup');
      if (proxy) { record.platform = proxy.evidence(); try { await proxy.close(); record.listenersClosed = true; } catch (error) { fail(error, 'proxy-cleanup'); } }
      for (let attempt = 1; attempt <= 5; attempt++) {
        record.cleanupAttempts = attempt;
        try { await rm(directory, { recursive: true, force: true }); record.cleaned = !existsSync(directory); if (record.cleaned) break; }
        catch (error) { if (process.platform !== 'win32' || attempt === 5) { fail(error, 'directory-cleanup'); break; } }
        await new Promise(res => setTimeout(res, 100 * attempt));
      }
      if (!record.cleaned && !record.failures.some(f => f.phase === 'directory-cleanup')) fail(new Error('directory remains'), 'directory-cleanup');
      if (values.control === 'cleanup' && existsSync(blocked)) { chmodSync(blocked, 0o700); await rm(directory, { recursive: true, force: true }); record.controlRecoveryCleaned = !existsSync(directory); }
    }
    if (failures.length) break;
  }
} catch (error) { failures.push(error); report.failure = error.message; }
const path = resolve(root, `dist/e2e/writes-${values.control ?? 'journey'}-${Date.now()}-${process.pid}.json`);
writeFileSync(path, JSON.stringify(report, null, 2) + '\n'); console.log(relative(root, path));
if (failures.length) throw new AggregateError(failures, 'compiled write journey failed');
assert.equal(report.runs.length, 2); assert.ok(report.runs.every(r => r.cleaned && r.listenersClosed && r.childrenClosed));
console.log('OK compiled CLI writes: two clean runs');
