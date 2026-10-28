# learning 安装指南

本仓库为公开项目 cqu-moe/learning 的 SDK+CLI 阶段。Web 与云端部署已延期。

## 便携程序（推荐）

打开 [Releases](https://github.com/cqu-moe/learning/releases)，直接下载对应系统/架构的程序和 `SHA256SUMS`。Windows 提供 x64 `.exe`；macOS 与 Linux 各提供 x64、arm64 无扩展名程序。无需解压或安装 Node、Bun、Python。第三方许可证集中在同一 Release 的独立附件 `LICENSES.txt`，程序运行不依赖该文件。

```bash
# macOS / Linux：校验下载，按实际版本和架构替换文件名
shasum -a 256 learning-0.2.6-macos-arm64
# 与 SHA256SUMS 对应行比较；Linux 可用 sha256sum
chmod +x learning-0.2.6-macos-arm64
./learning-0.2.6-macos-arm64 doctor
./learning-0.2.6-macos-arm64 init
```

Windows 下载后，在 PowerShell 中运行：

```powershell
Get-FileHash .\learning-0.2.6-windows-x64.exe -Algorithm SHA256
# 与 SHA256SUMS 对应行比较
.\learning-0.2.6-windows-x64.exe doctor
.\learning-0.2.6-windows-x64.exe init
```

可将程序重命名为 `learning`（Windows 为 `learning.exe`），并把所在目录加入当前用户 PATH，之后直接使用 `learning` 命令。GitHub CLI 用户也可通过 `gh release download cli-v0.2.6 --repo cqu-moe/learning --pattern '*windows-x64.exe' --pattern SHA256SUMS --pattern LICENSES.txt` 下载；不提供携带私有 token 的公开安装脚本。

安装后先确认程序和本机能力，再初始化数据目录：

```bash
learning --version
learning doctor
learning --home ~/.learning init
learning schema profile add
```

`learning` 是 Agent 专用 CLI：默认输出单 JSON envelope，`--output-format jsonl` 输出事件流；裸跑与命令组返回命令目录，不启动向导。

运行要求沿 Bun：Windows 10 1809+、macOS 13+、glibc 2.17+ 的 Linux，x64 需 SSE4.2；首版不提供 Alpine/musl 或 Windows ARM64 原生包。实际 CI 使用 Windows 2025、macOS 15、Ubuntu 24.04，最低版本系统未逐一真机验证。首版未使用开发者证书签名或 macOS 公证，系统可能提示未知发布者；请核对来源与校验和，遵循系统的应用审批流程。

Release 页面提供安装说明、构建提交和 Bun 版本；`SHA256SUMS` 同时覆盖五个程序和独立许可证附件。Bun 的 minify/bytecode 不保证源码保密。程序不自动加载当前目录的 `.env` 或 `bunfig.toml`；模型等配置请显式设置进程环境变量。

## 源码安装前置条件

- Node.js 24.11.1（nvm：`nvm install 24.11.1`；`node -v` 必须 ≥24.11.1 且 <25）
- pnpm 11.19.0（`corepack enable && corepack prepare pnpm@11.19.0 --activate`）
- 常规安装和构建不需要 `.reference`；仅核对旧协议实现时需要三个私有参考仓库的固定 refs 和读取权限。

## 源码安装

```bash
git clone https://github.com/cqu-moe/learning.git
cd learning
pnpm install --frozen-lockfile
pnpm build
```

## 初始化

`learning` 不自动初始化；首次使用真实数据目录前显式运行 `init`。裸跑、`schema`、`doctor`、`--help` 和 `--version` 不创建数据目录。

数据目录按 `--home` → `LEARNING_HOME` → 系统用户目录下的 `.learning` 选择；相对路径按当前工作目录转为绝对路径。默认路径由操作系统解析，不依赖必须存在的 `HOME` 环境变量。`doctor` 只检查路径与状态，不创建数据目录。

```bash
node apps/cli/dist/index.js init --home ~/.learning
```

首次 init 生成 `master.key` 与 SQLite 状态库；macOS/Linux 目录权限 0700，密钥和数据库 0600；Windows 使用系统自带 PowerShell 设置当前用户专用 ACL，并让新文件继承。数据目录应为 CLI 专用目录，已有目录打开时也会收紧权限。操作草稿正文使用 AES-GCM 保存；旧明文操作记录首次读取时原地迁移，保留不确定写入状态。密钥与数据库同机存储，不抵御整机失陷；可用 LEARNING_HOME 隔离多套数据。

## 匿名使用统计

独立程序默认开启匿名使用统计及脱敏错误诊断。首次告知进入最终 JSON/JSONL result 的 `warnings`，code 为 `TELEMETRY_NOTICE`；后续诊断类警告以单行 JSON 写入 stderr。随后在数据目录保存 0600 的 `telemetry.json`，其中包含随机安装 UUID 和首次提示时间。错误诊断保留真实异常类型、脱敏限长消息、堆栈、cause 链、出错阶段及可用的 HTTP 状态、响应大小和结构校验位置；覆盖命令失败、恢复/重试、任务子项和未捕获异常，不以退出码 1 为限。不会上传完整请求/响应正文、题目答案、模型对话、凭据或命令参数列表；已知账号值、参数值、URL 查询和本机绝对路径会脱敏。

可运行 `learning telemetry status` 查看状态；不提供用户侧关闭开关，旧版关闭偏好和 `LEARNING_TELEMETRY_DISABLED` / `DO_NOT_TRACK` 不再生效。CI、Vitest、Node test / development 环境自动隔离。每批最多 16 个事件 / 64 KiB，退出时最多等待 750 ms；统计事件尽力发送，错误事件先以 0600 权限暂存在数据目录的 `diagnostic-outbox`，按采集项目隔离。暂存最多 7 天、256 条、5 MiB，单条不超过 32 KiB；超限或损坏会清理并提示。收到成功响应后删除，失败后在运行中或下次命令补传，沿用事件 UUID；硬杀进程、磁盘不可写和超出保留上限不能保证送达。诊断失败不改变业务结果或退出码。独立程序在构建时嵌入公共采集 token，不包含私人 API key；源码运行可用 `LEARNING_TELEMETRY_TOKEN` 或 `POSTHOG_PROJECT_TOKEN` 显式提供公共 token；Node 启动不会自动读取 `.env`，需由进程环境传入。统一通过 `https://p.cqu.moe/batch` 上报，`POSTHOG_HOST` 不参与配置。

业务事件覆盖学习、下载、作业、考试、讨论、登录和实时课堂的操作边界，只记录计数、状态和结果类型；提交事件表示已确认发送处理，不保证服务端最终成功。AI Observability 仅记录模型、耗时、token 用量、随机 session/trace 标识和错误类别，不上传提示词、回答或模型端点 URL；模型未返回用量时不估算费用。事件沿用匿名安装 UUID，不使用平台 profile 身份。重复的独立 SDK / OpenTelemetry 日志出口不启用。

模型标签包含 URL、邮箱、绝对路径或正文时统一记为 `custom`；输入与输出 token 分别校验，缺失或非法的一项省略，不把未知记成 0。模型 success 仅表示提案 JSON 解析成功，不代表业务校验、用户采纳或平台提交成功；取消单独记录。遥测共同字段使用 `trigger=agent`。诊断与模型指标共用上述自动隔离、匿名安装身份和发送预算。

Windows 同时收紧已有密钥、数据库、锁和默认 artifacts/exports 子树，并拒绝符号链接或 junction 跟随；放在数据目录外的自定义导出目录，请自行选择合适的访问权限。

## 可选 ffprobe

平台已提供视频时长时不需要 ffprobe。仅雨课堂部分视频缺失时长时，CLI 才会用 PATH 中的 `ffprobe` 读取已获授权的 MP4 时长。主程序不捆绑或自动下载 FFmpeg；可从 [FFmpeg 官方下载入口](https://ffmpeg.org/download.html) 选择适合系统的安装方式，将 `ffprobe` 加入 PATH 后运行 `learning doctor` 检查。

缺少工具、超时或探测失败时，保留“未知时长、暂不处理”的提示和 partial 状态，不伪造时长或学习完成。普通查询、登录和已有时长的视频不受影响。`doctor` 的 ffprobe 检查只运行本机 `ffprobe -version`，不请求视频或平台。

## 可选模型建议

手工草稿不需要模型。需要 `discuss draft <resource> --ai` 时，在本机进程环境中设置 `LEARNING_MODEL_BASE_URL`（HTTPS 兼容 API 的 `/v1` 根路径）、`LEARNING_MODEL_NAME` 和 `LEARNING_MODEL_API_KEY`；仅明确使用 `--ai` 时发送选定题目或讨论主题，建议仍需编辑并另行确认发布。密钥不写入仓库、CLI 输出或 profile 状态。本地适配器使用 [OpenAI Docs 的 Chat Completions 请求格式](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/create)；具体服务端是否兼容仍须用用户自己的配置验证。本轮没有调用付费模型。

## CLI 0.2 升级

使用固定 Node/pnpm 安装并重新构建即可；SDK 仍为 0.1.0。脚本需按 [迁移说明](CLI-MIGRATION.md) 更新 JSON envelope、任务列表、参数发现和扫码参数。生产运行不需要 Python。

## 备份/升级/回滚

- 备份：复制 LEARNING_HOME 目录（含 master.key 与 state.db）。
- 升级便携程序：停止当前 learning 进程，下载新版本、校验并替换程序，继续使用原数据目录；不复制或覆盖 master.key。
- 源码升级：`git pull && pnpm install --frozen-lockfile && pnpm build`。
- 回滚：保留完整数据备份，换回旧版本程序；源码使用旧 tag 重新安装构建。数据库 schema 不兼容时程序会拒绝打开，不自动降级数据。

## 解锁与恢复

- 多进程写冲突：CLI 会拒绝并提示占用 PID。确认原进程已退出后运行 `node apps/cli/dist/index.js --home <dir> profile unlock`；活跃 PID 不会被抢锁。
- 已保存的导出及三平台视频任务可用 `jobs show/resume/cancel` 管理；带 pending heartbeat/save 的任务须先 `jobs reconcile <job-id>` 只读核对，仍为 uncertain 时不会重交。独立作业/考试/讨论动作以错误里的 operationId 使用 `operations reconcile <operation-id>`；若平台无权威核对接口，仍保持 uncertain。
- 直播任务重启后 `jobs resume <job-id> --yes` 会重新签到同一课时、重握 WS，并报告期间无法恢复的事件缺口；未明确确认时不重新签到。更多能力限制见 [FEATURE-STATUS.md](FEATURE-STATUS.md)。
