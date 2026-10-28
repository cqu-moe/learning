# learning — SDK + CLI 本期定稿规范

> 阶段说明：本文保留 1.1 阶段的设计、计划或交接。任务选择以当前用户要求、[AGENTS](../AGENTS.md) 和[当前状态](PROGRESS.md) 为准；旧任务编号与停止条件不自动约束后续已授权任务。

版本：1.1 · 日期：2026-09-23 · 本期范围：共享 SDK 与本地 CLI；Web 延期。

**本文件与 SDK、contracts、PLATFORMS、APPS、ACCEPTANCE、PLAN 配套，整体替代最终版 1.0 及更早的 v0.1/v0.2。** 本次是修改设计与实施计划，不是已经实现产品。保留项目/仓库名 `learning / cqu-moe/learning`。

## 1. 要做什么

本期交付一份 TypeScript SDK 和使用它的聚合命令行 `learning`。SDK 迁移雨课堂、学堂在线、智慧树既定平台能力，CLI 在本机直接调用它，不需要 Web 服务、Cloudflare 账号或云端密钥。

**本期只推迟 Web，不把已定的 SDK/CLI 功能偷偷缩成“登录和课程列表”的原型。** 先只读、再写操作/任务/完整 CLI 是本期内部实施顺序；已承诺的功能仍按 PLATFORMS 逐项实现、测试并记录证据缺口。SDK 的“基础”指共用底层，不是另减一次功能范围。

CLI 面向一个本机使用者和其多个平台 profiles；本机 `userId` 固定为 `local`，数据目录由 `LEARNING_HOME` 隔离。保留 Scope 与可注入运行时，便于以后接入 Web；本期不建设站点用户系统。

## 2. 本期做与不做

| 范围 | 决定 |
|---|---|
| SDK | 数据/schema、平台协议、会话、课程树、内容、导出、草稿、写入、固定任务、错误与恢复 |
| Node 适配 | HTTP/WS、SQLite、加密会话、本机文件、前台任务驱动、本地渲染 |
| CLI | APPS 中全部既定命令、TTY/JSON、进程退出码、取消/恢复、安装与使用说明 |
| 本地高级能力 | PDF、字体解码、确有证据的特殊课件页面由同 SDK `/render-node` 实现；不依赖容器 |
| Web | 页面、HTTP API、站点登录、用户配置、Web E2E 全部延期 |
| Cloudflare | Workers/DO/R2/Containers、云端运行时适配、Wrangler、部署脚本和云端测试全部延期 |
| 工程组织 | 当前只建 1 个 SDK 包 + 1 个 CLI 包；不创建 Web/executor 空包 |

继续排除 Access、Zero Trust、Tunnel、D1、KV、Queues、Workflows、Browser Run、Redis、ORM、Turborepo/Nx、动态插件市场、通用审批/工作流引擎和额外微服务。不为“以后可能用”预建空模块、占位测试或备用实现。

未来 Web 仍与本仓库 SDK 共用代码，仍优先 Cloudflare 原生（允许 Containers）；该意向只记在 [WEB-LATER](deferred/WEB.md)，不是本期安装、开发或验收前提。

## 3. 本期仓库、包与依赖方向

```text
learning/
├── package.json                    # name=learning, private=true
├── pnpm-workspace.yaml             # 本期显式列 packages/sdk 与 apps/cli
├── pnpm-lock.yaml
├── AGENTS.md
├── packages/sdk/                   # @learning/sdk：唯一共享库
│   └── src/
│       ├── index.ts                # createLearningClient 等稳定入口
│       ├── public.ts               # 无环境副作用的 DTO/schema
│       ├── types/
│       ├── http/
│       ├── auth/ 与 session/
│       ├── providers/{ykt,xuetang,zhs}/
│       ├── services/
│       ├── jobs/
│       ├── content/
│       └── runtime/node/           # 本期唯一生产运行时
├── apps/cli/                       # @learning/cli；命令 learning
└── docs/
    ├── SPEC.md、SDK.md、contracts.d.ts、PLATFORMS.md、APPS.md
    ├── PLAN.md、ACCEPTANCE.md、HANDOFF.md、PROGRESS.md
    └── deferred/WEB.md             # 延期说明，不是待自动执行的任务
```

