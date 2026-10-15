# LEARNING-WINDOWS-CONTROL

2026-10-16。已修复 Windows write negative controls 的报告路径识别；本机真实子进程正负例与全部原负控通过。**Windows native 未运行，Linux/Windows CI 仍需后续验证；未 push。**

## 固定提交与工作区

- 基线：`17e0cf661a00590cef270828d8cd455b584e0f02`，与只读 integration/learning 当时 HEAD 一致。
- **修复 SHA：`b9dedb033554bd5815706a37884e4cb2ce6c2151`**，唯一父提交为上述基线；分支 `codex/e2e-20261015-learning-windows-control`。
- 独占路径：`/Users/uu/Developer/cqu-moe/.agent-worktrees/e2e-20261015/tickets/LEARNING-WINDOWS-CONTROL`。本报告及证据也在此 worktree 内，未编辑工作区根 execution/status、integration、PR 或 Schedule。
- 提交前核验有效身份：`User-Unauthorized <69748465+UserUnauthorized@users.noreply.github.com>`，来自既有 Git 配置；没有身份覆盖或配置修改。`git commit -S` 成功，`git verify-commit` exit0，`%G?=G`，指纹 `SHA256:kFBsDXcJS4MSU8XzdxOS6OXw1GWgslmAJ01pZuIHgrg`，沿用 SSH/1Password signer。
- 下面精确提交重放期间 `git status --porcelain` 为空，子证据均读回该修复 SHA、`sourceDirty=false`。报告与证据作为后续独立文档提交保存；不把文档提交冒称为已执行源码 SHA。

## 实际 GitHub 故障

