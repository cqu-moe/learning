# Agent CLI 迁移说明

本次将 CLI 收敛为 Agent 专用接口：删除人工向导和 TTY 判断，保留命令名、数据目录、profile scope、任务恢复和 uncertain 不重交规则。SDK API 不因 CLI 迁移而移除。

## 参数和确认

- 裸跑 `learning` 与命令组返回命令目录；`learning schema [path...]` 就近返回参数、选项、default、required 与 choices，不创建数据目录。
- 缺少必填参数不触发补问，直接 exit 2/`INVALID_INPUT`，错误 `fields` 指向缺失项。
- `profile add` 继续使用 `learning profile add <name> --platform ykt|xuetang|zhs`；没有 `--name`。
- 普通写操作用 `--dry-run` 取预览，或 `--yes` 执行；`--yes` 不是真实平台操作授权。
- `exam submit` 仍需 `--yes --final`，且未验证题型/能力会被 SDK 闸门拒绝。
- `run` 必须显式传课程或资源 key，默认 `--speed 1 --target 1`；平台按各自上限限速，未知答案暂停。
- `courses` 返回单 profile 列表及 completeness；`--all-profiles` 聚合全部 profile。SDK 尚未实现课程 cursor 分页，CLI 不暴露无效参数，不能把 unknown 完整性当作全量结果。
- `homework download <course-or-resource>` 必须显式给 key，课程内全选用 `--all`；`homework apply` 传目录时也必须加 `--all`。

```bash
learning
learning init
learning profile add school --platform ykt
learning download COURSE --profile school --dry-run
learning run COURSE --profile school --speed 1 --target 0.2 --dry-run
```

`COURSE` 是课程 URL 或已缓存 key，`school` 是用户创建的本地账号；scope/ref 以 CLI 返回和本地缓存为准。

## 输出格式

| 调用 | 行为 |
|---|---|
| 默认 | stdout 一行最终结果；包括失败结果 |
| `--json` 或 `--output-format json` | 显式选择默认单 JSON envelope |
| `--output-format jsonl` | stdout 一行一个事件，最后恰好一个 result |
| `pretty/plain/quiet/no-color/no-interactive` | 已移除；作为无效输入返回 exit 2 |

全局用 `--output-format`，避免与 `slide --format pdf|images`、草稿 `--output <file>` 冲突。`--json` 可与显式 json 等价使用，但不能与 jsonl 混用。

旧 JSON payload 现在位于 `data`：

```json
{"schemaVersion":1,"command":"courses","ok":true,"status":"success","exitCode":0,"data":{"items":[]},"error":null,"warnings":[]}
```

`jobs list` 的列表固定在 `data.jobs`，不再直接输出数组。脚本必须检查 `ok`、`status` 和进程退出码；部分完成或不确定写入也可能带有有用的 data。错误有稳定的 code、fields、hint、operationId 和 retryAfterMs，message 是人类文案，不适合作脚本判断条件。

退出码：0 成功/只读预览；1 普通失败；2 参数错误；3 需登录、人工处理、确认或取消；4 部分失败；5 不确定写入。普通执行缺少 `--yes` 返回 3/`CONFIRMATION_REQUIRED`；首次平台操作授权来自用户明确指令或既有授权。

JSONL 包含 start/progress/warning/auth/question/gap/result。sequence 在本次调用中严格递增；sourceSequence 属于 SDK 的任务事件，不能混用。result.data 是上面的最终结果对象，实际业务 payload 因此在 result.data.data。SDK 可能合并进度事件，CLI 不补造历史。

Node 运行时警告、console.warn、SDK 警告统一进入 warning 通道：JSON 收入最终 warnings，JSONL 另发 warning 事件；相同 code/message 在一次调用内合并。stderr 不打印业务输出，仅 `--debug` 脱敏诊断和后发遥测诊断警告。强制结束、管道断开等情况下可能没有尾 result，必须将其当作中断，不能根据最后一个进度事件判断成功。

错误处理约定：exit 2 先按 `error.fields` 和 `learning schema` 修参数；exit 3 处理登录或人工步骤；exit 4 检查 skipped/partial 项；exit 5 先 reconcile。未获得权威结果前不得报告平台提交成功。

## 登录、偏好和恢复

JSON 模式扫码必须明确传 `--qr-file <新图片路径>`；JSONL 可自动生成新路径，或使用 `--import <Cookie文件>`。二维码文件权限 0600，退出后清理；auth 事件只带路径、generation 和期限，不带二维码原文、Cookie 或票据。

```bash
learning login --profile school --import cookies.json --json
learning login --profile school --qr-file login.png --output-format jsonl
learning config set default-profile school
learning config set download-dir ./downloads
learning config show --json
learning config unset download-dir
```

偏好只在明确保存时改变。默认账号按稳定 ID 保存；临时 --profile 不修改默认账号。带有可靠 scope 的草稿、资源或 job 会使用其所属账号，显式冲突的 --profile 被拒绝。

`download`、`homework download`、`slide` 和 `exam export` 支持 `--output-dir`。每个任务仍使用唯一子目录，不覆盖已有文件。任务首次保存的导出目录供恢复使用，不随之后修改的偏好漂移。

`live <lesson-url>` 已移除终端作答入口：`--dry-run` 只生成签到预览，`--yes` 显式签到并监听 question/gap 事件。SDK `live.answer` 仍保留，未来接入必须另行验证并授权。

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

CLI 验收使用进程级 JSON/JSONL 输出和信号/锁行为检查；界面验收不代表新增真实账号、考试、字体、硬工作片或多 GiB 磁盘测试证据。
