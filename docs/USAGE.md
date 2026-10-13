# learning 本机 CLI 用法

直接运行 `learning` 进入菜单，每次操作后返回首页；也可用 `learning run --profile school` 选择课程并启动学习。脚本使用 `--no-interactive`、`--json` 或 `--output-format jsonl`。升级变化见 [迁移说明](CLI-MIGRATION.md)。

构建后在仓库根目录运行 `node apps/cli/dist/index.js`，或将构建后的 CLI 以本机链接方式暴露为 `learning`。下例省略 `node apps/cli/dist/index.js` 前缀。

```bash
learning --home ~/.learning init
learning --home ~/.learning profile add school --platform ykt
learning --home ~/.learning --profile school login
learning --home ~/.learning --profile school whoami --json
learning --home ~/.learning --profile school courses --json
learning --home ~/.learning --profile school outline <course-key> --json
```

`--home` 可放在命令前后；省略时使用 `LEARNING_HOME`，再回退到 `~/.learning`。多账号可明确保存默认账号，否则非交互调用须传 `--profile`；带有可靠所属账号的 job/草稿使用其 scope。`--json` 在 stdout 输出一个结果 envelope，业务数据位于 `data`；`jobs list` 列表位于 `data.jobs`。机器扫码需 `--qr-file`，不会隐式等待输入。Cookie 导入只接受本机常规 JSON 文件：`learning --profile school login --import <file>`，导入后身份仍未验证。

```bash
learning --profile school download <course-or-resource-key> --types video --dry-run
learning --profile school download <course-or-resource-key> --types video,homework,exam
learning --profile school slide 'https://www.yuketang.cn/lesson?lesson_id=9000' --format pdf
learning --profile school homework draft <resource-key> -o draft.yaml
learning --profile school homework apply draft.yaml --dry-run
learning --profile school homework apply draft.yaml --yes
learning --profile school answers match draft.yaml --source feedback.json -o matched.yaml
learning --profile school run <course-or-resource-key> --speed 1 --target 0.91 --dry-run
learning --profile school run <course-or-resource-key> --speed 1 --target 0.91 --yes
learning --profile school jobs list
learning --profile school jobs show <job-id>
learning --profile school jobs resume <job-id>
learning --profile school jobs cancel <job-id>
learning --profile school jobs reconcile <job-id>
learning --profile school operations reconcile <operation-id>
learning telemetry status
learning telemetry off
```

学习的雨课堂视频与图文、学堂视频及智慧树 share/hike 保存均有离线 fixture；图文只有 `leaf_info.finish` 读回为真才记完成。雨课堂内嵌题需要先对对应视频资源运行 `homework draft <resource-key> -o answer.yaml`，编辑后以 `homework apply answer.yaml --yes` 逐题提交；答错不会自动换答案，读回全部已解后使用 `jobs resume <job-id>` 继续原学习任务。智慧树默认 `login` 为微信纯 API 扫码，`login --variant native` 使用次级原生二维码；扫码后须运行 `whoami` 在线核验身份，未核验时写任务拒绝。导出写入 `LEARNING_HOME/exports/<job-id>/`，既有同名文件不会被覆盖。历史课件 PDF 不依赖浏览器；字体解码与旧课件受控浏览器仍缺。`doctor` 不自动安装浏览器。

学堂讨论用 `discuss draft <resource-key> -o draft.json` 创建可编辑文件；本机配置模型后可显式加 `--ai` 生成建议，缺 key 时手工草稿仍可用。`discuss post draft.json --dry-run` 预览，`--yes` 才发送。试卷可用 `exam export <resource-key>` 只读导出、`exam draft <resource-key> -o draft.yaml` 建草稿；`exam start <resource-key> --yes` 可能启动计时，`exam save draft.yaml --yes` 只缓存已验证的选择/判断答案。`exam submit` 即使带 `--yes --final` 也因 E05 验证闸门拒绝。`live <lesson-url> --yes` 在当前终端监听；当前题的手工答案会再次要求逐题确认，`jobs resume <id> --yes` 会重新签到并标记离线 gap。真实平台操作需单独授权；本轮仅在离线合成响应中运行这些写链。

