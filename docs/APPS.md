# learning — 本期 CLI 与本地运行约定

版本 1.1。当前只实现 SDK + CLI；Web/API/Cloudflare/容器部署另见延期说明，本文件不授权其开发。

## A01. 运行、构建与本机目录

同一仓库当前只有 `@learning/sdk`、`@learning/cli` 两个 private workspace。CLI 直接 import SDK，不启动 SDK HTTP 服务，不需要 Cloudflare 账号、云端密钥、Docker 或网站登录。

根命令为 `lint`、`typecheck`、`test`、`build`、`cli`，T31 加 `test:e2e`。最后一个执行本地 CLI 进程集成测试，匹配 `apps/cli/tests/e2e.test.ts`，使用独立的 `apps/cli/vitest.e2e.config.ts`，其 include 为 `tests/e2e.test.ts`，不继承单元配置对此文件的 exclude；命令为 `pnpm --filter @learning/cli exec vitest run --config vitest.e2e.config.ts`。不是 Web Playwright E2E。Vitest 默认单元配置匹配 `**/*.test.ts`，排除显式独立运行的 `e2e.test.ts`。本地渲染测试仍可通过 Playwright 控制浏览器，不因此加入 Web 应用或 Web 测试配置。

当前不得创建 `test:worker`、`dev:web`、`deploy:web` 或空通过脚本。install/build/test 不启动真实账号流程、不自动安装系统浏览器。SDK 用 tsc 产 ESM 与声明；CLI 的 bin 指向真实 dist 入口、带 Node shebang。在临时消费者目录实际安装/链接构建包并调用它，不能仅靠源码 tsx 路径可用就算分发成功。

本机目录为 `~/.learning/`，可由 `LEARNING_HOME` 覆盖，含 state.db、master.key、learning.lock、artifacts 和 cache。偏好保存在本机数据库中。userId 固定 `local`，profileId 是稳定 ID 而非显示名称；改名不改变资源归属。目录不支持 NFS/分布式多主。

配置包含模型 base URL/name、输出目录与渲染配置。模型 key 从环境或权限受限的本机配置读取，不进 git/日志。无需模型 key 即可完成查询、下载和手工草稿。输出目录路径由本机用户配置，不接受平台返回的绝对路径作输出位置。

## A02. CLI 命令

通用 `--home <dir>`、`--profile <name>`、`--output-format json|jsonl`、`--json`（兼容别名）和 `--debug`。CLI 不判断 TTY，不提供 pretty/plain/quiet/no-color/no-interactive 或人工向导；缺参直接报错，不从 stdin 补问。stdout 只承载机器协议，诊断和后发遥测警告走 stderr。协议与迁移规则见 [ADR 0003](adr/0003-agent-cli.md)、[迁移说明](CLI-MIGRATION.md)。

裸跑 `learning` 与命令组返回该层命令目录：子命令名称、描述、参数和全局选项，不创建数据目录、不登录平台。`learning schema [path...]` 从实际 Commander 注册树自动生成一个命令的参数、选项、default、required 与 choices，不维护手抄契约；Agent 不复制全量 schema，调用前按需查询。`--help` 与 `--version` 均成功退出，帮助和版本文本位于 `data.text`。缺少必填参数返回 exit 2/`INVALID_INPUT`，错误 `fields` 指向参数或选项名。

