# learning — SDK + CLI

**公开仓库：cqu-moe/learning。规范版本 1.1；CLI 发行版本见 Releases。**

本仓库包含共享 SDK、本地 CLI 和本地 React Web 仪表盘。Web UI 复用 CQU Moe Design，支持本机账号、课程浏览、任务发起与恢复；启动与边界见 [Web UI](apps/web/README.md)。云端部署仍延期。SDK/CLI 开发规范沿用 1.1，实际能力与未完成的真机验收见 [功能状态](docs/FEATURE-STATUS.md) 和 [进度](docs/PROGRESS.md)。

CLI 提供 Windows、macOS、Linux 独立程序，直接下载运行，无需解压或安装 Node/Bun（macOS/Linux 下载后需 `chmod +x`）。访问 [Releases](https://github.com/cqu-moe/learning/releases)，按 [安装指南](docs/INSTALL.md) 下载、校验和初始化；第三方许可作为独立附件提供。源码开发继续使用固定 Node 24.11.1 / pnpm 11.19.0；发行流程见 [CLI 发布](docs/CLI-DISTRIBUTION.md)。

## 当前文件

| 文件 | 用途 |
|---|---|
| [SPEC](docs/SPEC.md) | SDK/CLI 基线与 Web UI 范围补充 |
| [SDK](docs/SDK.md) / [contracts](docs/contracts.d.ts) | SDK行为与接口声明，不是实现 |
| [PLATFORMS](docs/PLATFORMS.md) | 固定三平台协议与功能差异，范围没有随Web缩水 |
| [APPS](docs/APPS.md) | 当前CLI命令、本地任务与渲染、安装交付 |
| [PLAN](docs/PLAN.md) / [tasks.json](docs/tasks.json) | 当前任务 U01/U02 与已完成的 T00–T26/T31 |
| [ACCEPTANCE](docs/ACCEPTANCE.md) | 当前56组验收要求，不是已通过测试 |
| [HANDOFF](docs/HANDOFF.md) | 首次、继续、迁移、纠偏和复核提示词 |
| [PROGRESS](docs/PROGRESS.md) | 实际进度模板；已有记录时合并而非覆盖 |
| [SOURCES](docs/SOURCES.md) | 固定来源和本期E01–E08，未重查网页/平台 |
| [Web延期说明](docs/deferred/WEB.md) | 仅保留未来同仓/Cloudflare原生方向，不是可执行待办 |
| [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) | 本轮文档检查，不冒充产品测试 |
| [AGENTS](AGENTS.md) | 当前授权范围、SDK 边界与工程约束 |

## 开发交接

继续开发时先读 AGENTS、SPEC 和 PROGRESS，按 HANDOFF 的继续/复核提示执行；合并已有进度，不能覆盖 PROGRESS 或删除已写文件。旧文档移出模型活动上下文。

原 SDK/CLI 1.1 阶段为 T00–T26 与 T31。当前用户授权的本地 Web 工作按 U01/U02 和 [Web UI 范围](docs/WEB-UI.md) 执行；云端部署与原生封装仍延期，不要求云账号或 Docker。

三个参考仓库需私有读取权限或只读checkout。离线工程工作不需要真实平台Cookie、模型Key或云密钥。真机和付费调用另行授权；编写代码不等于授权真实提交。
