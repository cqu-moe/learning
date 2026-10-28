# learning — 工作区约束

## 2026-10-28 用户授权补充：本地 Web 仪表盘

用户已明确启动 React Web UI，并选择本地运行、共用本机数据目录。新增 `apps/web`，使用 CQU Moe Design 的本地包和模板；本补充覆盖下文「只建两个 workspace」「禁止 React/Vite」「Web 全部延期」的旧范围。SDK/CLI 既有版本与验证边界不变。当前交付范围与验收见 `docs/WEB-UI.md`。U02 已由用户指定：任务选择、预览、确认、发起与恢复放在 Web；CLI 面向 Agent。下文 T00–T31 的停止条件和延期限制仅适用于原 SDK/CLI 阶段，不重新限制已授权 U01/U02。

浏览器只消费中立 DTO 和同源 HTTP API，Node 服务使用 SDK 正式导出，不导入 CLI 内部、不复制平台协议。平台登录和在线查询只由用户操作触发；开发验收用隔离目录与离线 fixture。远程部署、云端运行时、原生壳和未纳入首版的写操作仍延期。

## SDK/CLI 1.1 阶段范围（T00–T31）

仓库 `cqu-moe/learning`。当前使用1.1的 SPEC、SDK、contracts.d.ts、PLATFORMS、APPS、ACCEPTANCE、PLAN。**本期只完成共享 SDK + 本地 CLI，Web 延期。** 最终版1.0和更早v0.1/v0.2不得并列执行。

只创建两个workspace：`packages/sdk`（@learning/sdk）、`apps/cli`（@learning/cli）。保留SDK目录内分工，不重拆七个包。当前不创建 apps/web、apps/executor、runtime/cloudflare、Dockerfile、wrangler配置或成功占位。延期说明只在 docs/deferred/WEB.md，不自动执行它。

当前PLAN任务只为T00–T26、T31。**完成T26后进入本机验收T31；完成T31后停止。** 不补做空档T27–T30，不为Web配环境。tasks.json只含当前任务。

## 代码边界与精简

平台协议和公共业务只实现于SDK。CLI负责参数、确认、输出和本机装配。SDK使用中立Runtime接口；本期仅Node生产适配和测试假适配。public/root不能传递导入Node专属实现、CLI或浏览器渲染。

本地PDF/字体/受控课件在T24实现于SDK的/render-node，T26接入CLI，**不因云端executor延期而延期**。不使用旧Python作生产后端，仅作固定源码/纯函数对照。

不引入Access、ZeroTrust、Tunnel、D1、KV、Queues、Workflows、Browser Run、Redis、ORM、Turborepo/Nx、动态插件、通用审批/工作流/事件总线。当前也不安装React/Vite/Hono/Wrangler/Cloudflare插件、Docker工具链或云端数据库客户端。依赖到当前任务确有使用时再加，不建空模块。

## 执行与测试

开始读本文件、SPEC、PROGRESS与当前git diff，再读当前任务的契约/平台源码/测试。不通读旧稿重新设计。一次只执行用户指定任务；未指定时取当前PLAN中依赖已满足的下一个not-started任务；没有可执行任务就报告并停止。

先写正常/异常测试并确认预期失败，再实现，再实际运行命令。DTO用Zod+z.infer。fixture逐项验证请求方法、地址、参数、headers、body和错误envelope；默认未登记请求失败。不只测mock自己，不以空返回/any/skip/删断言/放宽schema骗过测试。

保留完整Cookie、profile scope、session generation、唯一导出路径和不确定写入记录。响应丢失不自动重交；无答案不选第一项，验证码留人工。去冗余不能删除正确性。

本期只跑Node/CLI测试与本地渲染；test:e2e为CLI进程测试。没有test:worker/dev:web/deploy:web或Web测试占位。不得要求Cloudflare凭据才能完成本期，不得宣称Node通过等于云端通过。

工具链沿既定选择，T01真实解析并冻结精确版本，后续不擅自升级。缺少私有源码列明repo/ref/path及能力；可继续不依赖它的工程，不猜协议。missing证据只阻塞相关项，不能虚构通过。

用户已授权 CLI 使用 `.bun-version` 固定的 Bun 编译便携程序；沿用 SDK 的 Node 适配，不新增 Runtime 抽象。Node/pnpm 开发与 SDK 测试版本不变。五目标原生运行与独立程序验收均通过才发布公开 Release；直接提供程序，许可证独立附上，不打压缩包。CLI package.json 版本更新合入 main 后自动发布。平台真机操作仍需单独授权。

## 权限、现有代码与进度

仅编辑当前新仓库、运行被授权的离线检查。平台真机登录/学习/答题/发帖/交卷、付费模型、推送、云部署都需另行明确授权；本期没有云部署任务。

## Agent CLI 契约（当前用户决定）

CLI 只面向软件 Agent，不提供人工向导、pretty/plain、quiet、颜色或交互开关。默认 stdout 输出 `schemaVersion: 1` 单 JSON envelope；仅 `--output-format json|jsonl` 可选，`--json` 是兼容别名。裸跑与命令组返回命令目录，`schema [path...]` 就近返回选项/参数/default/required；缺少必填参数直接返回错误 `fields`。平台真机操作和付费模型仍按上文授权，`--yes` 只是执行确认，不是权限来源。

配套 Skill 源码保存在 `skills/learning-cli/`，供安装到其他环境后使用；它只假设 `learning` 已安装，不假设本仓库路径。雨课堂普通作业下载/YAML/批量能力必须保留：下载需显式课程或资源 key，课程内全选用 `--all`；目录批量 apply 也需 `--all`。实时 CLI 只显式签到并监听事件，不提供直播答题提交入口；SDK `live.answer` 能力仍保留但必须单独授权和验证。详细契约见 `docs/adr/0003-agent-cli.md` 与 `docs/APPS.md`。

不把Cookie、Key、个人原始转储或字体提交到git/文档。使用本机安全文件/环境变量，不要求用户粘贴秘密到聊天。参考仓库只读。

已有代码或PROGRESS时按真实差异合并本版规范，不重置已完成任务，不删除用户改动，不reset/clean全仓或强推。已有Web代码只标延期，不未经授权删除或重写；当前默认构建/任务不得依赖它。

每次结束更新PROGRESS：任务、文件、实际命令/环境/退出码、未运行项、证据缺口与下一当前任务。done必须有真实证据；blocked/partial不伪装完成。T31后不自动开发Web。
