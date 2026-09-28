# CLI 使用体验设计

日期：2026-09-28。状态：产品方向已确认，CLI 0.2 已实现并完成独立评审修复；实际证据见 PROGRESS。
基线：`bbb4a3dfcb63ff34ec0f19ffdfafac5ce141f287`。本文是 SPEC/APPS 1.1 的 CLI 体验补充，不重启旧版计划，不改变 SDK 平台能力与验收状态。

## 1. 用户已确认的决定

1. 裸跑 `learning` 进入一次性向导，完成一个操作后退出。
2. 裸跑展示常用可选设置；指定子命令只补必填项，展示最终采用的设置。显式参数不再询问。
3. 终端自动补问；JSON、JSONL、CI、非交互环境、`--no-interactive` 禁止询问，缺参明确失败。
4. 显式错误参数报错并给修正建议；向导里输入错误原地重填，不替用户纠正目标。
5. 需要确认的写操作预览后确认一次；`--yes` 仅跳过普通确认，既有特殊确认继续保留。
6. 提供漂亮终端、简洁文本、JSON 最终结果、JSONL 实时事件和 `--quiet`。
7. 人类文案中文，命令/参数/机器字段/错误码英文；业务原文不强制翻译。
8. 偏好明确保存才生效，显式参数优先，不自动记住临时选择。
9. 保留滚动记录，局部刷新进度，不做全屏 TUI。
10. 允许调整不合理的参数和 JSON 结构，必须提供迁移说明。

## 2. 范围与源码证据

当前 CLI 依赖 Commander 15.0.0 与 qrcode 1.5.4；context.ts 只有 readline 账号编号选择与两种输出；index.ts 统一 catch 之外，各命令仍直接写 stdout/stderr。run/download 有 job 驱动，没有持续终端进度。SDK 已提供 state/progress/question/gap 事件，进度含 serverFraction/estimatedSeconds，不含连续下载字节事件。

当前共有 30 条叶子命令。现有 e2e 的 28 条帮助注册检查漏了 `exam draft` 和 `operations reconcile`。这轮覆盖全部现有命令，另加偏好管理三个子命令。不新增平台协议、学习策略、考试能力、daemon、Web 或云部署。不借 UI 改造宣布原先 partial 的业务能力完成。

CLI 继续调用同一 SDK；菜单选择与命令行参数必须汇入相同的命令 handler。生产代码不引入 Python。本文中的考试交互只改既有入口及离线验证；禁止任何真实考试读取、开卷、缓存或交卷测试。

## 3. 库选择

| 组件 | 决定 | 实施时检查 |
|---|---|---|
| Commander | 保留 15.0.0 | 全局参数位置、来源追踪、错误捕获与中文帮助 |
| @clack/prompts | 新增，负责漂亮提示、搜索选择、确认、spinner/进度 | 查发布版而非只看 main 文档；必须兼容 Node 24.11.1，精确锁定版本 |
| cli-table3 | 课程/账号/任务表格需要列宽和换行时引入 | 精确版本、ESM 导入、中文宽度与窄屏测试 |
| node:util.styleText | 使用基础命名颜色及终端检测 | 不采用晚于 Node 24.11.1 才新增的 API |
| node:readline/promises | 保留作 plain 模式的编号/文本输入 | 不输出 ANSI，不关闭用户终端后继续等待 |
| Zod | CLI 直接声明 4.6.5，用于新的 CLI DTO 与偏好 | 复用现有版本，所有 DTO 由 schema + z.infer 定义 |
| qrcode | 保留 1.5.4 | QR 仅展示或写权限受限临时图片，机器日志不带原始凭据 |

不同时安装 Inquirer、Ora、cli-progress、Chalk、Ink 或 React。若选定的 Clack 发布版缺少文档中的某个组件，先验证是否可用它已有的 spinner/select 完成同一用户目标，不能伪造支持或偷偷升级既有工具链。

