# CLI 便携发行

2026-10-13：用户选定 Bun；Windows、macOS、Linux，且仅向有仓库权限的人分发。开发和 SDK 包消费继续使用 Node 24.11.1 / pnpm 11.19.0。

## 构建选择

Bun 1.4.3 固定于 `.bun-version`，用 `build --compile --minify --bytecode --format=esm` 编译完整 CLI。明确关闭当前目录 dotenv/bunfig 自动加载。CLI 包版本是发行版本，root/SDK 的 0.1.0 不参与发行命名。

Bun 内置运行时，用户无需安装 Node/Bun；比把当前含顶层 await 的 ESM 项目改为固定 Node 24 SEA 的 CommonJS 入口更直接。Deno 引入另一套兼容面，Rust/Go 重写成本不符合本轮小幅优化的范围。bytecode 是启动优化，不提供源码保密；能下载的当前用户本来就有源码读权限。压缩包不包含源码、声明、source map、用户数据或密钥。

| 目标 | 实际 CI runner | 归档 |
| --- | --- | --- |
| Windows x64 | windows-2025 | zip |
| macOS x64 | macos-15-intel | tar.gz |
| macOS arm64 | macos-15 | tar.gz |
| Linux x64 | ubuntu-24.04 | tar.gz |
| Linux arm64 | ubuntu-24.04-arm | tar.gz |

使用原生 runner 构建并运行，兼容性不是交叉编译返回成功就算通过。Linux 为 glibc 包；首版不覆盖 musl/Alpine 或 Windows ARM64。最低运行要求和证书状态见 [INSTALL.md](INSTALL.md)。

## 兼容性门禁

- 原 Node lint、类型、SDK/CLI 单测、打包消费者 E2E 保留。
- 每个 runner 用相同 Bun 参数编译测试探针，验证 SQLite 与 AES-GCM 的 Node/Bun 双向互读、冲突回滚、二维码、PDF、本机 HTTP/流/取消、WebSocket 收发与关闭；该探针不进入发布包。
- 实际发行归档解压到仓库外，清空 PATH 后运行真正的 CLI，验证无 Node/Bun 可用时的启动、版本、doctor、中文/空格相对路径、初始化与密钥保留、账号隔离、进程锁、失败清理和 dotenv/bunfig 隔离。
- macOS/Linux 再做真实 PTY 交互、取消与锁释放；Windows 检查当前用户目录/密钥/数据库 ACL。Windows 原生终端交互不以 POSIX PTY 测试替代。
- 发布前必须凑齐五个准确版本归档，逐个核对构建任务生成的 SHA256。缺目标、错误版本、校验失败均拒绝发布。

## CI 与私有 Release

`.github/workflows/ci.yml` 在 PR/main 执行，也可被 release 工作流复用。`.github/workflows/release.yml` 监听 main 上 CLI package.json 的版本变化；版本实际没变时不发布。也可在 main 手动运行，恢复中断流程。

更新 `apps/cli/package.json` 版本并按正常 PR 流程合并。流水线重跑完整门禁后创建 `cli-v<版本>` 私有 Release，先创建草稿、上传五个归档和 SHA256SUMS、检查资产齐全，最后发布。构建任务只有 contents:read，发布任务才有 contents:write；发布时再次检查仓库确实是 private、当前提交与工作流 SHA 相同且属于 main。

同版本不能指向不同提交。已发布版本不覆盖；同提交重试时读取既有资产并校验它们的校验和。失败草稿可在同提交恢复上传。这里固定版本与依赖输入，不承诺不同时间重建压缩包逐字节一致。

首版未接入 Windows 开发者证书、Apple Developer ID 或公证；它们需要对应证书/账户。不能把校验和称为开发者身份签名。只有已通过全部门禁的程序才进入 Release，PR artifact 仅用于验证。

## ffprobe

保留为可选 PATH 依赖，主程序不捆绑、静默安装或联网下载。doctor 只用无 shell 的 `ffprobe -version`、1 秒超时和 16 KiB 输出上限检查可用性。缺少它仅影响平台缺失视频时长时的 MP4 兜底，保持未知/暂不处理和 partial，不伪造完成。SDK 的 10 秒探测上限、协议白名单、禁止重定向与取消行为不变。

## 本机重现

```bash
# 先安装固定 Node/pnpm/Bun，仓库根目录执行
pnpm install --frozen-lockfile
pnpm build
node scripts/test-bun-runtime.mjs
node scripts/build-cli.mjs
pnpm licenses list --prod --json > dist/licenses.json
node scripts/package-cli.mjs
node scripts/test-archive.mjs
node scripts/test-release.mjs
```

`BUN_BINARY` 可指定固定 Bun 可执行文件路径。产物在 dist/releases，第三方许可从已冻结的生产依赖收集；Bun 自身许可说明保存在 BUN-LICENSE.md。测试环境与实际命令结果持续记入 [PROGRESS.md](PROGRESS.md)，真实平台账号验收仍单独记录。

## 官方依据

- [Bun 单文件编译、bytecode 与自动加载选项](https://bun.com/docs/bundler/executables)
- [Bun Node 兼容性](https://bun.com/docs/runtime/nodejs-apis)
- [Bun 系统要求](https://bun.com/docs/installation)
- [Bun 1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3)
- [GitHub 原生 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
