import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const cli = resolve(import.meta.dirname, '../dist/index.js');
const preload = resolve(import.meta.dirname, 'fixture-fetch.mjs');
const courseUrl = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=1001&clazzid=2002&cpi=3003&enc=not-stored';
const homes: string[] = [];

function run(dir: string, args: string[], fixture?: string, expectedCookie?: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [
    ...(fixture ? ['--import', preload] : []),
    cli,
    '--home', dir,
    ...args,
  ], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(fixture ? { LEARNING_FIXTURE_FILE: fixture } : {}),
      ...(expectedCookie ? { LEARNING_ASSERT_COOKIE: expectedCookie } : {}),
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

describe('Chaoxing CLI-only-study', () => {
  it('logs in from a protected password file without echoing credentials', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-chaoxing-login-'));
    homes.push(dir);
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'chaoxing', '--json']).code).toBe(0);

    const username = '13800138000';
    const password = 'p@ss w0rd!';
    const passwordFile = resolve(dir, 'chaoxing-password.txt');
    writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
    const body = new URLSearchParams({
      fid: '-1',
      uname: 'yYcVatS+4J+JGnm88UM56A==',
      password: 'qRMp6h+9mkdLaCCCOm7pmA==',
      refer: 'https%3A%2F%2Fi.chaoxing.com',
      t: 'true',
      forbidotherlogin: '0',
      validate: '',
      doubleFactorLogin: '0',
      independentId: '0',
    }).toString();
    const fixture = resolve(dir, 'login.json');
    writeFileSync(fixture, JSON.stringify({
      interactions: [
        {
          request: {
            method: 'POST', host: 'passport2.chaoxing.com', path: '/fanyalogin',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
            },
            body,
          },
          response: {
            status: 200,
            headers: { 'set-cookie': 'UID=login-cookie; Domain=.chaoxing.com; Path=/; Secure; HttpOnly' },
            body: { status: true },
          },
        },
        {
          request: { method: 'GET', host: 'i.chaoxing.com', path: '/base' },
          response: { status: 200, body: '<html>welcome uid: "123456"</html>' },
        },
      ],
    }));
    const logged = run(
      dir,
      ['login', '--profile', 'alpha', '--username', username, '--json'],
      fixture,
      undefined,
      { CHAOXING_PASSWORD_FILE: passwordFile },
    );
    expect(logged.code, logged.stderr).toBe(0);
    expect(JSON.parse(logged.stdout).data).toMatchObject({ platformUserId: '123456', identityVerified: true });
    expect(logged.stdout + logged.stderr).not.toContain(username);
    expect(logged.stdout + logged.stderr).not.toContain(password);
    expect(logged.stdout + logged.stderr).not.toContain('yYcVatS');
    expect(logged.stdout + logged.stderr).not.toContain('qRMp6h');
  });

  it('imports cookies, verifies identity and previews a URL course without writes', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'learning-chaoxing-'));
    homes.push(dir);
    expect(run(dir, ['init']).code).toBe(0);
    expect(run(dir, ['profile', 'add', 'alpha', '--platform', 'chaoxing', '--json']).code).toBe(0);

    const cookieFile = resolve(dir, 'cookies.json');
    writeFileSync(cookieFile, JSON.stringify([
      { name: 'UID', value: 'chaoxing-cookie', domain: '.chaoxing.com', secure: true },
    ]));
    expect(run(dir, ['login', '--profile', 'alpha', '--import', cookieFile, '--json']).code).toBe(0);

    const identity = resolve(dir, 'identity.json');
    writeFileSync(identity, JSON.stringify({
      interactions: [{
        request: { method: 'GET', host: 'i.chaoxing.com', path: '/base' },
        response: { status: 200, body: '<html>welcome uid=123456</html>' },
      }],
    }));
    const whoami = run(dir, ['whoami', '--profile', 'alpha', '--json'], identity, 'UID=chaoxing-cookie');
    expect(whoami.code, whoami.stderr).toBe(0);
    expect(JSON.parse(whoami.stdout).data).toMatchObject({ state: 'valid', session: { platformUserId: '123456' } });

    const outlineHtml = `<div class="chapter_unit">
      <div class="catalog_title"><a class="clicktitle">第一单元</a></div>
      <ul><li><div id="cur400"><a class="clicktitle">视频章节</a><input class="knowledgeJobCount" value="1"></div></li></ul>
    </div>`;
    const cardArg = {
      attachments: [{
        type: 'video', otherInfo: 'other-a&discard=1', mid: 'mid-a', jobid: '7001',
        attDurationEnc: 'enc-a', attDuration: 90, objectId: 'object-a',
        property: { name: '第一讲.mp4' }, isPassed: false,
      }],
      defaults: {
        fid: '9001', userid: '5005', cpi: 3003,
        reportUrl: 'https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/3003',
        reportTimeInterval: 60,
      },
      knowledgename: '视频章节',
    };
    const card = (num: string, hasArg: boolean) => ({
      request: {
        method: 'GET', host: 'mooc1.chaoxing.com', path: '/mooc-ans/knowledge/cards',
        query: { clazzid: '2002', courseid: '1001', knowledgeid: '400', num, ut: 's', cpi: '3003', v: '2025-0424-1038-3', mooc2: '1' },
      },
      response: {
        status: 200,
        body: hasArg
          ? `<script>mArg = ${JSON.stringify(cardArg)};</script>`
          : '<script>mArg = "";</script>',
      },
    });
    const outline = () => ({
      request: {
        method: 'GET', host: 'mooc2-ans.chaoxing.com', path: '/mooc2-ans/mycourse/studentcourse',
        query: { courseid: '1001', clazzid: '2002', cpi: '3003', ut: 's' },
      },
      response: { status: 200, body: outlineHtml },
    });
    const readSet = () => [outline(), card('0', true), card('1', false)];
    const outlineFixture = resolve(dir, 'outline.json');
    writeFileSync(outlineFixture, JSON.stringify({ interactions: readSet() }));
    const listed = run(dir, ['outline', courseUrl, '--profile', 'alpha', '--json'], outlineFixture, 'UID=chaoxing-cookie');
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).data.value.roots).toHaveLength(1);

    const previewFixture = resolve(dir, 'preview.json');
    writeFileSync(previewFixture, JSON.stringify({ interactions: readSet() }));
    const preview = run(dir, ['run', courseUrl, '--dry-run', '--yes', '--speed', '1', '--target', '1', '--profile', 'alpha', '--json'], previewFixture, 'UID=chaoxing-cookie');
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data.kind).toBe('study');
    expect(preview.stdout + preview.stderr).not.toContain('multimedia/log');
  });
});
