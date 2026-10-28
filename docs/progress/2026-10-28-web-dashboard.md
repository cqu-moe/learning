# 本地 Web 仪表盘与 Agent CLI 互操作

以下保留各轮实施与验证时的原始证据；当前合并状态见进度索引。

### 2026-10-28 · U01 本地 React Web 仪表盘首版

- 用户明确要求 React 用户界面，并选择「本地 Web 仪表盘」。复用已隔离 worktree 的 `codex/learning-web-dashboard` 分支；旧 Web 禁止范围由本次授权覆盖，未修改 SDK/CLI 产品源码、未合并隔壁 Agent CLI 分支。U01 **done（首版本机/离线验收）**；不把它记为全业务 UI 或真实教学平台验收完成。
- `apps/web` 使用 CQU Moe Design 官方生成器与本地 theme/ui 1.1.0 tarball，复用 AppShell、ThemeProvider、Toaster、PageState 和公开组件。新增概览、账号添加/扫码/取消、课程搜索/平台筛选/主动刷新/分页/目录、任务状态/结果/暂停/取消；未知进度不虚构百分比。React 浏览器代码只消费 HTTP DTO，不导入 CLI 或 SDK Node 适配。
- 本地 Node HTTP API 复用 SDK、SQLite、`LEARNING_HOME` 和 CLI 数据键/写锁，保留完整 scope 与不确定结果；Host/Origin/Cross-Site、JSON/schema、静态 realpath、旧数据库缺密钥和锁冲突均有检查。登录失败返回安全中文消息，取消立即处理；已成功写入与后续界面刷新失败分别提示。SIGINT/SIGTERM 等待在途请求/登录清理后关闭数据库。
- 修改范围：`apps/web/{src,server,shared,tests,.design}` 与配置/说明；根 package/workspace/lock、导入边界检查、AGENTS/README，以及 SPEC/PLAN/tasks、延期说明和 `docs/WEB-UI.md`。参考设计仓库保持只读，构建产物、合成截图、临时数据库和日志不入 Git。
- 环境：macOS arm64，Node **24.11.1**、pnpm **11.19.0**；React/DOM 19.3.0、Vite **8.3.0**、TypeScript 5.9.3、Vitest 5.0.1。最初模板引入 Vite 8.3.1 并重新解析 source-map-js，复核后恢复仓库已有 Vite 8.3.0 / source-map-js 1.2.1；断言原锁文件全部包版本仍保留。最终 `pnpm install --offline --frozen-lockfile` exit0，冻结安装和供应链策略检查通过，无原有直接依赖版本升级。
- 实际红绿：最初两包边界检查按旧规则拒绝新 Web；更新为三消费者且禁止浏览器导入 Node/CLI 后 exit0。API 写锁回归在原控制实现返回 200（预期409）时 exit1，修复后通过。退出期间重复关闭原实现令在途课程请求返回500；排队登录取消后仍多发一次认证请求，两个专项实际 exit1（`artifacts/web-ui/lifecycle-red.log`），修复后完整 **17/17 exit0**（`api-final.log`）。中间一次 login POST 响应状态判断造成测试挂起，人工终止 exit130 后修正；新增测试使用 Promise.withResolvers 曾触发当前 ES2022 类型检查 exit2，改为普通 Promise 后通过，没有放宽 TS 配置。
- 最终命令：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm --filter @learning/web test`、`node scripts/check-boundaries.mjs`、`node apps/web/node_modules/@cqu-moe/ui/dist/check-design.mjs apps/web/src`、`git diff --check` 均 exit0。完整 build 覆盖 SDK/CLI/Web；Web API 17/17 使用真实本机 HTTP + 临时 SQLite + 严格 SDK fixture。日志在 `artifacts/web-ui/{lint,typecheck,build,api}-final.log`。构建仍提示单 JS chunk 651.10 kB（gzip199.76 kB）超过500 kB；本地首版保留，没有修改警告阈值。
- 正式 `server/index.ts --port 4313` 在独立临时目录通过启动自检：dashboard 的账号/课程/任务为空，HTML 返回200，防嵌入响应头生效，SIGTERM exit0。未触及真实 `~/.learning`；浏览器 fixture 监听4312，临时合成3账号/6课程/4任务，Transport 对全部平台 fetch/connect 直接拒绝。产品正常入口为根目录 `pnpm web`（4311），fixture不参与产品启动。
- Ego 浏览器已实看 1440/768/390/320 × 浅深主题，共8张概览截图，无整页横向溢出；追加课程390、账号320、任务列表/详情320截图亦检查。修复全局链接颜色覆盖共享主按钮的问题。验证主题刷新保持、系统主题初始渲染、手机导航切换后收起、搜索/筛选/无结果、空账号输入校验、Enter本地保存、重名错误保留输入、离线刷新失败保留6门缓存课程、合成任务暂停/取消和刷新持久化。取消确认框 Esc 恢复焦点；完全拦截不发网的 login POST 挂起测试验证 Esc 关闭并触发 AbortController。截图为 `artifacts/web-ui/dashboard-*-{light,dark}.png` 及页面名截图；均为合成数据。
- 独立 GLM 5.3/max 前端审查发现登录挂起不可关闭、变更成功后刷新失败被误报，均已修复并复查；后端结果由主线程逐段复核和上述实际命令验证。自动审批曾拒绝在旧本机入口点击「扫码登录」，原因是可能触发真实认证；后续只在拒绝外网的 fixture/页面请求拦截中验收，未绕过限制。
- 未运行真实平台登录/学习/答题/交卷/发帖、付费模型、真实账号数据、独立移动设备/Windows/Linux、原生封装、远程 CI 或云部署。SDK/CLI 产品未改，未重复原有完整单元/CLI进程/五目标程序矩阵；本轮共用 SDK 的路径由 Web fixtures、整仓静态检查与构建覆盖。未提交、推送、开 PR 或发布。
- 下一当前任务：用户审阅首版界面，确定后续需要补齐的任务发起/恢复和其他用户流程；这些不在本次最小仪表盘内。真实平台联调需另行授权，云端和原生壳不自动执行。

### 2026-10-28 · U02 Web 任务发起、执行与恢复

- 用户继续授权「把任务发起和恢复补齐，用户操作都放到 Web UI 里，CLI 只留给 Agent 用」。沿用 `codex/learning-web-dashboard` 隔离分支和已有 U01 改动；U02 **done（本机/离线验收）**。Web 独立消费 SDK，未改 CLI 产品代码、未合并隔壁 Agent CLI 分支，也不把答题编辑/交卷/发布讨论记为已迁移。
- 课程页新增任务表单：学习资源、视频导出、普通作业导出、课件导出、课堂任务；选择具体资源或课堂、填写参数、生成预览、明确确认后启动。初始不勾选资源，前后端验证范围和参数，智慧树倍速按课程类型限制；提交失败保留输入，同一预览重复确认返回同一任务。任务中心提供进度、事件、项目结果、暂停/取消/恢复、只读核对不确定结果和文件下载。
- `apps/web/server/tasks.ts` 保留预览对应的 SDK client，确认后后台驱动真实 `jobs.advance`；全程占用既有本地写锁，暂停/终止完成后才释放。同一数据目录同时运行一个任务，重启后沿用原 job/checkpoint。下载校验账号/任务/产物归属、长度与 SHA-256，再流式传输；本地 PDF 复用 SDK `/render-node`。不新增数据库表、外部依赖或自动重交机制。
- 共享 SDK 仅修复三处必要生命周期边界：`services/jobs.ts` 在课堂重新签到前用既有 metadata 记录 pending，未知结果保留 uncertain；`index.ts` 核对该记录时不猜平台结果或重发，先保留事件再清除已确认标记，并透传取消信号；`services/actions.ts` 的 executor 接收既有 Options。Web 关闭先取消任务初始化/执行，再等待 HTTP 与锁清理，最后关闭 SQLite。
- 涉及 `apps/web/{server,shared,src,tests}`，上述三个 SDK 文件及 WEB-UI/README/AGENTS/PLAN/tasks/PROGRESS。U01 的原有工作区与依赖改动保留；U02 未升级依赖或工具链。独立 GLM 5.3/max 前端实现和后端只读审查由主线程复核，审查使用了跨项目标准；修订后无剩余必须修复项。
- 实际红绿包括：任务 API 原先返回404；课堂恢复请求响应未知后原实现仍为 paused（应 uncertain）；关闭服务等待尚未完成的启动请求，700ms 有界回归失败。修复后九项任务回归全部通过，覆盖真实 HTTP/SQLite/SDK、重复确认、锁冲突、暂停后服务重启恢复、会话代际失效、资源/课堂归属、下载校验、未知签到不重发和初始化取消。首轮类型检查因测试导入 SDK 源码带入 DOM BufferSource 类型冲突失败，测试改为引用已构建内部模块后通过，未放宽类型检查。
- macOS arm64 / Node **24.11.1** / pnpm **11.19.0**：最终 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e` 均 exit0。SDK **305/305**、CLI **218/218**、Web **26/26**（原 API 17 + 新任务 9）、CLI 进程 **7/7**，合计 **556** 项。日志为 `artifacts/web-ui/u02-{lint,typecheck,test,build,e2e}-final.log`。最后仅缩短表单标签后再次 Web build exit0，日志 `u02-web-build-final.log`；单 JS chunk 约675 kB（gzip206 kB）的既有体积警告仍在，未调高阈值。
- `node scripts/check-boundaries.mjs`、`node apps/web/node_modules/@cqu-moe/ui/dist/check-design.mjs apps/web/src`、`git diff --check` 均 exit0。默认 SDK/CLI/Web 构建及浏览器导入边界通过；未将通过本机测试解释为真实平台或远端 CI 通过。
- Ego 浏览器在4312的严格合成 fixture 中实测：课程选择视频 → 预览 → 确认 → 运行中暂停（1/2）→ 原任务恢复 → 完成（2/2）；实际浏览器下载内容为合成视频字节。参数可清空重输，Esc 关闭并回焦「新建任务」。任务表单1440/768/390/320浅深主题截图已检查，浅色四宽度的实测页面宽度等于视口宽度；320/390表单内部滚动，无整页横向溢出。截图 `artifacts/web-ui/u02-composer-*-{light,dark}.png`，下载证据 `u02-browser-download.bin`。验收任务空间已关闭。
- 4312预览继续使用临时目录与合成3账号/6课程/4任务；Transport 只允许登记的 fixture 请求，其余 fetch/connect 全部拒绝，未使用真实 `~/.learning`。正常产品启动仍为 `pnpm web`（4311）；浏览器页面可关闭，但本地服务需保持运行。无法确认的旧写锁不抢占；不能从平台证明的写入结果不自动重试。
- 未运行真实平台登录/学习/签到/答题/交卷/发帖、付费模型、真实账号数据、独立移动设备、五目标原生程序或远程 CI；未提交、推送、开 PR、发布或部署。下一当前任务为用户审阅 U02 与后续明确授权的真实平台联调；不自动开发云端或其他用户流程。