当前严格 **2 个 workspace package**：`@learning/sdk` 与 `@learning/cli`，均 `private: true`，根 package.json 只协调脚本。应用通过 `@learning/sdk: workspace:*` 引用底层，不先发 npm、不拆七个库。测试帮助代码放 SDK 的 tests/helpers，不另建包。

当前不创建 `apps/web`、`apps/executor`、`runtime/cloudflare`、Dockerfile、wrangler 配置或其 package.json。Web 获得新一轮授权后再添加；这些目录不存在不是本期缺陷。

SDK 不导入 CLI。CLI 不直接实现平台 URL、认证协议或数据归一化。平台/业务共享代码不依赖 Node 的磁盘/数据库、Commander、终端 UI，也不依赖 Cloudflare；必要 I/O 从已有 Runtime 注入。本机专用实现只通过 Node 子路径进入。

本期最终 exports 为根入口、`/public`、`/node`、`/render-node`。`/render-node` 在 T24 有真实实现后加入；不提供空 `/cloudflare` 出口。`/public` 是数据契约，不等于开发 Web。根入口与 public 的静态依赖检查必须阻止 Node/CLI/渲染实现被传递带入；无需搭建浏览器或 workerd 工程来证明这一点。内部导入用相对 `.js` 路径，应用使用正式 exports，不靠 tsconfig paths 伪造包可用性。

## 4. 技术栈与根命令

| 部分 | 本期选择 |
|---|---|
| 语言/工作区 | TypeScript strict、ESM、pnpm，两包工作区 |
| SDK | Zod 4、Web Fetch/Streams、tough-cookie、@noble/hashes；普通函数与模块 |
| 本机运行时 | Node 24 系列；node:sqlite 只在 `/node` 内加载 |
| CLI | Commander、简单 prompts、qrcode；stdout/stderr 分开 |
| 内容 | parse5、yaml、pdf-lib；Playwright 仅为本地受控渲染 |
| 测试 | Vitest + Node 脚本；CLI E2E 是命令行进程测试，不是 Web 测试 |

Node 24 继续沿用既定运行时目标，不重新选型。精确 Node/pnpm/TypeScript/库补丁在 T01 实际安装验证后写 toolchain.md 和 lockfile，后续不擅自升级。没有在本次文档修改中重新查询 registry 或安装产品依赖。node:sqlite 的能力仍在真正 Node 24 环境测试，不把文档检查环境当产品环境。

2026-10-13 用户授权补充：CLI 便携发行使用固定 Bun 1.4.3 编译，复用现有 Node 子路径适配；开发、SDK 包消费和 Node 测试仍固定 Node 24.11.1 / pnpm 11.19.0。每个发行目标须实际验证 SQLite/加密互读、渲染及编译 CLI，不能以交叉编译成功代替运行验收。版本与公开 Release 约束见 CLI-DISTRIBUTION.md。

TypeScript 开启 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、useUnknownInCatchVariables。根脚本只保留 `lint`、`typecheck`、`test`、`build`、`cli`，到 T31 添加 `test:e2e`（仅本地 CLI）。没有 `test:worker`、`dev:web`、`deploy:web`、镜像构建或假成功占位脚本。

T01 只安装当前基础任务用到的依赖；Commander 在 CLI 任务、Playwright/pdf-lib 等在内容/本地渲染任务加入并冻结版本。不安装 React、Vite、Hono、Wrangler、Cloudflare 插件/SDK 或 Docker 工具链。安装/build/test 不自动装浏览器，不连接真实平台。