| 命令 | 行为 |
|---|---|
| `learning schema [path...]` | 就近查询指定命令的参数/选项/default/required/choices |
| `learning init` | 创建本机目录与主密钥，不覆盖已有配置 |
| `learning profile add <name> --platform ykt\|xuetang\|zhs` | `<name>` 与 `--platform` 均必填；同名重复拒绝 |
| `learning profile list` | 安全元数据列表 |
| `learning profile remove <name> --yes` | 显式删除关联记录/取消任务；不保证上游所有设备退出 |
| `learning profile unlock` | 仅处理本机遗留锁，检查PID与目录；不能抢活跃进程锁 |
| `learning login --profile <name> --qr-file <new-file>` | JSON 模式扫码登录，二维码写新文件并在退出时清理 |
| `learning login --profile <name> --output-format jsonl` | JSONL 自动生成新二维码文件；auth 事件只含路径、generation 与期限 |
| `learning login --profile <name> --import <file>` | 只导入指定Cookie文件，导入后仍需在线核验 |
| `learning whoami --profile <name>` | valid/expired/indeterminate，不打印Cookie |
| `learning courses` | 返回单 profile 课程及 completeness；不提供 SDK 尚未实现的 cursor 分页 |
| `learning courses --all-profiles` | 分账号聚合课程，保留各账号错误和完整性 |
| `learning outline <course-url-or-key>` | 列课程树和资源key |
| `learning download <course> [--types video,homework,exam]` | 先解析可下载项，read-only export job |
| `learning slide <lesson-url> [--format pdf\|images]` | 历史课件只读；实时需要明确加入确认 |
| `learning run <course> [--speed N] [--target N] [--dry-run] [--yes]` | 固定资源范围预览后创建study任务 |
| `learning homework draft <resource> -o <file>` | 生成可编辑YAML，无提交 |
| `learning homework download <course-or-resource> [--all] [--output-dir <dir>] [--dry-run]` | 雨课堂普通作业：必须显式传入课程或资源 key；课程内全选用 `--all`，生成题面、图片、简洁 YAML；重复下载保留草稿 |
| `learning homework apply <file-or-directory> [--all] [--dry-run] [--yes]` | 单文件沿用原接口；目录必须加 `--all` 才批量选择草稿；全选不代替提交确认 |
| `learning exam export <resource>` | 允许查看的试卷/结果，不自动开卷 |
| `learning exam start <resource> --yes` | 独立确认计时；unknown timed视为可能计时 |
| `learning exam save <draft> --yes` | 缓存答案，不自动交卷 |
| `learning exam submit <draft> --yes --final` | 独立不可逆确认；未验证题型/能力拒绝 |
| `learning discuss draft <resource> [--ai] -o <file>` | 草稿可编辑；未配模型仍允许手工 |
| `learning discuss post <file> [--dry-run] [--yes]` | 预览后发一条，失败不自动重复发帖 |
| `learning answers match <draft> --source <file...>` | 生成匹配建议，不提交；只精确无歧义项可写入新草稿 |
| `learning live <lesson-url> [--yes] [--dry-run]` | `--dry-run` 只出签到预览；`--yes` 显式签到并输出 question/gap 事件。CLI 没有直播答题提交入口 |
| `learning jobs list\|show\|resume\|cancel\|reconcile` | 读取或恢复已保存任务；uncertain不直接resume |
| `learning exam draft <resource> -o <file>` | 为可读取试卷生成草稿，不自动开卷 |
| `learning operations reconcile <operationId>` | 只读核对保存的不确定写入 |
| `learning config show` | 查看明确保存的偏好 |
| `learning config set <key> <value>` | 保存 default-profile 或 download-dir |
| `learning config unset <key>` | 清除指定偏好 |
| `learning doctor` | 检查本机依赖与配置，不下载、不自动安装 |

CLI 默认前台运行一个长任务；SIGINT/SIGTERM 请求在安全边界保存暂停状态。不开daemon、不提供后台服务安装、不自动使用nohup。调用方可让自己的进程管理器持有 CLI；电脑关机不会继续执行。本期没有云端后台任务；进程退出后需明确 resume。

`run` 必须显式传课程或资源 key，默认 `--speed 1`、`--target 1`；实际倍速仍受各平台上限约束。`--dry-run` 只生成预览；`--yes` 才执行。遇到未知答案、未解码题面或题型未验证时任务暂停并输出事件，不猜测第一项。

退出码固定：0成功；1普通失败；2参数错误；3需登录/人工处理/尚未验证；4部分失败；5不确定写入。--dry-run允许查询与普通SSO，但禁止签到/标学习完成/作答/开卷/发帖。

普通写操作使用 `--dry-run` 预览或 `--yes` 执行。最终交卷必须同时传 `--yes --final`，且仍受 SDK 未验证题型/能力闸门限制，可能拒绝。`--yes` 只表示调用方确认执行，不是平台操作授权。

## A03. 本地任务驱动与控制

同一 LEARNING_HOME 最多一个写执行进程。init、修改 profile、登录、下载、写动作和任务恢复在写执行锁保护下；`jobs list/show` 等只读本机状态查询可在单独进程中读取 SQLite，不改变 session/checkpoint。

本期不做进程间控制 API。活跃任务在其前台终端按 Ctrl+C 记录暂停、关闭连接、释放锁；然后才能在另一个命令中 resume/cancel/reconcile。另一个 CLI 尝试写控制时遇到活跃锁应返回 CONFLICT 和这个操作提示，不能偷抢锁或另起 daemon。SIGKILL 后遗留锁由明确的 profile unlock 流程核对 PID 与目录；不能仅凭时间到期抢锁。