### 2026-10-28 · U03 整合 Agent CLI 与 Web 共享数据联调

- 用户明确授权整合已合入 main 的 Agent CLI，联调共用账号、数据和任务恢复。`git fetch origin main` 确认 `9229491`（PR #30）；先将 U01/U02 保存为本地 `130ed4b`，再合并为 `b75c43e`，保留两侧实现与历史记录。README/PROGRESS/锁文件冲突按当前 Web + Agent CLI 范围解决；精确合并原两份依赖锁，没有升级已有包。沿用 `codex/learning-web-dashboard`，未更改用户主工作区或已安装程序。
- 账号页补齐设为默认、核验登录、退出本地登录、移除账号和遗留锁清理。共用 `cli:preferences`，保留 downloadDir；通过 SDK 解密读取有效会话，撤销 tombstone 不再被误报为已登录。有效写锁和无法确认的锁不抢占；清理前再次核对原 PID 与锁内容。首次初始化也遵守既有写锁，避免 Web/CLI 同时初始化共享密钥与数据库。
- SDK `/node/local-profile.ts` 复用并收敛两端账号清理：按完整 scope 清理任务、预览、操作记录、CLI/Web 课程资源、媒体检查点和内部文件，仅重置匹配默认账号；保留其他账号与已另存文件。CLI `profile remove` 调用同一实现。Web 目录写入完整 CLI ref/kind/title/path 缓存；任务标题可读取 CLI 缓存，PDF/字体使用同一本地目录。没有新表、新依赖、第二份任务状态或自动重交机制。
- `apps/web/tests/interop.test.ts` 使用真实 Agent CLI 子进程、真实 Web HTTP/SQLite 与严格 fixture：Web 扫码后 CLI 核验同一 Cookie，CLI 导入后 Web 核验；默认账号双向可见，退出与移除同步生效；CLI→Web 与 Web→CLI 都暂停并恢复原 HLS job/checkpoint，只请求未完成分片，实际产物均为 `head-tail`；活跃锁阻止另一端写入；CLI 删除清理 Web 缓存并使旧预览失效。独立 `test:interop` 接入根 `test:e2e`，先构建 CLI，避免和整仓并行单测争用 dist。
- 实际红绿：账号控制最初 HTTP404（预期200），首次初始化没有拒绝另一进程持锁，两项均先红后绿。最终只读审查另发现排队登录捕获已删除账号、assessment 预览持有已退出会话；新增真实回归分别观察到删除后仍多发3次认证请求、退出/CLI重新登录后旧预览仍返回200（预期409）。修复为获锁后重新核验完整账号、预览绑定既有会话 generation、导出执行重新加载 Cookie；Web **28/28**、interop **7/7** exit0。原学习 executor 与 uncertain 不重发保留。日志 `u03-{management,startup,login-race,preview-session}-red.log`、`u03-{web,interop}-review-green.log`（前两项分别为 `u03-management-red.log`、`u03-startup-red.log`）。
- macOS arm64 / Node **24.11.1** / pnpm **11.19.0**：冻结安装、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm test:e2e`、`node scripts/check-boundaries.mjs`、设计检查与 `node scripts/test-release.mjs` 均 exit0。完整首轮 SDK343、CLI218、Web27、CLI进程7、interop5，共600通过；上述最后三条回归后再跑 Web28、interop7、lint、Web类型检查/构建、边界/设计检查均 exit0，累计最终 **603通过、2跳过**。两项字体样本测试因未提供 `LEARNING_FONT_REFERENCE`/`LEARNING_FONT_FIXTURES` 跳过；合成字体回归通过。完整日志 `artifacts/web-ui/u03-*-final.log`，最后复验 `u03-review-{lint,build}.log`；单 JS chunk685.04kB/gzip208.26kB警告保留，未调高阈值。
- 合并锁文件后的冻结安装通过（缓存复用，新增14/移除31个包）；最初沙箱中供应链元数据解析因网络 ENOTFOUND 被终止，随后获准重跑成功。互操作 fixture 最初用无活动句柄的 Promise 导致 CLI 提前退出，改为有界且可取消的等待；课程缓存顺序断言改为比较同一确切集合，不假定哈希键排序。这些是测试装配问题，未放宽产品检查。
- Ego 浏览器在合成4312服务实测默认账号、有效登录核验、退出、Enter添加与移除、失效锁提示/确认清理；CLI `config show` 读回 Web 设置。删除和解锁弹窗 Esc 回到触发按钮，操作成功后聚焦添加账号。账号页1440/768/390/320浅深共8张截图及390解锁弹窗、320页面底部实看，无横向溢出；桌面正常竖向滚动条占宽单独计量。初次文本选择器点中 ActionButton 隐藏标签后改用实际 aria-label；测试锁提前注入时移除被正确拒绝，清锁后重试成功。截图 `u03-accounts-*`、`u03-unlock-390-light.png`；验收 TaskSpace9 已关闭，最新合成服务继续监听4312，真实 `~/.learning` 未触及。
- 独立 GLM5.3/max 复核共享清理与生命周期修复，最终没有剩余 must-fix；主线程复核源码及测试。`node scripts/check-source-lock.mjs` 实际 exit1：本 worktree 缺 `.reference/ykt-cli`（`48a92c24498980d01aa045cf734ba3095d5f5bd1`）、`.reference/xuetang-cli`（`628a8fa8a4b90897f285a109aa591a8f6263846d`）、`.reference/zhs-cli`（`56d02171cf73c45694d69f886c902d2ecedadaaa`）；本次不改平台协议，记录参考源码核验缺口，不掩盖为通过，不拉取或运行旧 CLI。
- U03 **done（本机/离线互操作验收）**。未运行真实教学平台登录/学习/签到/答题/发帖/交卷、付费模型、真实遥测、五目标原生矩阵或远程 CI；未推送、开 PR、远程合并、发布或部署。Web 的作业编辑/提交与讨论发布尚未实现，不宣称全量 CLI 功能已迁移。下一事项为用户审阅本地整合结果或另行指定的真实平台/发布验收，不自动扩大范围。

### 2026-10-28 · 本地 GUI 使用入口

- 用户询问 GUI 用法。确认4311没有现存监听后，以 Node24.11.1 启动已构建的正式 `apps/web/server/index.ts`，显式使用共享 `/Users/uu/.learning`，仅监听 `127.0.0.1:4311`；进程保持运行。`curl --fail --max-time 5` 静态首页返回 HTTP200 / exit0，Codex 打开该地址的请求已排队。
- 4312仍是合成演示；正式入口显示本机共享账号/课程/任务，由用户主动扫码、刷新和启动。没有自动发起教学平台登录、课程读取或写入，没有付费模型请求；本次未改产品代码，沿用上一节构建与测试，不重复全套。下一步为用户通过4311使用界面，真实平台流程不宣称已验收。

### 2026-10-28 · 修复雨课堂二维码被 Web 误拒绝

- 用户在正式4311页面主动获取二维码，报告「登录二维码来源不受信任」。根因是 `apps/web/server/app.ts` 的显示层仅允许微信域名；SDK 的雨课堂二维码本可使用平台自身链接，原合成 fixture 却只覆盖微信链接，导致离线验收漏检。
- 针对该错误匿名读取一次公开 `https://www.yuketang.cn/api/v3/user/login/app-web-pre-info`，没有携带账号 Cookie；仅输出 HTTP200/code0、二维码127字节、`https:`/`www.yuketang.cn`/默认端口/无userinfo。没有输出或保存实际二维码内容及票据，也未轮询、交换或完成认证。由实际协议和域名制作合成 fixture，未把真实登录材料写入仓库。
- 最小产品修复仅在既有 HTTPS 检查中增加精确 `https://www.yuketang.cn` origin；原微信白名单、未知来源拒绝、服务端生成 PNG 和浏览器不读取票据的行为保留。扩大原 API 回归覆盖官方雨课堂/微信正例，以及陌生域名、相似后缀域名、userinfo混淆和HTTP负例；共享 YKT fixture 改为雨课堂 origin 的合成链接。
- RED：`pnpm --filter @learning/web exec vitest run tests/api.test.ts -t 'renders an offline login QR'` 实际1 failed/1 passed，exit1，失败消息与用户截图一致（`qr-origin-red.log`）。修复后 Web **32/32**、SDK ykt-catalog **14/14**、CLI catalog **30/30**、Web/CLI interop **7/7**，共83通过，均 exit0；日志 `artifacts/web-ui/qr-origin-{web,sdk,cli,interop}-green.log`。Node24.11.1/pnpm11.19.0 下 lint、Web类型检查/构建、边界、设计检查与 diff检查均 exit0；既有 JS体积警告保留。GLM5.3/max只读复核无剩余必须修复项。
- 确认正式服务没有持有写锁的操作后，正常结束旧服务（exit0），并在相同 `LEARNING_HOME=/Users/uu/.learning` 和4311端口启动修复后的服务；已有账号、课程和任务保留。本次未做真实账号扫码确认、教学平台写入、付费模型、完整原生/远端矩阵或推送发布；下一步为用户刷新页面后重新获取二维码并自行完成手机验证。

