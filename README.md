# learning — SDK + CLI

**公开仓库：cqu-moe/learning。规范版本 1.1；CLI 发行版本见 Releases。**

本仓库实现共享 SDK 与 Agent 专用本地 CLI，只有 @learning/sdk、@learning/cli 两包；Web 和 Cloudflare 部署延期，人工终端向导移除。开发规范沿用 1.1，Agent CLI 决策见 [ADR 0003](docs/adr/0003-agent-cli.md)，实际能力与未完成的真机验收见 [功能状态](docs/FEATURE-STATUS.md) 和 [进度](docs/PROGRESS.md)。

CLI 提供 Windows、macOS、Linux 独立程序，直接下载运行，无需解压或安装 Node/Bun（macOS/Linux 下载后需 `chmod +x`）。访问 [Releases](https://github.com/cqu-moe/learning/releases)，按 [安装指南](docs/INSTALL.md) 下载、校验和初始化；第三方许可作为独立附件提供。源码开发继续使用固定 Node 24.11.1 / pnpm 11.19.0；发行流程见 [CLI 发布](docs/CLI-DISTRIBUTION.md)。

CLI 默认向 stdout 输出一个 `schemaVersion: 1` JSON envelope；`--output-format jsonl` 输出事件流。裸跑和命令组返回命令目录，`schema [path...]` 就近查询参数契约，缺少必填参数直接结构化报错。配套 Agent 指南源码在 [skills/learning-cli/SKILL.md](skills/learning-cli/SKILL.md)。

## 当前文件

| 文件 | 用途 |
|---|---|
| [SPEC](docs/SPEC.md) | 本期范围、两包结构、技术栈、明确不做的内容 |
| [SDK](docs/SDK.md) / [contracts](docs/contracts.d.ts) | SDK行为与接口声明，不是实现 |
| [PLATFORMS](docs/PLATFORMS.md) | 固定三平台协议与功能差异，范围没有随Web缩水 |
| [APPS](docs/APPS.md) | 当前CLI命令、本地任务与渲染、安装交付 |
| [PLAN](docs/PLAN.md) / [tasks.json](docs/tasks.json) | 当前28项：T00–T26与T31 |
| [ACCEPTANCE](docs/ACCEPTANCE.md) | 当前56组验收要求，不是已通过测试 |
| [HANDOFF](docs/HANDOFF.md) | 首次、继续、迁移、纠偏和复核提示词 |
| [PROGRESS](docs/PROGRESS.md) | 实际进度模板；已有记录时合并而非覆盖 |
| [SOURCES](docs/SOURCES.md) | 固定来源和本期E01–E08，未重查网页/平台 |
| [Web延期说明](docs/deferred/WEB.md) | 仅保留未来同仓/Cloudflare原生方向，不是可执行待办 |
| [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) | 本轮文档检查，不冒充产品测试 |
| [AGENTS](AGENTS.md) | 防止模型提前开发Web或过度设计的根约束 |
| [learning-cli Skill](skills/learning-cli/SKILL.md) | 可携带到其他仓库的已安装 CLI 使用指南 |

## 开发交接

继续开发时先读 AGENTS、SPEC 和 PROGRESS，按 HANDOFF 的继续/复核提示执行；合并已有进度，不能覆盖 PROGRESS 或删除已写文件。旧文档移出模型活动上下文。

先完成T00–T26，再执行本机验收T31，之后停止。T27–T30已延期，不建空包、不安装Web/Cloudflare依赖，不要求云账号或Docker。CLI需要的本地PDF、字体和浏览器仍在T24/T26内。

三个参考仓库需私有读取权限或只读checkout。离线工程工作不需要真实平台Cookie、模型Key或云密钥。真机和付费调用另行授权；编写代码不等于授权真实提交。