SDK 内每个 scope 复用一个 client 并负责同 profile 串行化；CLI runtime 只管理前台循环与目录锁，不再嵌套同一异步 profile 队列导致死锁。普通本机状态读取与取消标志检查不等待整个长任务完成。CLI live 仅监听题目与 gap 事件，不调用 SDK 的直播答题接口。

`jobs resume` 继续现有 jobId，不重新 execute 原 preview 或另建相同任务；先处理版本、session generation 和 pending operation。`jobs reconcile <job-id>` 查询该任务在本机状态保存的 pending operationId 并调用 actions.reconcile，不让用户拼任意平台 URL；uncertain 未解除则维持不确定状态，拒绝 resume。核对结果确定后按 SDK 规则继续或结束；不会把“用户想继续”当已提交证据。

前台循环调用 jobs.advance，等待 nextRunAt 或 runtime.wake。退出、超时、Ctrl+C 都要可取消，不能留下没被 await 的 Promise rejection、Socket 或浏览器子进程。kill/崩溃中留下 sending 必须在下次打开后标明 uncertain；电脑不运行时不补造活动。无后台常驻保证。

## A04. 本地 PDF、字体与特殊课件处理

本期保留 font.decode、pdf.compose、slides.legacy 三种已有 HeavyRenderer 输入。实现放 SDK `/render-node`，CLI 按需注入；没有 `apps/executor`、HTTP task server、容器传输签名、远程 artifact URL 或 R2 配置。

HeavyRenderer.start/status/cancel 使用同进程任务对象和本机文件。可在 SDK 内按需要使用受控本机子进程隔离重型工作，但不能另建应用包/常驻服务。start 相同 taskId/attempt、相同输入复用原状态；输入不同冲突。进程不在/状态丢失时 status=missing，不能声称仍在云端运行。font/PDF 纯计算允许同任务最多两次 attempt；特殊页面的潜在副作用不作自动重试。

**冻结本地输入预算（沿用既有产品上限，不是性能保证）：** PDF 总压缩图片输入 256MiB、500 页、单页 4000 万像素、600s；字体输入 32MiB、4096 个目标字符、300s。期限包含排队、启动和重试，不重置。超限在读取/解码前拒绝或由用户选择拆卷，不静默截断。测试需报告峰值内存/取消行为；当前没有本机压测结果。

图片/PDF 使用 pdf-lib，有界集合，不承诺无界 streaming PDF。雨课堂普通作业字体使用固定 opentype.js 2.0.0 与本地字形栅格匹配，不需要浏览器。按用户确认，首次使用自动下载 Noto Sans CJK SC Regular 2.004，校验固定长度和 SHA-256 后缓存在本机；字体不提交 Git、不包含在发布产物。纯函数合成字体测试和本机旧版三份真实样本分别记录，不推断全字库准确率；置信度不足按题标记不完整。实现细节见 [雨课堂作业方案](YKT-HOMEWORK.md)。

普通查询不读取字体文件；仅遇到混淆文字时准备字库。doctor 说明首次自动准备，不因检查环境而下载。参考字库请求仅允许固定官方地址、不带平台 Cookie、不跟随重定向；解码不执行题面 HTML 脚本。特殊课件浏览器仍按原约束处理，当前不自动安装浏览器。

结果先放临时文件，经 taskId/attempt/scope/generation/输入摘要/期限/取消状态验证后，才按本机 ArtifactStore 规则提交 manifest。取消或旧 attempt 的迟到结果不能变成成功下载。任务结束销毁 browser context 和本机临时文件，不保留第二份 Cookie 数据库。

## A05. 本机安装、升级与验收

T31 编写 `docs/INSTALL.md`、`docs/USAGE.md`、`docs/FEATURE-STATUS.md`。至少覆盖独立程序与源码安装、doctor/schema、init/扫码、模型可选配置、本机依赖边界、数据备份/升级/回滚限制、遗留锁处理、SIGINT/resume/reconcile 和导出清理。

CI 只做两包静态边界、SDK/CLI 离线测试、Node 存储/网络适配测试、CLI 进程 E2E。渲染测试要区分 fake renderer 合同、真实浏览器集成与人工字体 golden；缺字体样本不假装该层通过，也不让云端账号缺失影响本期测试。

真实平台请求与付费模型调用仍需逐项明确授权。未运行的本机平台能力写 not-run/blocked；Web/Cloudflare 写 deferred 并排除本期验收分母。当前不写 DEPLOY.md 云部署指南、不创建云资源、不要求对 Cloudflare 进行连通性测试。