核实过的资料：[Commander](https://github.com/tj/commander.js)、[Clack](https://github.com/bombshell-dev/clack/tree/main/packages/prompts)、[Inquirer 备选](https://github.com/SBoudrias/Inquirer.js)、[cli-table3](https://github.com/cli-table/cli-table3)、[Node styleText](https://nodejs.org/docs/latest-v24.x/api/util.html#utilstyletextformat-text-options)。这些链接用于能力依据，安装后的精确版本与试验结果另记 toolchain/PROGRESS。

## 4. 参数和交互规则

### 全局选项

| 选项 | 含义 |
|---|---|
| `--home <dir>`、`--profile <name>` | 保留现有含义 |
| `--output-format <pretty|plain|json|jsonl>` | 控制 CLI 输出；不占用已有文件 `--output` 或 slide 的 `--format` |
| `--json` | `--output-format json` 的别名；与不同格式同时出现时报参数冲突 |
| `--no-interactive` | 禁止补问及确认；不等于同意执行 |
| `--quiet` | 隐藏人类日常进度、导语和等价命令提示；保留最终结果、警告、错误；不删 JSONL 事件 |
| `--no-color` | 关闭颜色，不改变输出结构或确认规则；同时遵守 NO_COLOR |
| `--debug` | stderr 输出脱敏诊断；不输出 Cookie、密钥、短期 URL、原始请求体或答案全文 |

默认模式：stdin/stdout/stderr 均为 TTY、TERM 不是 dumb、CI 未启用时选 pretty，其余 plain。只有三个流均为 TTY、无 CI、非机器格式且未禁交互时才可补问。CI 的非空值视作启用，`0`/`false` 除外。TERM=dumb 仍可用 plain 编号输入。强制 pretty 遇到不可动态绘制的终端时降级 plain，不强制打开 `/dev/tty`。

无命令且可交互时进入向导；无命令且不可交互时退出 2，给出命令帮助。`--help`/`--version` 始终退出 0；机器模式下包装为结果 data 中的 text/version，不破坏 JSON。全局参数出现在子命令前后均生效，`--` 之后的字符串只作位置参数。

### 值来源和验证

使用显式参数 > 既有对应环境变量 > 用户保存偏好 > 内置默认值。只保留现有环境变量的含义，不额外发明成套环境配置。已有 `getOptionValueSource` 用于区分未传值、默认值和用户明确的 false/0/空字符串；不能用 truthy 判断缺参。

解析阶段验证拼写、枚举、数值与文件参数结构；本地状态阶段验证账号/缓存/草稿所属 scope；必须向平台查询才能确认的语义由 SDK 验证。缺少本地必需字段且不能交互时，在任何平台请求前一次列出所有已知缺项。为得到课程选项而进行的已授权只读查询允许发生在交互选择前。

显式非法参数不得转入向导悄悄替换；没有有效值不得默认选择第一项。账号、课程重名时用平台、章节路径和短 ID 区分，传给 SDK 的仍是完整 ref。平台不支持的操作不可执行，并说明具体原因。

可补问的位置参数改为 Commander 可选参数后，在 handler 前完成统一校验，不再由 requiredOption 抢先退出；必要性不得因此消失。向导选择已有命令树中的操作，进入同一 handler，不复制业务，不执行拼接的 shell 字符串。

向导结束时可显示可复现的等价命令，保留 --home/--profile/范围/设置；路径按当前 shell 安全引用，不把密钥、Cookie、答案正文写入命令。不自动附加 --yes/--final。只读列表不追加确认，直接的 init/profile add/本地新文件生成不额外询问一次“是否确定”。删除、学习、远端提交、checkin 和显式保存偏好需要相应预览或明确命令意图。

## 5. 输出协议 v1

CLI 局部 schema 放在 apps/cli，不能为了 UI DTO 扩大 SDK public API。JSON 与 JSONL 使用 UTF-8；JSON 值不含 ANSI。

### 最终结果

所有正常结束路径都产生一个结果，包括解析失败、缺参、部分完成、取消和不确定写入：

```json
{"schemaVersion":1,"command":"courses","ok":true,"status":"success","exitCode":0,"data":{"items":[]},"error":null,"warnings":[]}
```

字段固定：`status = success | preview | partial | needs-input | uncertain | canceled | error`；`ok` 仅 exitCode=0 为 true。`data` 为命令数据或 null；非零退出允许携带已完成部分、preview/job 和导出路径。`error` 为 null 或 `{code,message,hint,fields,operationId,retryAfterMs}`，后四项分别为 string[]、string[]、string|null、number|null。warnings 为 `{code,message}` 数组。中文 message/hint 不供脚本判断，脚本用 code/status/exitCode。

保留退出码：0 成功/显式 dry-run；1 普通失败；2 输入错误；3 需登录、人工处理、未支持或用户取消；4 部分失败；5 不确定写入。SDK 报错优先于美化，操作 ID 必须保留。未确认写入返回 3 + CONFIRMATION_REQUIRED；缺参/参数错误返回 2 + INVALID_INPUT；用户取消返回 3 + CANCELED。partial/uncertain 即便有 data 也不算成功。

JSON stdout 恰好一行最终结果，非 debug 下 CLI 不写 stderr；Node 自身的 SQLite ExperimentalWarning 等运行时诊断仍可能出现，机器消费者只解析 stdout。JSONL stdout 每行一个事件，序号从 1 开始并严格递增，结束时恰好一个 result。未知命令等解析错误也必须遵循请求的机器格式。进程被 SIGKILL 或输出管道已断开时无法保证尾事件，消费者以缺少 result 判为中断。

### JSONL 事件

每个事件字段为 `{schemaVersion:1,sequence,type,command,time,data}`，time 为 ISO 8601 UTC。类型固定为 `start | progress | warning | auth | question | gap | result`，按 type 定义 discriminated union，不用任意对象替代验证。result.data 是上面的完整最终结果。短命令也是 start + result。

progress.data：`jobId`、`resourceKey`（可 null）、`status`、`completed`、`total`（可 null）、`serverFraction`（可 null）、`estimatedSeconds`（可 null）、`sourceSequence`（可 null）。它是 CLI 对已有事件/Job 状态的投影。不能把资源数量百分比误标为当前视频进度，不能把估计进度标成服务端完成。

warning.data 使用 `{code,message}`；gap.data 使用 `{jobId,message,sourceSequence}`。question.data 保留本次必要的 jobId/phaseId/question/closesAtMs/sourceSequence，Question 使用 SDK 已有 schema；不输出无关会话原始数据。非交互不等待 stdin 答案，不假装用户同意；按 SDK 原有 needs-input/继续监听规则运行。

auth.data 只含 stage、generation、expiresAtMs、qrPath 可空字段。二维码原文、base64、Cookie 和交换票据不进入事件。预览与结果中其他敏感字段同样按已有 SDK 的安全 DTO 输出。

JSONL 不承诺回放所有底层事件：当前 SDK 可能合并进度事件；只转发实际观察到的状态，不伪造缺失历史。命令级 sequence 跨多个 job 连续，sourceSequence 单独保留。输出遵守 stream backpressure，不无限堆积等待写入的 Promise。

## 6. UI、长任务与中断

- 菜单、帮助、空状态、警告和错误均用中文；文案给出目标和下一步。错误显示错误码、原因、解决命令，默认不打印堆栈。
- 表格按列宽排列。终端宽度 <80 列时使用纵向记录；完整 key/path 在详情和 plain/机器输出中保留。32/80/120 列分别验收，不用 string.length 估算中文显示宽度。
- 平台文本与用户名称先清理 ESC/OSC、回车和控制字符，再进入终端展示；保留正常中文和换行。JSON 使用 JSON 编码，不把终端美化后的文本替换业务数据。
- spinner 显示“正在获取课程”等无总量阶段；有 SDK 计数则显示完成资源数，有 serverFraction 才显示服务端百分比。现有 SDK 没有连续下载字节事件，本轮展示下载阶段与资源计数，不伪造 B/s 或 ETA。
- pretty 进度绘制最多每 100ms 一次；plain 只输出阶段变化及最多每 5 秒一条进度，最终状态不节流；JSONL 按已有事件输出，不为 UI 节流丢失 question/gap/result。
- 所有交互、二维码、进度在 stderr；最终人类结果在 stdout。提示期间停止动态刷新，结束后恢复，finally 还原光标与终端模式。
- Ctrl+C 在尚未执行的向导中退出且不写平台；任务运行时请求暂停，等当前安全边界保存检查点后退出。复用 SDK uncertain/paused 语义，不承诺立即中断不可取消的请求或补齐 T18 的 20 秒硬工作片。
- 同样处理 SIGTERM 的清理请求；一次按键不等于回滚。输出 job ID 和可复制的 resume/reconcile 命令。SIGKILL 仍由现有遗留锁检查恢复。
- EPIPE 触发停止后续动作和安全清理，不出现未处理异常，也不能为了打印尾事件再次发出平台写入。

## 7. 账号、登录与偏好

已有账号未指定时：显式保存的默认账号优先；只有一个可选账号时可采用并展示；否则交互选择，非交互缺参报错。默认账号不可用时明确提示，不默默切换到其他账号。目标 job/draft/ref 自带 scope 的，缺少 --profile 时按该 scope 定位；显式账号冲突直接拒绝。

默认账号保存 profileId，不保存易变名称；默认下载目录保存绝对路径。使用现有 SQLite 的 `cli:preferences` 记录与 revision/写锁，不另造配置文件并发机制。首次仅两个键：`default-profile`、`download-dir`，由 `config show`、`config set <key> <value>`、`config unset <key>` 管理。set/unset 命令本身是明确保存意图；交互设置页显示保存项再确认。删除默认账号时同一次锁保护内清理该默认值。未初始化只提示 init，不为读取帮助偷偷创建目录/密钥。

学习倍速/目标、资源选择、--yes/--final、答案不持久化为偏好。输出模式由当前终端与当前参数决定，不保存上一次机器模式。

登录向导允许扫码或选择 Cookie 文件。机器/禁交互模式默认扫码请求返回 INTERACTION_REQUIRED，避免无人值守等待。确需由外部程序呈现扫码时显式传 `--qr-file <new.png>`：以 0600 写 QR 图片，JSONL 提供路径与到期事件，JSON 调用方使用事先指定路径；退出时清理。QR 需要人工扫描不等于 CLI 等待键盘输入，文档需说明。既有 Cookie 导入仍可完全参数化。验证码继续留人工，不绕过风控。

## 8. 全命令覆盖矩阵

每一行均要覆盖完整参数、缺参补问、非交互缺参、错误输入，以及适用的正常/失败输出。未支持的 SDK 能力必须显示真实状态。文件输入使用路径提示和原有大小/格式验证，不建设新的答案编辑器。

| # | 命令 | 交互补齐/展示 | 执行边界 | 任务 |
|---|---|---|---|---|
| 1 | init | home 与创建结果 | 不覆盖密钥 | UX01 |
| 2 | doctor | 配置/依赖诊断和处理建议 | 不自动安装 | UX01 |
| 3 | profile add | 名称、平台 | 保留唯一性 | UX02 |
| 4 | profile list | 账号表、默认标记 | 本地读取 | UX05 |
| 5 | profile remove | 账号、删除范围预览 | 确认/--yes | UX05 |
| 6 | profile unlock | 锁 PID、可执行建议 | 活跃锁拒绝 | UX05 |
| 7 | login | 账号、方法、扫码状态或导入路径 | 显式登录 | UX05 |
| 8 | whoami | 账号、身份验证结果 | 不把网络错误当过期 | UX05 |
| 9 | courses | 账号或 all-profiles、课程表 | 标记分页完整性 | UX04 |
| 10 | outline | 课程搜索选择、章节树 | scope 保留 | UX04 |
| 11 | download | 课程/资源、类型/质量/字幕、输出目录 | 导出新文件不覆盖 | UX06 |
| 12 | slide | 课件 URL、pdf/images、输出目录 | 不伪造旧课件能力 | UX06 |
| 13 | run | 课程/资源、倍速/目标、预览 | 确认/--yes | UX06 |
| 14 | homework draft | 作业资源、输出文件 | 生成草稿不提交 | UX07 |
| 15 | homework apply | 草稿路径、逐题摘要 | 确认后执行精确 preview | UX07 |
| 16 | exam draft | 资源、输出文件 | 离线验证，不做真机 | UX07 |
| 17 | exam export | 资源、输出目录 | 不自动开卷 | UX07 |
| 18 | exam start | 资源、计时风险预览 | 单独确认 | UX07 |
| 19 | exam save | 草稿、保存摘要 | 独立于交卷 | UX07 |
| 20 | exam submit | 草稿、阻塞原因/最终提交预览 | 普通确认之外保留 --final 或交互专门确认 | UX07 |
| 21 | discuss draft | 资源、输出文件、是否显式 AI | 无 AI 授权不调用模型 | UX07 |
| 22 | discuss post | 草稿路径、内容预览 | 确认后发一条 | UX07 |
| 23 | answers match | 草稿、多个来源、可选输出文件 | 只写明确 exact，不覆盖 | UX07 |
| 24 | live | 课次 URL、checkin 预览、当前题 | 每道题独立确认，--yes 不代答 | UX07 |
| 25 | jobs list | 状态表、下一步建议 | 无写锁的本地查询 | UX08 |
| 26 | jobs show | 任务选择、详情、恢复命令 | 按 job 的 scope | UX08 |
| 27 | jobs resume | 可恢复任务选择、状态说明 | uncertain 必须先核对；live 再确认 checkin | UX08 |
| 28 | jobs cancel | 任务与已完成部分 | 确认；不承诺回滚 | UX08 |
| 29 | jobs reconcile | 待核对任务 | 只核对、不重发 | UX08 |
| 30 | operations reconcile | operation ID 提示、结果 | 不猜 ID、不重发 | UX08 |
| 31 | config show | 显式保存的偏好及来源 | 仅本地读取 | UX03 |
| 32 | config set | 键和值、保存摘要 | 显式保存 | UX03 |
| 33 | config unset | 键、清除结果 | 显式清除 | UX03 |

## 9. 迁移与完成标准

尽量保留现有命令名称，允许调整并不意味着全部重命名。CLI 包在交付时升至 0.2.0，SDK 仍为 0.1.0；打包测试必须分别读两个 manifest，不能再假设版本相同。--json 成功 payload 移入 data，失败也有完整 envelope；jobs list 默认从原始 JSON 变为人类表格。机器模式无 --import/--qr-file 的扫码登录不再隐式等待。

全新选择器去掉“必须先复制 key”的交互障碍，参数形式仍接受 URL/key；不会把课程名称当可跨账号唯一 ID。下载新增 `--output-dir`，最终文件仍放在其下唯一 job 子目录；默认路径保持 `<home>/exports/<jobId>`。恢复任务使用首次选定的导出根目录，无明确变更不重新解析当前偏好。保存位置属于 CLI 本地记录，不污染平台 locator。

完成必须有：33 条命令注册及模式矩阵、关键流程真实 PTY 交互证据、JSON/JSONL schema 验证、取消恢复与无网络负例、精确依赖的构建产物消费者验证，以及根 Node/CLI 门禁。检查不要求真实账号、真实考试或付费服务。UI 完成只提升此次 CLI 体验验收，不提升原 T18/T24/T31 的既有业务证据等级。
