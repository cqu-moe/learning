# learning — 当前状态与证据索引

本页只保留简短状态和入口。实际分支、版本、CI 和平台状态在需要时从所属配置或服务核实；历史验证不自动证明当前状态。

## 已合入的最近工作

- CLI 错误诊断、源码堆栈和 0.2.10 发行：[PR #27](https://github.com/cqu-moe/learning/pull/27)。随后修复了脱敏性能与 Windows 发行清单：[PR #28](https://github.com/cqu-moe/learning/pull/28)、[PR #29](https://github.com/cqu-moe/learning/pull/29)。具体验证环境与缺口见历史记录末尾。
- [PR #30](https://github.com/cqu-moe/learning/pull/30) 已合入 Agent 专用 CLI、配套 Skill 和普通作业流程；[实现、审查与验证记录](progress/2026-10-28-agent-cli.md)已按任务归档。Web 不据此判定为已合入；当前任务以用户明确要求及分支差异为准。
- 真实平台、付费模型和真实遥测入库的验收逐任务列明。[功能状态表](FEATURE-STATUS.md)使用前与当前代码和相关任务记录核对。

## 本次工作

- [2026-10-28：源码校验门禁与 Agent 文档整理](progress/2026-10-28-retro-guardrails.md)。

## 按需查阅

- [开发与验证](agents/development.md)：现有检查、源码证据、CI 等待与交付约定。
- [发行流程](CLI-DISTRIBUTION.md)、[安装](INSTALL.md)、[使用](USAGE.md)。
- [截至 2026-10-27 的完整历史](progress/2026-10-27-history.md)：原 PROGRESS 原样保留；按日期、任务名或 PR 号定位，不默认通读。
- [原 1.1 计划](PLAN.md)与[验收设计](ACCEPTANCE.md)：阶段背景与契约参考，不是自动执行队列。

新增任务在 `docs/progress/<日期>-<任务>.md` 记录改动、实际命令/环境/退出码、未验证项及后续状态；本页只增加链接和必要的状态变化。
