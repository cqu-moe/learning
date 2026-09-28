# CLI 0.2 迁移说明

本次调整 CLI 的交互和输出，SDK 保持 0.1.0。已有命令名称保留，新增 `config show/set/unset`。平台能力、数据目录和不确定写入的核对要求不变。

## 交互和参数

- 裸跑 `learning` 选择一个操作，执行完退出。向导展示常用设置；指定子命令时只补必填项。
- 已传参数不重复询问，显式错误参数直接报错。输入途中取消不会被当成默认答案。
- TTY 中自动补问；CI、管道、重定向、`--no-interactive`、JSON 和 JSONL 模式不询问。
- 普通写操作先预览并确认；`--yes` 跳过普通确认。最终交卷仍单独要求 `--final` 或专门的交互确认，直播当前题也始终独立确认。
- `--quiet` 隐藏进度和导语，保留结果、警告、错误及确认所需的摘要；它不代表禁交互或同意执行。

```bash
learning
learning profile add --platform ykt
learning download --profile school
learning run COURSE --profile school --speed 1 --target 0.2 --dry-run
```

`COURSE` 是课程 URL 或已有 key，`school` 是用户创建的本地账号。向导按名称搜索选择，内部仍使用准确的 scope/ref。

## 输出格式

| 调用 | 行为 |
|---|---|
| 默认终端 | 中文向导、表格及局部刷新进度 |
| `--output-format plain` | 无 ANSI，编号/文本交互，适合屏幕阅读器 |
| `--json` 或 `--output-format json` | stdout 一行最终结果；包括失败结果 |
| `--output-format jsonl` | stdout 一行一个事件，最后恰好一个 result |
| `--no-color` 或 `NO_COLOR=1` | 关闭颜色；不替代 plain 或禁交互 |

全局用 `--output-format`，避免与 `slide --format pdf|images`、草稿 `--output <file>` 冲突。`--json` 与其他显式输出格式同时出现会报错。

旧 JSON payload 现在位于 `data`：

```json
{"schemaVersion":1,"command":"courses","ok":true,"status":"success","exitCode":0,"data":{"items":[]},"error":null,"warnings":[]}
```

`jobs list` 默认显示列表，机器输出为 `data.jobs`，不再直接输出数组。脚本必须检查 `ok`、`status` 和进程退出码；部分完成或不确定写入也可能带有有用的 data。错误有稳定的 code、fields、hint、operationId 和 retryAfterMs，message 是人类文案，不适合作脚本判断条件。

退出码：0 成功/只读预览；1 普通失败；2 参数错误；3 需登录、人工处理、确认或取消；4 部分失败；5 不确定写入。普通操作缺少 --yes 现在统一返回 3/CONFIRMATION_REQUIRED。

JSONL 包含 start/progress/warning/auth/question/gap/result。sequence 在本次调用中严格递增；sourceSequence 属于 SDK 的任务事件，不能混用。result.data 是上面的最终结果对象，实际业务 payload 因此在 result.data.data。SDK 可能合并进度事件，CLI 不补造历史。

机器消费者只解析 stdout。`--debug` 诊断以及 Node 自身的 SQLite ExperimentalWarning 可能出现在 stderr。强制结束、管道断开等情况下可能没有尾 result，必须将其当作中断，不能根据最后一个进度事件判断成功。

## 登录、偏好和恢复

机器模式扫码必须明确传 `--qr-file <新图片路径>`，或使用 `--import <Cookie文件>`。二维码文件权限 0600，退出后清理；JSONL auth 事件只带文件路径和到期信息，不带二维码原文、Cookie 或票据。单个 JSON 模式的外部调用方使用自己传入的图片路径。

```bash
learning login --profile school --import cookies.json --json
learning login --profile school --qr-file login.png --output-format jsonl
learning config set default-profile school
learning config set download-dir ./downloads
learning config show --json
learning config unset download-dir
```

偏好只在明确保存时改变。默认账号按稳定 ID 保存；临时 --profile 不修改默认账号。带有可靠 scope 的草稿、资源或 job 会使用其所属账号，显式冲突的 --profile 被拒绝。

`download`、`slide` 和 `exam export` 支持 `--output-dir`。每个任务仍使用唯一子目录，不覆盖已有文件。任务首次保存的导出目录供恢复使用，不随之后修改的偏好漂移。

Ctrl+C 请求在安全边界保存暂停状态。CLI 结果标 canceled、任务记录标 paused；不保证回滚已发生操作或立即中断不可取消请求。uncertain 优先保留，先核对再恢复：

```bash
learning jobs list
learning jobs show JOB
learning jobs resume JOB
learning jobs reconcile JOB
learning operations reconcile OPERATION
learning jobs cancel JOB --yes
```

## 打包与验证

CLI 和 SDK 版本不必相同。私有 tarball 消费者使用实际文件依赖；pnpm 11 的 overrides 配置放在 pnpm-workspace.yaml，不放 package.json.pnpm，见 [pnpm 官方说明](https://pnpm.io/package_json)。项目 E2E 已改为实际离线安装打包产物及精确依赖，不以指向开发仓库的依赖软链接代替安装。

真实 PTY 测试使用 Python 标准库，仅用于测试；生产 CLI 不需要 Python。界面验收不代表新增真实账号、考试、字体、硬工作片或多 GiB 磁盘测试证据。
