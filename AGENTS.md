# learning — 开发入口

共享 SDK 承担平台协议与公共业务；CLI 承担参数、输出和本机装配。先读[当前状态](docs/PROGRESS.md)及当前 Git 差异，再按任务读取下列文档。

## 稳定约束

- 一次完成用户指定的任务。1.1 阶段的 T00–T26/T31 与 Web 延期记录是历史范围；新阶段以用户明确要求为准，不从旧计划自动领取任务。
- 复用 SDK 的 provider 和 Runtime 边界；`public/root` 不传递导入 Node 实现、CLI 或浏览器渲染。依赖按真实用途加入，保留仓库现有分层。
- 保留 Cookie/profile scope、session generation、唯一导出路径和不确定写入记录。响应丢失不自动重交；无答案不代选，验证码留人工。
- 凭据、个人原始转储和字体留在本机安全文件或环境变量中，不提交到 Git/文档；参考仓库只读。真实平台操作、付费模型和发布按用户已有授权范围执行。
- 保留用户未提交内容与历史证据，不重置已完成任务。当前任务结束即停止，不自动扩大到其他平台或云部署。

## Agent CLI 契约（当前用户决定）

CLI 只面向软件 Agent，不提供人工向导、pretty/plain、quiet、颜色或交互开关。默认 stdout 输出 `schemaVersion: 1` 单 JSON envelope；仅 `--output-format json|jsonl` 可选，`--json` 是兼容别名。裸跑与命令组返回命令目录，`schema [path...]` 就近返回选项/参数/default/required；缺少必填参数直接返回错误 `fields`。平台真机操作和付费模型仍按上文授权，`--yes` 只是执行确认，不是权限来源。

配套 Skill 源码保存在 `skills/learning-cli/`，供安装到其他环境后使用；它只假设 `learning` 已安装，不假设本仓库路径。雨课堂普通作业下载/YAML/批量能力必须保留：下载需显式课程或资源 key，课程内全选用 `--all`；目录批量 apply 也需 `--all`。实时 CLI 只显式签到并监听事件，不提供直播答题提交入口；SDK `live.answer` 能力仍保留但必须单独授权和验证。详细契约见 `docs/adr/0003-agent-cli.md` 与 `docs/APPS.md`。

## 按任务读取

- 修改 SDK、DTO 或协议：读 [SDK](docs/SDK.md)、[契约](docs/contracts.d.ts)、相关 [平台说明](docs/PLATFORMS.md) 与 [固定来源](docs/SOURCES.md)。缺失源码只阻塞相关证据，不猜协议。
- 修改 CLI 行为：读 [使用说明](docs/USAGE.md)、[CLI 迁移](docs/CLI-MIGRATION.md) 和相关测试；[APPS](docs/APPS.md) 中的阶段设计以当前实现与新需求校对。
- 运行检查、准备 PR 或交付：读 [开发与验证](docs/agents/development.md)。命令与版本以 package.json、工具链文件和当前 CI 为准。
- 打包或发布 CLI：另读 [发行说明](docs/CLI-DISTRIBUTION.md)。五目标原生程序验收通过才发布；源码测试不能替代发行物验证。
- 新的 Web 任务：先读 [原延期说明](docs/deferred/WEB.md)，再按本次明确范围制定计划；本文件不会把历史延期当成拒绝新任务的依据。
- 查历史决策或验证：从 [进度索引](docs/PROGRESS.md) 定位相关任务记录，按需读取；不要默认通读全部历史。

完成任务后，将实际改动、验证命令/环境/退出码和未验证项写入 `docs/progress/<日期>-<任务>.md`，只在进度索引保留简短状态与链接。
