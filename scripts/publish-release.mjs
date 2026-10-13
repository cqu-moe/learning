// Publication runs only after all five native jobs and Node tests have passed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cliVersion, root } from './build-cli.mjs';
import { releaseManifest } from './release-manifest.mjs';

assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'release only from main');
const repository = process.env.GITHUB_REPOSITORY;
assert.ok(repository);
const sha = process.env.GITHUB_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
function gh(args) { return execFileSync('gh', args, { encoding: 'utf8' }).trim(); }
assert.equal(JSON.parse(gh(['api', `repos/${repository}`])).private, true, 'private distribution must remain private');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha);
execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main']);
const tag = `cli-v${cliVersion}`;
const directory = resolve(root, 'dist/releases');
writeFileSync(resolve(directory, 'SHA256SUMS'), releaseManifest(directory, cliVersion));
const files = readdirSync(directory).filter(name => !name.endsWith('.sha256')).map(name => resolve(directory, name));
const viewArgs = ['release', 'view', tag, '--repo', repository, '--json', 'isDraft,targetCommitish,assets,url'];
const tagLookup = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' });
if (tagLookup.status === 0) assert.equal(tagLookup.stdout.trim(), sha, 'tag belongs to another commit');
const lookup = spawnSync('gh', viewArgs, { encoding: 'utf8' });
if (lookup.error) throw lookup.error;
let existing;
if (lookup.status === 0) {
  existing = JSON.parse(lookup.stdout);
  assert.equal(existing.targetCommitish, sha, 'version already belongs to a different commit; bump CLI version');
  if (!existing.isDraft) {
    // Rebuilt archives may have different timestamps. Verify the already published
    // files against their own manifest; never overwrite a published version.
    const manifestAsset = existing.assets.find(item => item.name === 'SHA256SUMS');
    assert.ok(manifestAsset);
    const manifest = gh(['api', '-H', 'Accept: application/octet-stream', manifestAsset.apiUrl]);
    const names = [];
    for (const line of manifest.split('\n')) {
      const match = /^([a-f0-9]{64}) {2}(learning-[\w.-]+\.(?:zip|tar\.gz))$/.exec(line);
      assert.ok(match, 'invalid published checksum manifest');
      const [, digest, name] = match;
      names.push(name);
      const asset = existing.assets.find(item => item.name === name);
      assert.ok(asset, `published release is missing ${name}`);
      const bytes = execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', asset.apiUrl], { maxBuffer: 256 * 1024 * 1024 });
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `published asset changed: ${name}`);
    }
    assert.deepEqual(names.sort(), files.map(path => path.split('/').at(-1)).filter(name => name !== 'SHA256SUMS').sort());
    console.log(`Already published: ${existing.url}`);
    process.exit(0);
  }
} else {
  assert.ok(lookup.stderr.trim() === 'release not found', `release lookup failed: ${lookup.stderr}`);
  const notes = resolve(root, 'dist/release-notes.md');
  writeFileSync(notes, `CLI ${cliVersion} 的 Windows、macOS、Linux 便携程序。下载与源码均需本私有仓库权限。\n\n解压后运行 learning（Windows 为 learning.exe），无需安装 Node/Bun。请阅读压缩包中的 INSTALL.md；使用 SHA256SUMS 校验下载。ffprobe 为可选依赖，learning doctor 会显示可用性。\n\n构建提交：${sha}\n\n本版未使用开发者证书签名或 macOS 公证。\n`);
  gh(['release', 'create', tag, '--repo', repository, '--target', sha, '--draft', '--title', `CLI ${cliVersion}`, '--notes-file', notes]);
}
// Only draft assets may be replaced when recovering an interrupted upload.
gh(['release', 'upload', tag, ...files, '--repo', repository, '--clobber']);
const draft = JSON.parse(gh(viewArgs));
assert.equal(draft.isDraft, true);
assert.deepEqual(draft.assets.map(item => item.name).sort(), files.map(path => path.split('/').at(-1)).sort());
for (const path of files) {
  const asset = draft.assets.find(item => item.name === path.split('/').at(-1));
  assert.equal(asset.digest, `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`, 'uploaded asset digest mismatch');
}
gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
const published = JSON.parse(gh(viewArgs));
assert.equal(published.isDraft, false);
assert.equal(JSON.parse(gh(['api', `repos/${repository}/git/ref/tags/${tag}`])).object.sha, sha);
console.log(published.url);
