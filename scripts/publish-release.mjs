// Publication runs only after all five native jobs and Node tests have passed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bunVersion, cliVersion, root } from './build-cli.mjs';
import { parseManifest, releaseManifest } from './release-manifest.mjs';

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
    // Rebuilt executables may differ. Verify the already published
    // files against their own manifest; never overwrite a published version.
    const manifestAsset = existing.assets.find(item => item.name === 'SHA256SUMS');
    assert.ok(manifestAsset);
    assert.deepEqual(existing.assets.map(item => item.name).sort(), files.map(path => path.split('/').at(-1)).sort());
    const manifest = gh(['api', '-H', 'Accept: application/octet-stream', manifestAsset.apiUrl]);
    for (const { digest, name } of parseManifest(manifest, cliVersion)) {
      const asset = existing.assets.find(item => item.name === name);
      assert.ok(asset, `published release is missing ${name}`);
      const bytes = execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', asset.apiUrl], { maxBuffer: 256 * 1024 * 1024 });
      assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, `published asset changed: ${name}`);
    }
    console.log(`Already published: ${existing.url}`);
    process.exit(0);
  }
} else {
  assert.ok(lookup.stderr.trim() === 'release not found', `release lookup failed: ${lookup.stderr}`);
  const notes = resolve(root, 'dist/release-notes.md');
  writeFileSync(notes, `CLI ${cliVersion} 的 Windows、macOS、Linux 独立程序。下载与源码均需本私有仓库权限。

直接下载对应系统和架构的程序，无需解压或安装 Node/Bun：

- macOS/Linux：先执行 \`chmod +x <程序文件>\`，再运行 \`./<程序文件> doctor\`、\`./<程序文件> init\`。
- Windows：在 PowerShell 运行 \`.\\learning-${cliVersion}-windows-x64.exe doctor\`、\`.\\learning-${cliVersion}-windows-x64.exe init\`。
- 可将文件重命名为 \`learning\`（Windows 为 \`learning.exe\`），并将所在目录加入 PATH。

[完整安装说明](https://github.com/${repository}/blob/${tag}/docs/INSTALL.md)。使用独立附件 SHA256SUMS 校验下载；Bun 及第三方依赖许可集中在独立附件 LICENSES.txt。ffprobe 为可选依赖，doctor 会显示可用性。

构建提交：${sha}；构建运行时：Bun ${bunVersion}。

本版未使用开发者证书签名或 macOS 公证。
`);
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
