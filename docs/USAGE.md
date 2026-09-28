# learning 本机 CLI 用法

CLI 0.2 支持一次性向导与完整参数调用。直接运行 `learning`，或运行 `learning download --profile school` 补齐缺少的课程选择。脚本使用 `--no-interactive`、`--json` 或 `--output-format jsonl`。升级变化见 [迁移说明](CLI-MIGRATION.md)。

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
```

学习的雨课堂视频与图文、学堂视频及智慧树 share/hike 保存均有离线 fixture；图文只有 `leaf_info.finish` 读回为真才记完成。雨课堂内嵌题需要先对对应视频资源运行 `homework draft <resource-key> -o answer.yaml`，编辑后以 `homework apply answer.yaml --yes` 逐题提交；答错不会自动换答案，读回全部已解后使用 `jobs resume <job-id>` 继续原学习任务。智慧树默认 `login` 为微信纯 API 扫码，`login --variant native` 使用次级原生二维码；扫码后须运行 `whoami` 在线核验身份，未核验时写任务拒绝。导出写入 `LEARNING_HOME/exports/<job-id>/`，既有同名文件不会被覆盖。历史课件 PDF 不依赖浏览器；字体解码与旧课件受控浏览器仍缺。`doctor` 不自动安装浏览器。

学堂讨论用 `discuss draft <resource-key> -o draft.json` 创建可编辑文件；本机配置模型后可显式加 `--ai` 生成建议，缺 key 时手工草稿仍可用。`discuss post draft.json --dry-run` 预览，`--yes` 才发送。试卷可用 `exam export <resource-key>` 只读导出、`exam draft <resource-key> -o draft.yaml` 建草稿；`exam start <resource-key> --yes` 可能启动计时，`exam save draft.yaml --yes` 只缓存已验证的选择/判断答案。`exam submit` 即使带 `--yes --final` 也因 E05 验证闸门拒绝。`live <lesson-url> --yes` 在当前终端监听；当前题的手工答案会再次要求逐题确认，`jobs resume <id> --yes` 会重新签到并标记离线 gap。真实平台操作需单独授权；本轮仅在离线合成响应中运行这些写链。

任务默认在当前终端运行，Ctrl+C 请求暂停并释放本机写锁。响应丢失造成的 `uncertain` 任务不能直接 resume；先用 `jobs reconcile <job-id>` 只读核对。确认原 PID 已退出后才可 `profile unlock` 清理遗留锁。升级前备份整个 `LEARNING_HOME`，尤其是 `master.key`、SQLite 状态库和 `artifacts`。

默认账号和下载目录仅显式保存：`learning config set default-profile school`、`learning config set download-dir ./downloads`。`--output-dir` 覆盖本次导出目录，`--quiet` 隐藏日常进度但不跳过确认。