直接读取 [CI 38777185239 / Windows job 116567761348](https://github.com/cqu-moe/learning/actions/runs/38777185239/job/116567761348) 的完整日志；原文节选保存在 [original-windows-failure.log](LEARNING-WINDOWS-CONTROL-evidence/original-windows-failure.log)。提交的日志展示副本仅去除行尾空格；完整原始job日志及沙箱尝试日志仍在 `dist/e2e/windows-control/` 原样保留，清单记录hash。原始压缩包 SHA256 为 `75b917795097e000705c115a32a0e27e7fb5194e24de7a844e1f99f412be504b`，未改写 `/private/tmp/learning-final-11995610389.zip`。

该 run head 为17e，Actions 实际 checkout 为 PR19 合成 merge **`f8bfe68120083fcd1fe9478e7157b39b8e491003`**；日志明确显示 Merge 17e into 3d559ed。原始子报告的 sourceRevision=f8bfe 是正确归属，不能写成 clean17e。

1. Step21 正常 writes 双轮成功：每轮六场景、77条 command 记录（包括 Windows 明确 not-run 的 POSIX PTY 条目）、118 HTTPS、56 CONNECT、7次合成平台 mutation、0拒绝，children/listeners/目录均清理。原始结果摘要在 [original-windows-normal-summary.json](LEARNING-WINDOWS-CONTROL-evidence/original-windows-normal-summary.json)。
2. Step22 的真实错误是父进程 `test-binary-writes-controls.mjs:20:106`：`AssertionError: empty selection evidence missing`，actual undefined；不是子进程空选择获准。
3. [原始失败子报告](LEARNING-WINDOWS-CONTROL-evidence/writes-journey-1792086075223-5708.json) 明确 `runs=[]`、`failure="nonempty known scenario selection required"`；[原始父报告](LEARNING-WINDOWS-CONTROL-evidence/write-controls-1792086075238-3336.json) 为 `controls=[]/cleaned=true`。
4. 子进程用 `path.relative()` 输出本机路径；Windows 输出 `dist\e2e\writes-….json`，父进程只匹配 `^dist/e2e/writes-…`。首个负控在读回报告前失败，因此后续负控未执行。日志没有显示 childstatus 异常，不能将其推断为 Windows 退出码问题。

## 修复与测试归属

将原有退出/路径/JSON读取移到测试工具 `write-control-evidence.mjs`：按行处理 LF/CRLF、把反斜杠转为正斜杠，要求恰好一条限定在 `dist/e2e/writes-*.json` 的报告路径，然后读取磁盘上真实报告。子进程必须无 timeout、无 signal、**自行 exit1**，原先仅非零的要求收紧。没有修改产品源码、CLI、平台协议、确认/写入断言、120秒负控预算或 CI 40分钟预算。

`test-audit` 作者门禁：受保护契约为父 runner 接收真实子进程退出及跨平台证据路径；可信回归即原 Windows 分隔符不能识别，或成功子进程被当成负控。现有 compiled journey 保护业务与平台/文件/存储边界，不能在 macOS CI 自动触发 Windows 路径拼写，故在此输出边界新增两项聚焦测试。helper 的实际调用者是原 controls runner，没有新增产品 export、注入 flag、测试专用 SDK store 或伪造报告。

- 真负例调用原 `test-binary-writes.mjs --case=`，核验真实 exit1；仅把该子进程输出路径分别拼写为 POSIX 与 Windows+CRLF，读回同一真实文件及其失败原因。没有在 mock 中实现被测行为。
- 真正例调用正式 compiled CLI 的 `--case matching`：两轮新目录都通过，子进程 exit0、无 mutation、清理完成；负控读取器必须拒绝该成功结果。
- 原六负控全部保留：empty selection、missing artifact、empty output、wrong answer assertion、missing fixture、primary and cleanup failure。Windows 原本两项 POSIX-only 的 not-run 声明原样保留；其他四项和真实目录清理仍强制执行。
- CI 只在原 write-controls 步骤前加入聚焦测试；未删减正常双轮或负控步骤。`$autoreview` 专用技能/执行入口未在当前运行时提供，已做固定差分 standards/spec/test-audit 自审，不能冒称独立模型审查；未发现需扩展范围的事项。未调用 GLM，运行时没有可指定/验证 `6.1sol` 的模型切换入口。

## 真实红绿与精确 SHA 验证

工具链实际核验 Node24.11.1、pnpm11.19.0、Bun1.4.3；冻结离线安装复用既有缓存196包，没有改依赖或 lockfile。正式编译无遥测。

| 验证 | 实际结果 |
| --- | --- |
| 修前原路径识别逻辑提取、未修复，新真实负例回归 | exit1，精确 `empty selection evidence missing`；[red.log](LEARNING-WINDOWS-CONTROL-evidence/red.log)。这是原逻辑的本机 Windows 拼写回归，原 Windows job 为独立原生红灯。提取版本逐字保存在 `.mjs.txt` 证据中。 |
| 首次修后受限沙箱尝试 | 负例通过；正例本地TLS监听 EPERM、exit1，保留 [green.log](LEARNING-WINDOWS-CONTROL-evidence/green.log)，不能冒称产品红灯或绿灯。允许本地监听后相同断言通过。 |
| 精确 clean b9dedb0，`node --test scripts/test-write-control-evidence.mjs` | exit0，2/2；[clean-focused.log](LEARNING-WINDOWS-CONTROL-evidence/clean-focused.log)，真实正例 [writes-journey-1792086639006-23043.json](LEARNING-WINDOWS-CONTROL-evidence/writes-journey-1792086639006-23043.json) 两轮各26条命令，matching通过、0 mutation、清理全true。 |
| 精确 clean b9dedb0，`node scripts/test-binary-writes-controls.mjs` | exit0；[clean-controls.log](LEARNING-WINDOWS-CONTROL-evidence/clean-controls.log)，[六项汇总](LEARNING-WINDOWS-CONTROL-evidence/write-controls-1792086644053-22160.json)。六个真实子进程均exit1；empty/missing在准入前失败，其他失败均到达原断言阶段。清理拒绝同时保留matching主错误和directory-cleanup/EACCES，再恢复权限并读回目录不存在。 |
| `pnpm lint`、`pnpm typecheck`、`pnpm build`、正式Bun编译 | 全部exit0，日志随证据保存。 |
| 三个变更脚本 `node --check`、`node scripts/check-boundaries.mjs`、`git diff --check` | 全部exit0。 |
| `git verify-commit b9dedb0` | exit0，G，身份/指纹如上。 |

正式 macOS arm64 程序 SHA256 为 **`3d7e4751b6562f853add428566e2b7576513b3dea6309959682e00ad6f52d8a0`**，与17e正式产物一致，产品执行内容没有变化。[manifest.json](LEARNING-WINDOWS-CONTROL-evidence/manifest.json) 记录精确SHA、原档/完整job日志hash、环境、结果、子报告及逐文件hash；所有干净重放子报告均核验 `sourceRevision=b9dedb033554bd5815706a37884e4cb2ce6c2151/sourceDirty=false`。

## 修改路径与后续边界

修复提交共5文件、69增6删：产品0；测试/工具56增5删；CI3增1删；进度文档10增。精确路径：

```text
.github/workflows/ci.yml
scripts/test-binary-writes-controls.mjs
scripts/helpers/write-control-evidence.mjs
scripts/test-write-control-evidence.mjs
docs/PROGRESS.md
```

后续文档提交仅新增本报告和 `docs/e2e/results/LEARNING-WINDOWS-CONTROL-evidence/*` 原始/结构化证据。

本机是 macOS arm64，**Windows native unavailable；Linux CI 和 Windows CI 仍需运行本补丁**，没有把拼写回归或旧CI四平台成功当成本补丁跨平台通过。按本票范围未重跑SDK/CLI全套、无关jobs/catalog/exports旅程，也未执行缺私有参考仓库的source-lock检查。没有超时膨胀、凭据或真实服务访问，没有账号/真实学业写入、付费模型、push、PR变更、merge、发布或integration操作。下一步由父任务审查独立提交后安排Linux/Windows CI。