## 5. SDK 与本地 CLI 的最小运行方式

```text
终端参数/菜单
    → apps/cli：配置、profile、确认、输出
    → @learning/sdk：统一服务 + 三平台 provider
    → Node Runtime：HTTP/WS、SQLite、本机 ArtifactStore
    → 学习平台与本地文件
             └─ 有需要时调用同 SDK 的本地 HeavyRenderer
```

SDK 是库，不是本地 HTTP 服务。CLI 默认前台驱动一个长任务，进度/检查点写 SQLite；没有 daemon、监听端口、后台服务安装或云端调度器。电脑关机或 CLI 进程退出后任务不会继续；再次运行 `jobs resume` 才恢复。保留检查点是为了恢复，不是模拟常驻执行。

Runtime 的 Transport、Clock、StateStore、ArtifactStore、HeavyRenderer、ModelClient 和 wake 等接口保持环境中立；本期只实现 Node 与测试假实现，不创建 Cloudflare 占位类。`wake()` 只唤醒当前前台任务循环，不启动第二个执行器/后台进程。

同一数据目录最多一个写执行进程。SDK 内同 profile 的会话/写操作串行，避免 Cookie 与考试子系统串用；每次任务状态查询不排在长网络操作后。CLI 控制规则见 APPS，不引入分布式锁或本地控制服务器。

## 6. 没有站点登录与云端资源准备任务

本期不做网站访问密钥、signed cookie、UserDO、站点用户名/权限表、生产 secret 配置或 Cloudflare 账号引导。保留的是学习平台自身的扫码登录和本机 profile 管理，两者不可混淆。

SDK/CLI 验收不需要 Cloudflare 账号、信用卡、R2 桶、DO namespace、容器镜像或云端连通性证据。未来云端未经测试不得声称已兼容；同样，延期项目不应被标成当前失败以阻止 CLI 发布。

## 7. 数据模型和平台边界

平台固定 ykt、xuetang、zhs；zhs 内含 share/hike；雨课堂 standard/KG 分树解析器。不做靠换域名工作的万能 BasePlatform 或动态插件系统。

IDs 为字符串；courseId、classroomId、skuId、树节点 ID 不互相代替。定位由 scope 和完整 native locator 组成；同一视频在两处出现仍是两条资源。未知用 null，不用 0 伪造缺失 ID（已验证 smallLessonId="0" 例外）。摘要与 DTO 按 SDK/contracts 计算。

分页分 complete/more/unknown；错误不是空列表。HTTP 200 后仍检查 success/code/errcode。安全返回值不带 Cookie、交换票据或短期签名 URL。富文本清理后保留数学、图片信息和选项，不能把缺字/乱码当成明文。

## 8. 登录态与本地保存

完整 CookieJar 保留 domain/path/hostOnly/Secure/expiry；Set-Cookie 不按逗号切割。每次重定向重新选 Cookie、验证目标并去掉不该跨源发送的身份头。平台 host 按已验证列表限制，不开放任意代理。

二维码总时限 10 分钟；SDK 返回事件不打印。学堂沿原 WS，其他平台沿原 HTTP 流程。验证码留给人工在官方界面处理。网络故障为 indeterminate，不自动删现有会话。

session generation 在登录替换、导入、注销时增长。迟到请求不能重写被撤销的 Cookie；导入失败不损坏旧 profile。会话与敏感正文用 AES-GCM 加密；CLI init 首次生成 master.key，POSIX 0600、Windows 当前用户 ACL；可用环境变量覆盖。不强制 1Password/钥匙串；本机密钥和数据库同机不抵御整机失陷。

SQLite 与文件位于 `~/.learning/` 或 LEARNING_HOME；事务里不等网络。排他 lockfile 防止同目录多写进程；崩溃遗留锁显式核对 PID 后解锁，不自动抢活跃锁。跨目录、其他独立部署或官方网页的并发操作不受这个锁保护，不宣称全局互斥。