### 2026-10-28 · PR 与合并准备

- 用户明确授权「开 PR 合并」。获取最新 `origin/main=622c468180a548c38318fc185989b45f7d7e7274`，同步 PR #31 的源码校验和文档归档规则；五处文档冲突保留当前 Web 范围与 main 的稳定约束。U01–U03、GUI 和二维码修复原文完整迁入本文件，`docs/PROGRESS.md` 保留短索引。GLM5.3/max 独立只读核对无内容遗漏，主线程另用逐字比较确认历史保留。
- 新增 Web workspace 后，原 CI 的全仓许可证收集把未打入 CLI 的 CQU Design 包也纳入，实际触发 `missing license text: @cqu-moe/theme`（exit1）。只将 CI 命令改为 `pnpm --filter @learning/cli... licenses list --prod --json`；保留 `package-licenses.mjs` 对每个发行依赖必须有正文的断言。实际读取 43 个 CLI/SDK 依赖，断言全部直接依赖存在、Web 专用依赖不在其中，再生成 `LICENSES.txt` 与校验文件，exit0。本机使用已安装 pnpm store；初次目录缺失、默认缓存不匹配和沙箱打不开缓存数据库均已排除，未修改依赖或锁文件。
- macOS arm64 / Node24.11.1 / pnpm11.19.0：`node --test scripts/test-source-lock.mjs` 11/11，源码清单检查（显式允许缺失参考目录）、SDK/CLI/Web 边界、`pnpm check:design`、`pnpm lint`、`node scripts/test-release.mjs`、许可证打包与 `git diff --check` 均 exit0。三个私有参考 checkout 明确 SKIP，不宣称已核对协议源码。既有产品回归沿用上文证据，最终完整检查由本 PR 的 CI 运行。
- 本轮没有升级 CLI 0.2.10、重启用户服务、发起真实平台操作或新增部署；合并不触发版本发布。下一步为推送、创建 PR、等待对应提交的完整 CI，核对 head 后合并，再核验 main 的自动检查。
