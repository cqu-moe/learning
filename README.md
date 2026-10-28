# learning — SDK + Agent CLI + Web

**公开仓库：cqu-moe/learning。规范版本 1.1；CLI 发行版本见 Releases。**

本仓库包含共享 SDK、Agent 专用本地 CLI 和本地 React Web 仪表盘。用户通过 Web 管理本机账号、浏览课程、发起与恢复任务；Agent 使用结构化 CLI，人工终端向导已移除。Web 复用 CQU Moe Design，启动与边界见 [Web UI](apps/web/README.md)；CLI 决策见 [ADR 0003](docs/adr/0003-agent-cli.md)。云端部署仍延期，实际能力与验收见 [功能状态](docs/FEATURE-STATUS.md) 和 [进度](docs/PROGRESS.md)。

CLI 提供 Windows、macOS、Linux 独立程序，直接下载运行，无需解压或安装 Node/Bun（macOS/Linux 下载后需 `chmod +x`）。访问 [Releases](https://github.com/cqu-moe/learning/releases)，按 [安装指南](docs/INSTALL.md) 下载、校验和初始化；第三方许可作为独立附件提供。源码开发继续使用固定 Node 24.11.1 / pnpm 11.19.0；发行流程见 [CLI 发布](docs/CLI-DISTRIBUTION.md)。

CLI 默认向 stdout 输出一个 `schemaVersion: 1` JSON envelope；`--output-format jsonl` 输出事件流。裸跑和命令组返回命令目录，`schema [path...]` 就近查询参数契约，缺少必填参数直接结构化报错。配套 Agent 指南源码在 [skills/learning-cli/SKILL.md](skills/learning-cli/SKILL.md)。

## 当前文件

| 文件 | 用途 |
|---|---|
| [SPEC](docs/SPEC.md) | SDK/CLI 基线与 Web UI 范围补充 |
| [SDK](docs/SDK.md) / [contracts](docs/contracts.d.ts) | SDK行为与接口声明，不是实现 |
| [PLATFORMS](docs/PLATFORMS.md) | 固定三平台协议与功能差异，范围没有随Web缩水 |
| [APPS](docs/APPS.md) | 当前CLI命令、本地任务与渲染、安装交付 |
| [PLAN](docs/PLAN.md) / [tasks.json](docs/tasks.json) | U01–U03 与 1.1 阶段验收记录，不是自动领取的新待办 |
| [ACCEPTANCE](docs/ACCEPTANCE.md) | 当前56组验收要求，不是已通过测试 |
| [HANDOFF](docs/HANDOFF.md) | 1.1 阶段交接背景，按需读取 |
| [PROGRESS](docs/PROGRESS.md) | 当前状态与逐任务证据索引 |
| [开发与验证](docs/agents/development.md) | 检查入口、源码证据、CI 等待和交付约定 |
| [SOURCES](docs/SOURCES.md) | 固定来源和本期E01–E08，未重查网页/平台 |
| [Web延期说明](docs/deferred/WEB.md) | 仅保留未来同仓/Cloudflare原生方向，不是可执行待办 |
| [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) | 本轮文档检查，不冒充产品测试 |
| [AGENTS](AGENTS.md) | 稳定约束、当前授权范围与按任务读取的导航 |
| [learning-cli Skill](skills/learning-cli/SKILL.md) | 可携带到其他仓库的已安装 CLI 使用指南 |

## 开发交接

继续开发时先读 AGENTS、简短的 PROGRESS 索引和当前 Git 差异，再定位相关契约、源码与测试。详细记录按任务写入 `docs/progress/`，保留已有证据。

原 SDK/CLI 1.1 阶段为 T00–T26 与 T31。当前用户授权的本地 Web 工作按 U01–U03 和 [Web UI 范围](docs/WEB-UI.md) 执行；云端部署与原生封装仍延期，不要求云账号或 Docker。

三个参考仓库需私有读取权限或只读checkout。离线工程工作不需要真实平台Cookie、模型Key或云密钥。真机和付费调用另行授权；编写代码不等于授权真实提交。