## 9. 写操作和可恢复任务

继续使用 prepare → execute → 必要时 reconcile；没有独立权限/审批服务。prepare 保存精确输入、内容摘要和 generation；确认后 execute 只接收 previewId；过期/换内容/换会话要重做预览。TTY 确认或明确命令参数属于本地用户授权，不借 Web 登录作为本期权限来源。

普通 SSO 可在已认证的读取中完成；读取/预览不能顺便签到、标记完成、开始计时或提交。GET 也可能有副作用。开卷、保存答案和交卷分动作；交卷单独确认。

每个实际写入先保存 sending，再发送；结果和检查点一起提交。响应丢失或崩溃先进入 uncertain 并核对，不盲目重试；重复执行相同 preview 返回同一结果/任务。未知题型、unset、无有效选项不发送。取消停止未来操作，不保证回滚已发生结果。

固定 JobKind 处理器与普通 switch，不做 DAG/DSL。advance 保存 cursor 与 nextRunAt；本地循环等待/唤醒后继续。默认 20 秒活动工作片是可恢复边界，不是为了现在搭云调度。信号、任务期限、暂停和待确认写入的检查深入每个步骤。停机区间不补造活动，恢复先读取权威状态。

同一个活跃 live job 可接受自己的短答题动作，但不启动第二个长任务或另一个 profile 会话写执行器。Socket 生命周期归当前本机任务宿主，断线重新握手并报告 gap，不承诺补齐丢失消息。Ctrl+C 的关闭与恢复语义见 APPS。

## 10. 本地导出与重型能力留在本期

下载通过本机 ArtifactStore 流式写唯一 `.part`，增量 SHA-256 和 backpressure；支持有证据的 Range/validator 检查，验证后同文件系统原子 rename，最后提交 manifest。没有 R2 实现、multipart 云端传输或对象存储凭据。

PDF/字体/特殊课件页面在 SDK `/render-node` 中实现同一 HeavyRenderer 契约，由 CLI 注入。它是本地库能力，不是 `apps/executor`、HTTP 服务或 Docker 容器。无需云账号便能执行。

本地处理保留输入/页数/像素/时限限制与人工字体 golden，具体沿 APPS A04。浏览器仅需时显式配置/安装；主 SDK import、普通查询和课程列表不启动它。未知字体或解码歧义应返回 unresolved/partial，不为了“兼容”猜字。特殊页面若可能触发未确认副作用，不自动 fallback。

## 11. 保留的功能与验证边界

仍包括三平台登录/多账号/课程树、既定学习任务、雨课堂与学堂的资源/课件/作业/允许查看的考试结果、学堂讨论与考试分步动作、雨课堂实时能力、草稿/反馈导入、答案匹配及可选模型建议。PLATFORMS 的平台支持矩阵保持，不新增原仓库没有的能力。

AI 默认生成建议；没有模型 Key 仍可查询、下载、手工草稿和用户提供的答案。未知答案不取第一项、不穷举；风控暂停人工处理。未验证写形态保留明确状态，真实写入测试逐项授权。

## 12. 本期交付与之后的工作

本期 PLAN 只包含 **T00–T26 与 T31，共 28 项**。T31 改为 SDK + CLI 集成、安装/升级说明和本地证据，不依赖延期 Web。T27–T30 保留旧编号但移到延期说明，不在 tasks.json 或当前待办表内；不是漏项或本期 blocker。

本期完成标准：两包可安装/构建；SDK 和 CLI 指定离线测试、Node 运行时、CLI 进程 E2E 与本地渲染验收通过；平台尚未实测的能力逐项列明。没有用户授权的真实登录/写入如实记 not-run；Web/Cloudflare 记 deferred，不计当前完成分母。

T31 之后停止，不自动进入 Web。未来进入 Web 时另行确认范围与实际 Cloudflare 能力，不以当前库的可复用设计代替 workerd/云部署验收。
