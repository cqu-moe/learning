# learning 本机 CLI 用法

`learning` 是 Agent 专用 CLI，不判断 TTY、不进入人工向导、不交互补参。默认 stdout 输出一个 `schemaVersion: 1` JSON envelope；`--output-format jsonl` 输出按序事件并以 result 结束。`--json` 只是 `--output-format json` 的兼容别名，不能再与显式 jsonl 混用。

裸跑 `learning` 和命令组返回命令目录；`learning schema <command...>` 就近查询参数、选项、默认值和必填状态。开始前先运行 `learning doctor`。所有真实平台操作和付费模型调用都需要用户明确授权；用户已在会话中授权的操作不重复确认，`--yes` 本身不产生授权。

构建后在仓库根目录运行 `node apps/cli/dist/index.js`，或将构建后的 CLI 以本机链接方式暴露为 `learning`。下例省略 `node apps/cli/dist/index.js` 前缀。

```bash
learning --home ~/.learning init
learning --home ~/.learning profile add school --platform ykt
learning --home ~/.learning --profile school login --output-format jsonl
learning --home ~/.learning --profile school whoami --json
learning --home ~/.learning --profile school courses --json
learning --home ~/.learning --profile school outline <course-key> --json
learning schema homework download
learning doctor
```

`--home` 可放在命令前后；省略时使用 `LEARNING_HOME`，再回退到 `~/.learning`。多账号可明确保存默认账号，否则须传 `--profile`；带有可靠所属账号的 job/草稿使用其 scope。业务数据位于 `data`；`jobs list` 列表位于 `data.jobs`。JSON 模式扫码需 `--qr-file`，JSONL 可自动生成二维码文件；两者都不会隐式等待输入。Cookie 导入只接受本机常规 JSON 文件：`learning --profile school login --import <file>`，导入后身份仍未验证。

```bash
learning --profile school download <course-or-resource-key> --types video --dry-run
learning --profile school download <course-or-resource-key> --types video,homework,exam
learning --profile school slide 'https://www.yuketang.cn/lesson?lesson_id=9000' --format pdf
learning --profile school homework download <course-key> --all --output-dir ./homework
learning --profile school homework apply ./homework --all --dry-run
learning --profile school homework apply ./homework --all --yes
learning --profile school homework draft <resource-key> -o draft.yaml
learning --profile school homework apply draft.yaml --dry-run
learning --profile school homework apply draft.yaml --yes
learning --profile school answers match draft.yaml --source feedback.json -o matched.yaml
learning --profile school run <course-or-resource-key> --speed 1 --target 0.91 --dry-run
learning --profile school run <course-or-resource-key> --speed 1 --target 0.91 --yes
learning --profile school jobs list
learning --profile school jobs show <job-id>
learning --profile school jobs resume <job-id>
learning --profile school jobs cancel <job-id> --yes
learning --profile school jobs reconcile <job-id>
learning --profile school operations reconcile <operation-id>
learning telemetry status
```

雨课堂普通作业必须运行 `homework download <course-or-resource>` 并显式提供 key；课程内下载全部作业时加 `--all`。下载生成 `题面.md`、`assets/` 图片和 `answers.yaml`，按账号/课程/章节/作业归档。答案写在 YAML 顶部，单选填 `A`、多选填 `[A, C]`、判断填 `正确` / `错误`、填空填文本列表；保留 `null` 表示未答。底部校验信息由程序维护。重新下载保留草稿，题目变化另存 `.v2` 等版本，不迁移旧答案。`apply` 可传单份草稿或包含多份 `answers.yaml` 的目录；目录必须加 `--all`，预览显示题干、选项及准备提交的答案；`--dry-run` 不发送答案。旧 `homework draft/apply` 和旧 learning 草稿继续可用。

普通作业首次遇到混淆字体时，CLI 自动下载固定 SHA-256 的 Noto Sans CJK SC Regular 2.004（约 16 MiB，SIL OFL 1.1），缓存在 `LEARNING_HOME/cache/fonts/`。后续校验并复用，不需 Python、Canvas 或浏览器。缺字、缺图会在题面标出并隔离对应题目；其他完整题仍可预览提交。部分完成退出码为 4；提交响应丢失为 5，停止后续发送并保留待核对操作。字体样本、支持的图片/公式范围与验收边界见 [雨课堂作业说明](YKT-HOMEWORK.md)。

学习的雨课堂视频与图文、学堂视频及智慧树 share/hike 保存均有离线 fixture；图文只有 `leaf_info.finish` 读回为真才记完成。雨课堂内嵌题需要先对对应视频资源运行 `homework draft <resource-key> -o answer.yaml`，编辑后以 `homework apply answer.yaml --yes` 逐题提交；答错不会自动换答案，读回全部已解后使用 `jobs resume <job-id>` 继续原学习任务。智慧树默认 `login` 为微信纯 API 扫码，`login --variant native` 使用次级原生二维码；扫码后须运行 `whoami` 在线核验身份，未核验时写任务拒绝。其他导出仍写入 `LEARNING_HOME/exports/<job-id>/`。历史课件 PDF 不依赖浏览器；受控旧页面浏览器仍缺。`doctor` 不自动安装浏览器。