任务默认在当前终端运行，Ctrl+C 请求暂停并释放本机写锁。响应丢失造成的 `uncertain` 任务不能直接 resume；先用 `jobs reconcile <job-id>` 只读核对。确认原 PID 已退出后才可 `profile unlock` 清理遗留锁。升级前备份整个 `LEARNING_HOME`，尤其是 `master.key`、SQLite 状态库和 `artifacts`。

匿名使用统计默认开启，首次提示只写入 stderr；`telemetry off/on` 持久保存于 `LEARNING_HOME/telemetry.json`。命令遥测与任务遥测分开：命令使用静态命令路径和一次进程结果，任务使用稳定 `job.id` 作为 `operation_id`，每次前台恢复/重试另用随机 `attempt_id`，起止事件成对关联且未确认的任务状态不伪造终态。允许字段限于平台、系统/运行时、版本、资源计数、警告码和结果；不采集参数、课程/资源标题、账号身份、路径、终端输出、异常原文或 SDK JobEvent 原文。发送失败或关闭统计不影响业务输出和退出码。

| 事件 | 字段 |
| --- | --- |
| `cli_command_started` | 共同字段 + `operation_id`、`duration_basis=cli_process` |
| `cli_command_completed` | 共同字段 + 同一 `operation_id`、`outcome`、`exit_code`、`error_code`、`duration_ms`、`duration_basis=cli_process` |
| `learning_job_started` | 共同字段 + 逻辑任务 `operation_id=job_id=job.id`、本次 `attempt_id`、`platform`、`job_kind`、`total_count`、`duration_basis=foreground_attempt` |
| `learning_job_completed` | 共同字段 + 同一 `operation_id` / `attempt_id`、`platform`、`job_kind`、`job_id`、`outcome`、资源与 artifact 计数、最多 8 个 `warning_codes`、`duration_ms`、`duration_basis=foreground_attempt` |

共同字段为 `telemetry_version=2`、`product=learning`、`surface=cli`、`environment=production|development|test`、`release` / `cli_version`、`actor_type=installation`、`trigger=user`、`operation`、`is_test`、`runtime=node|bun`、`runtime_version`、`os`、`arch`。命令 `outcome` 是 `success|failure|partial|canceled|needs_input|unverified`；任务 `outcome` 同枚举，其中 warning `SKIPPED_UNKNOWN_DURATION` 导致的成功按 `partial`，`uncertain` 按 `unverified`，Ctrl+C 暂停按 `canceled`。逻辑任务按 `operation_id` 去重，恢复/重试按 `attempt_id` 分开；开始后没有权威终态不补发完成事件。

学习默认选择整门课程。启动前显示课程名称、账号、资源数量、倍速和目标进度，确认后才开始。单个资源可通过命令参数指定，使用 `learning run --help` 查看。需要资源 key 时运行 `learning outline <course-key>`，或读取 JSON 输出。

交互终端使用 `cli-progress` 固定显示整课和当前视频两条进度条，每 100 毫秒刷新。课程名加粗，整课条显示已完成资源数，视频条显示播放比例；下方保留播放时间、平台确认进度和已用时间。颜色分别为绿色与青色，`--no-color` 或 `NO_COLOR` 关闭配色，窄终端自动缩短进度条和标题。`本地估计` 只用于显示等待期间的计时，最多推算到下一次计划更新；平台确认进度始终来自读回。无法读取的时长或进度保持未知。普通文本输出按阶段和间隔记录，JSON/JSONL 保留机器协议；`--quiet` 关闭日常进度。

雨课堂未播放过的视频有时不返回时长。CLI 会先读取进度和资源信息，再尝试用本机 `ffprobe` 读取视频文件的真实时长；没有安装该工具也可以运行。仍无法读取时，预览显示“暂不处理”及视频名称（最多 5 条），可在官方网页播放后重试。这些视频不会标记完成；如果其余计划全部完成，命令仍以 `partial` / 退出码 4 提醒有遗漏，`--yes` 也保留警告。

默认账号和下载目录仅显式保存：`learning config set default-profile school`、`learning config set download-dir ./downloads`。`--output-dir` 覆盖本次导出目录，`--quiet` 隐藏日常进度但不跳过确认。
