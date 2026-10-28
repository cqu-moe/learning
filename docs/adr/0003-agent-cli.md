---
status: accepted
date: 2026-10-28
---

# CLI 改为 Agent 专用机器接口

## 背景

CLI 0.2 同时维护人工向导、pretty/plain 输出、交互补参和机器 JSON/JSONL，协议分支多且难以可靠测试。实际调用方是软件 Agent；人工仅处理扫码、验证码和授权等必须由本人完成的步骤。用户已确认删除人工 UI，并保留从 `homework-content` 复制的雨课堂普通作业下载/YAML/批量能力。

## 决策

- CLI 不判断 TTY，不提供向导、交互补参、pretty/plain、quiet、颜色或 no-interactive 开关。
- 默认 stdout 输出一个 `schemaVersion: 1` JSON envelope；仅提供 `--output-format json|jsonl`，`--json` 作为兼容别名。
- 裸跑与命令组返回命令目录；`schema [path...]` 从实际 Commander 注册树就近返回参数、选项、default、required 与 choices；`--help/--version` 成功并把文本放在 `data.text`。
- 缺少必填参数直接返回 exit 2，错误 `fields` 指向参数名；`profile add` 继续使用 `<name> --platform`。
- 常规写操作使用 `--dry-run/--yes`；交卷仍需 `--yes --final` 并受 SDK 未验证闸门限制。
- `run` 默认 speed 1、target 1，实际限速由平台能力决定；未知答案暂停，不猜第一项。
- 扫码二维码必须写入 JSON 模式显式 `--qr-file` 新路径，或由 JSONL 自动生成新路径；auth 事件只暴露路径、generation 与期限，退出时清理文件。
- `live` 只支持显式签到预览/签到和 question/gap 事件监听。SDK `live.answer` 保留，但 CLI 不提供直播答题提交入口，未来接入需单独实现、验证和授权。
- 保留 LEARNING_HOME、profile scope、session generation、本机写锁、任务恢复、唯一导出路径和 uncertain 不重交规则。
- 雨课堂普通作业保留：`homework download <course-or-resource>` 显式选择，课程全选用 `--all`；`homework apply` 支持单文件，目录批量必须 `--all`。
- `courses` 保留 SDK 返回的 completeness；`--all-profiles` 聚合全部 profile。不暴露 SDK 尚未实现的课程 cursor 分页。

## 后果

调用方必须先通过命令目录/schema 发现接口，并显式提供全部必填参数；不能再依赖菜单或帮助文本补参。stdout 可稳定解析，stderr 只承载 `--debug` 诊断和后发诊断警告。首次遥测告知进入 result warnings 的 `TELEMETRY_NOTICE`，遥测共同字段为 `trigger=agent`。

人工用户仍可在官方平台完成扫码、验证码和必要核验。CLI 不把 `--yes` 当作平台操作授权；真实平台访问、写入和付费模型调用仍需用户明确授权，已授权操作不重复确认。
