# learning — SDK + CLI

**公开仓库：cqu-moe/learning。规范版本 1.1；CLI 发行版本见 Releases。**

本分支实现共享 SDK 与本地 CLI；Web 尚未合入。1.1 文档保留初始 SDK/CLI 阶段的设计与证据，新任务以当前用户要求为准。实际能力与验证边界从[当前状态](docs/PROGRESS.md)进入。

CLI 提供 Windows、macOS、Linux 独立程序，直接下载运行，无需解压或安装 Node/Bun（macOS/Linux 下载后需 `chmod +x`）。访问 [Releases](https://github.com/cqu-moe/learning/releases)，按 [安装指南](docs/INSTALL.md) 下载、校验和初始化；第三方许可作为独立附件提供。源码开发继续使用固定 Node 24.11.1 / pnpm 11.19.0；发行流程见 [CLI 发布](docs/CLI-DISTRIBUTION.md)。

## 当前文件

| 文件 | 用途 |
|---|---|
| [SPEC](docs/SPEC.md) | 1.1 阶段设计基线；稳定架构契约按当前任务读取 |
| [SDK](docs/SDK.md) / [contracts](docs/contracts.d.ts) | SDK行为与接口声明，不是实现 |
| [PLATFORMS](docs/PLATFORMS.md) | 固定三平台协议与功能差异，范围没有随Web缩水 |
| [APPS](docs/APPS.md) | 当前CLI命令、本地任务与渲染、安装交付 |
| [PLAN](docs/PLAN.md) / [tasks.json](docs/tasks.json) | 1.1 阶段任务与验收记录，不是自动领取的新待办 |
| [ACCEPTANCE](docs/ACCEPTANCE.md) | 当前56组验收要求，不是已通过测试 |
| [HANDOFF](docs/HANDOFF.md) | 1.1 阶段交接背景，按需读取 |
| [PROGRESS](docs/PROGRESS.md) | 当前状态与逐任务证据索引 |
| [开发与验证](docs/agents/development.md) | 检查入口、源码证据、CI 等待和交付约定 |
| [SOURCES](docs/SOURCES.md) | 固定来源和本期E01–E08，未重查网页/平台 |
| [Web延期说明](docs/deferred/WEB.md) | 仅保留未来同仓/Cloudflare原生方向，不是可执行待办 |
| [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) | 本轮文档检查，不冒充产品测试 |
| [AGENTS](AGENTS.md) | 稳定约束与按任务读取的导航 |

## 开发交接

继续开发时先读 AGENTS、简短的 PROGRESS 索引和当前 Git 差异，再定位相关契约、源码与测试。详细记录按任务写入 `docs/progress/`，保留已有证据。

T00–T26/T31 和 T27–T30 延期属于原 1.1 阶段。新的 CLI、Web 或其他工作按用户明确范围推进；结束当前任务后，不自动执行历史计划中的下一项。

三个参考仓库需私有读取权限或只读checkout。离线工程工作不需要真实平台Cookie、模型Key或云密钥。真机和付费调用另行授权；编写代码不等于授权真实提交。