学堂讨论用 `discuss draft <resource-key> -o draft.json` 创建可编辑文件；本机配置模型后可显式加 `--ai` 生成建议，缺 key 时手工草稿仍可用。`discuss post draft.json --dry-run` 预览，`--yes` 才发送。试卷可用 `exam export <resource-key>` 只读导出、`exam draft <resource-key> -o draft.yaml` 建草稿；`exam start <resource-key> --yes` 可能启动计时，`exam save draft.yaml --yes` 只缓存已验证的选择/判断答案。`exam submit` 即使带 `--yes --final` 也因 E05 验证闸门拒绝。`live <lesson-url> --dry-run` 只出签到预览，`--yes` 显式签到并监听 question/gap 事件；CLI 不提供直播答题提交入口，SDK `live.answer` 仍存在但需单独授权与验证。`jobs resume <id> --yes` 会重新签到并标记离线 gap。真实平台操作需单独授权；本轮仅在离线合成响应中运行这些写链。

任务默认在当前前台进程运行，SIGINT/SIGTERM 请求暂停并释放本机写锁。响应丢失造成的 `uncertain` 任务不能直接 resume；先用 `jobs reconcile <job-id>` 只读核对。确认原 PID 已退出后才可 `profile unlock` 清理遗留锁。升级前备份整个 `LEARNING_HOME`，尤其是 `master.key`、SQLite 状态库和 `artifacts`。

匿名使用统计及脱敏错误诊断默认开启，首次告知进入最终 envelope 的 `warnings`，code 为 `TELEMETRY_NOTICE`；后续诊断类警告以单行 JSON 写入 stderr。`telemetry status` 查看状态，`LEARNING_HOME/telemetry.json` 只保留安装标识与提示时间，不提供关闭功能。命令使用静态命令路径和一次进程结果；任务使用稳定 `job.id` 作为 `operation_id`，每次前台恢复/重试另用随机 `attempt_id`，未确认的任务状态不伪造终态。统计字段限于平台、系统/运行时、版本、资源计数、警告码和结果；错误事件另外保留真实类型、脱敏限长消息、堆栈与 cause，以及出错阶段、HTTP 状态、响应大小和结构校验位置。命令失败、恢复/重试、任务子项和进程未捕获异常均记录，同一异常传播去重，主动取消不算故障。凭据、已知账号/参数值、URL 查询及本机路径会脱敏；不上传完整请求/响应正文、题目答案、终端输出或 SDK JobEvent 原文。业务事件与 `$ai_generation` 共用匿名身份和批量通道；AI 只发送模型、耗时、用量与结果，不发送提示词、回答和模型 URL。错误先在 `diagnostic-outbox` 限量暂存，成功接收后删除，失败后补传；具体容量和保留期限见 INSTALL。发送失败不影响业务结果或退出码。

| 事件 | 字段 |
| --- | --- |
| `cli_command_started` | 共同字段 + `operation_id`、`duration_basis=cli_process` |
| `cli_command_completed` | 共同字段 + 同一 `operation_id`、`outcome`、`exit_code`、`error_code`、`duration_ms`、`duration_basis=cli_process` |
| `learning_job_started` | 共同字段 + 逻辑任务 `operation_id=job_id=job.id`、本次 `attempt_id`、`platform`、`job_kind`、`total_count`、`duration_basis=foreground_attempt` |
| `learning_job_completed` | 共同字段 + 同一 `operation_id` / `attempt_id`、`platform`、`job_kind`、`job_id`、`outcome`、资源与 artifact 计数、最多 8 个 `warning_codes`、`duration_ms`、`duration_basis=foreground_attempt` |
| `$exception` | 共同字段 + 命令 `operation_id`、可用的 `job_id` / `attempt_id`、`error_code`、真实 `$exception_list`、fingerprint、诊断与阶段上下文；无原始堆栈时明确标记缺失 |

共同字段为 `telemetry_version=2`、`product=learning`、`surface=cli`、`environment=production|development|test`、`release` / `cli_version`、`actor_type=installation`、`trigger=agent`、`operation`、`is_test`、`runtime=node|bun`、`runtime_version`、`os`、`arch`。命令 `outcome` 是 `success|failure|partial|canceled|needs_input|unverified`；任务 `outcome` 同枚举，其中 warning `SKIPPED_UNKNOWN_DURATION` 导致的成功按 `partial`，`uncertain` 按 `unverified`，SIGINT 暂停按 `canceled`。逻辑任务按 `operation_id` 去重，恢复/重试按 `attempt_id` 分开；开始后没有权威终态不补发完成事件。

直接调用 `run` 必须提供课程或资源 key。默认 `--speed 1 --target 1`；`--dry-run` 返回 SDK 操作预览，包括 scope、description、blockers 和 warnings，`--yes` 才开始。需要资源 key 时运行 `learning outline <course-key>` 并读取 JSON 输出。

JSONL `progress` 事件报告任务、资源、完成数、总数、平台确认进度和必要的本地估计。无法读取的时长或进度保持未知，不从本地等待时间推导完成。stdout 不输出 ANSI 控制字符；诊断与后发遥测警告在 stderr。

雨课堂未播放过的视频有时不返回时长。CLI 会先读取进度和资源信息，再尝试用本机 `ffprobe` 读取视频文件的真实时长；没有安装该工具也可以运行。仍无法读取时，预览的 warnings 返回 `SKIPPED_UNKNOWN_DURATION` 及对应资源 key。这些视频不会标记完成；如果其余计划全部完成，命令仍以 `partial` / 退出码 4 提醒有遗漏，`--yes` 也保留警告。

默认账号和下载目录仅显式保存：`learning config set default-profile school`、`learning config set download-dir ./downloads`。`--output-dir` 覆盖本次导出目录。
