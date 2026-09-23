# learning — SDK + CLI 本期实施状态

版本1.1。此文档包只完成规范修改，没有产品实现。以下是**新项目初始模板**；如果已有真实PROGRESS与代码，按任务编号合并，绝不覆盖完成记录或把已完成任务重置。当前分母为28项，T27–T30延期。

| 任务 | 内容 | 状态 | 实际测试命令/退出码 | 阻塞 |
|---|---|---|---|---|
| T00 | 固定源码与证据目录 | done | node scripts/check-source-lock.mjs → exit 0 | — |
| T01 | 两包工作区与本地构建入口 | done | pnpm install --frozen-lockfile / typecheck / build / lint / node scripts/check-boundaries.mjs → 全部 exit 0 | — |
| T02 | DTO、稳定标识与测试内存存储 | done | pnpm --filter @learning/sdk exec vitest run tests/types.test.ts → 20/20 exit 0 | — |
| T03 | 本地StateStore和加密会话记录 | done | vitest tests/store.test.ts → 19/19, typecheck/build/lint/boundaries exit 0 | E08 Node24 本机实测已由本任务覆盖 SQLite/crypto 部分 |
| T04 | HTTP、Cookie、重定向与协议fixture工具 | done | vitest tests/http.test.ts → 14/14; 全套 53/53, typecheck/build/lint/boundaries exit 0 | — |
| T05 | 统一登录生命周期、WS和SDK工厂 | done | vitest tests/auth-flow.test.ts → 14/14; 全套 67/67, typecheck/lint/build/boundaries exit 0 | — |
| T06 | 雨课堂登录、课程与两类大纲 | done | vitest tests/ykt-catalog.test.ts → 7/7; 全套 74/74, typecheck/lint/build/boundaries exit 0 | E04 身份字段仅 fixture；真实登录未执行 |
| T07 | 雨课堂资源、课件及考试只读 | not-started | 未运行 | — |
| T08 | 学堂WS登录、课程与大纲 | not-started | 未运行 | — |
| T09 | 学堂资源、作业和考试结果读取 | not-started | 未运行 | — |
| T10 | 智慧树编码与登录 | not-started | 未运行 | — |
| T11 | 智慧树两类课程树和权威进度 | not-started | 未运行 | — |
| T12 | 富文本、Markdown与格式导出 | not-started | 未运行 | — |
| T13 | 草稿导入、反馈匹配与可选模型建议 | not-started | 未运行 | — |
| T14 | 操作预览、幂等与不确定写入 | not-started | 未运行 | — |
| T15 | 雨课堂作业与内嵌题写入 | not-started | 未运行 | — |
| T16 | 学堂作业与讨论发布 | not-started | 未运行 | — |
| T17 | 学堂考试的三个独立动作 | not-started | 未运行 | — |
| T18 | 固定任务模型、暂停恢复与事件 | not-started | 未运行 | — |
| T19 | 雨课堂学习任务 | not-started | 未运行 | — |
| T20 | 学堂学习任务 | not-started | 未运行 | — |
| T21 | 智慧树share/hike学习任务 | not-started | 未运行 | — |
| T22 | 雨课堂实时会话与事件缺口 | not-started | 未运行 | — |
| T23 | 流式下载、持久产物与断点恢复 | not-started | 未运行 | — |
| T24 | 本地PDF与字体重型实现 | not-started | 未运行 | — |
| T25 | CLI基础命令与本地运行装配 | not-started | 未运行 | — |
| T26 | CLI完整功能入口与恢复操作 | not-started | 未运行 | — |
| T31 | SDK与CLI集成验收、安装说明与本机证据 | not-started | 未运行 | — |

## 延期（不计本期分母，不是下一任务）

T27 Web登录/UserDO、T28 API/DO/R2/Cloudflare Runtime、T29页面/Web E2E、T30云端Containers，以及旧T31云部署验收，全部deferred。当前T31仅SDK/CLI本机验收。完成当前T31后停止。

## 每次实际记录

### 2026-09-23 · T00 固定源码与证据目录（done）

- 仓库初始化：git init -b main；创建 GitHub 私有仓库 cqu-moe/learning 并推送初始文档提交（用户明确授权）。Git 身份使用已有全局配置，未改动。
- 实际改动：.gitignore、scripts/check-source-lock.mjs、docs/source-lock.json、docs/protocol-evidence.md、docs/PROGRESS.md；.reference/{ykt-cli,xuetang-cli,zhs-cli}（gitignored，从本机同 ref 检出克隆，checkout --detach 固定 commit，只读，未运行旧 CLI）。
- 测试先行：先运行 node scripts/check-source-lock.mjs，按预期失败（source-lock.json 缺失，exit 1）；实现后重跑通过（3 repositories locked and checked out at fixed refs，exit 0）。环境：Node v22.22.3（本脚本不依赖 Node 24 特性；工具链版本在 T01 固定）。
- 补读（只读）：ykt src/download/exam.py 完整网络链（cover/gen_token/SSO login/show_paper/problem_results、xtbz=cloud、errcode 10006/10007/10107、逐考试串行）；xtx src/run/api.py + orchestrator.py schedule 回读（leaf_schedules、异步统计轮询、credited 续播）；旧草稿 YAML 格式（ykt/xtx scaffold 字段、answers 值约定、ProblemType 1/2/6/4、(exercise_id, problem_id) 定位、0.82 相似度回填）。证据记入 docs/protocol-evidence.md P-E01/P-E02/P-E03。
- 未运行项：未做任何真实平台请求/抓包（无授权）；未运行旧 CLI；workerd/云端取证延期。E01 fixtures、E02 分页终止、E03 lesson 分页/字体字段、E04 身份字段仍为证据缺口，只阻塞对应能力，不阻塞 T01/T02。
- 下一个当前任务：T01。

### 2026-09-23 · T01 两包工作区与本地构建入口（done）

- 实际改动：package.json、pnpm-workspace.yaml、tsconfig.base.json、eslint.config.mjs、packages/sdk/{package.json,tsconfig.json,tsconfig.build.json,src/index.ts,src/public.ts}、apps/cli/{package.json,tsconfig.json,tsconfig.build.json,src/index.ts}、scripts/check-boundaries.mjs、docs/toolchain.md、docs/PROGRESS.md、pnpm-lock.yaml。
- 测试先行：先运行 node scripts/check-boundaries.mjs，按预期失败（两包 manifest/workspace/入口均缺失，exit 1）；实现后通过（含 node: 内置与 runtime/node 泄漏负例自检）。
- 实际命令（全部前置 Node v24.11.1 PATH）：pnpm install → exit 0；pnpm install --frozen-lockfile（A011 二次）→ exit 0；node scripts/check-boundaries.mjs → exit 0（A012）；pnpm typecheck → exit 0；pnpm build → exit 0；pnpm lint → exit 0；node apps/cli/dist/index.js --version → exit 0。期间修复：apps/cli 缺 @types/node（补 24.13.6）；scripts/*.mjs 的 Node globals lint 配置与一处无用赋值。
- 工具链冻结：typescript 5.9.3（typescript-eslint peer <6.1.0 排除 7.x）、zod 4.6.5、vitest 5.0.1、@types/node 24.13.6、eslint 10.11.0、@eslint/js 10.0.1、typescript-eslint 8.70.1；记录于 docs/toolchain.md。
- 边界证据：workspace 恰好 packages/sdk + apps/cli；无 apps/web、apps/executor、runtime/cloudflare；依赖无 React/Vite/Hono/Wrangler/Cloudflare；根脚本仅 lint/typecheck/test/build/cli；SDK exports 当前仅 "." 与 "./public"（./node→T03、./render-node→T24）；public/root 静态导入图干净。
- 未运行项：pnpm test（尚无测试文件，--passWithNoTests 占位语义已记录，不作为通过证据）；真实平台操作无授权未执行。
- 下一个当前任务：T02。

### 2026-09-23 · T02 DTO、稳定标识与测试内存存储（done）

- 实际改动：packages/sdk/src/types/{sha256.ts,refs.ts,models.ts,errors.ts}、packages/sdk/src/public.ts、packages/sdk/tests/helpers/memory.ts、packages/sdk/tests/types.test.ts、docs/PROGRESS.md。
- 测试先行：先写 tests/types.test.ts（sha256 已知向量、key 数组与 node:crypto 交叉验证、A021/A022 断言、MemoryStateStore 契约）并运行确认预期失败（模块缺失，加载失败 exit 1）；实现后 20/20 通过。
- 实现：纯 TS SHA-256（FIPS 180-4，无 node:crypto，测试用 node:crypto 与官方向量双交叉验证）；safeId 拒绝空串/空白/"0"/NaN/Infinity/超出安全整数（zhs smallLessonId="0" 显式例外）；keyOfCourse/keyOfResource 按 S02 固定数组 SHA256(JSON.stringify(...))，resource key 含 course key，leafInfoId null 显式保留；Zod DTO 覆盖 contracts.d.ts 全部公开数据契约（refs/models/errors 分域）；public.ts 只导出 DTO/schema，不含 Runtime/Session/Cookie；LearningError 携带安全 ErrorData；MemoryStateStore 乐观并发 commit 原子校验 revision，支持 prefix/cursor 分页与 null 删除。
- 验收对照：A021（同 videoId 不同 smallLessonId key 不同；不同 userId/profileId 绝不相同——直接断言）；A022（未知 "0"/空/空白/NaN/Infinity/超安全整数 ID 拒绝；smallLessonId="0" 例外；Page completeness unknown 不被改写为 complete）。OutlineNode 允许 children 与 resources 并存（测试覆盖）。
- 实际命令（Node v24.11.1）：pnpm --filter @learning/sdk exec vitest run tests/types.test.ts → 20 passed, exit 0；根 pnpm typecheck → exit 0；pnpm build → exit 0；pnpm lint → exit 0；pnpm test → exit 0（SDK 20/20；CLI 无测试文件属预期，T25 落地）；node scripts/check-boundaries.mjs → exit 0（public 图仍干净）；node scripts/check-source-lock.mjs → exit 0。期间修复：测试字面量类型收窄、类型导入、unsafe 数字字面量改用 Number.MAX_SAFE_INTEGER+1。
- 未运行项：无网络/平台操作；schema 仅覆盖 public 数据契约，provider wire schema 属 T06+。
- 下一个当前任务：T03。

### 2026-09-23 · T03 本地StateStore和加密会话记录（done）

- 实际改动：packages/sdk/src/runtime/types.ts（内部 StateStore/StoredValue 契约）、src/runtime/node/{state.ts,index.ts}、src/session/{crypto.ts,store.ts}、packages/sdk/package.json（新增 ./node 出口）、tests/store.test.ts、docs/PROGRESS.md。
- 测试先行：先运行 vitest tests/store.test.ts 按预期失败（runtime/node、session 模块缺失，exit 1）；实现后 19/19 通过（内存与 SQLite 跑同一 contract 套件）。
- 实现：node:sqlite DatabaseSync 单表 records + schema_meta(version=1)，BEGIN IMMEDIATE 事务内先验 expected 再批量写入，冲突整体回滚；LIKE 前缀转义 + 游标分页；AES-GCM（WebCrypto，随机 12 字节 IV，AAD=JSON[version,recordKind,userId,profileId,platform]，iv.ct base64）；readSession/writeSession/revokeSession 私有模块，tombstone 拒绝旧 generation 复活（CONFLICT），错误 user/platform 同 key 解密失败；loadOrCreateMasterKey 0600。
- 验收对照：A031（一组 revision 冲突全部不改、双 key 原子、null 删除约定）由内存+SQLite 双套件断言；A032（错误 user/profile AAD 解密失败、旧 generation 不能覆盖 tombstone、存储失败抛 STORAGE/CONFLICT 不静默成功）。
- 实际命令（Node v24.11.1）：vitest run tests/store.test.ts → 19 passed；根 typecheck/build/lint → exit 0；check-boundaries → exit 0（./node 出口有真实源文件对应，public 图不含 Node 实现）。修复过程：SQLite LIKE 前缀转义 bug（通配符被转义）、CryptoKey 类型与 union 判别。
- 未运行项：无网络/平台操作；node:sqlite ExperimentalWarning 已观察，属 Node 24 已知状态。
- 下一个当前任务：T04。

### 2026-09-23 · T04 HTTP、Cookie、重定向与协议fixture工具（done）

- 实际改动：packages/sdk/src/http/{client.ts,cookies.ts,retry.ts,errors.ts}、src/runtime/types.ts（补 Transport/Socket/Clock 声明）、tests/helpers/replay.ts（FakeClock/FakeTransport/replay 工具）、tests/http.test.ts、tests/fixtures/http/simple-read.json、package.json（新增 tough-cookie 6.0.2）、docs/toolchain.md 未变（版本已记 PROGRESS）。
- 测试先行：先运行 vitest tests/http.test.ts 按预期失败（http 模块缺失，exit 1）；实现后 14/14，全套 53/53。
- 实现：tough-cookie 完整 jar（domain/path/hostOnly/Expires 逗号/多 Set-Cookie）；SessionHttp 每跳 redirect:'manual'、allowlist 点边界后缀校验、私网/环回跳转拒绝、跨源剥除 authorization/x-csrf-token/x-client-st/x-access-token 后按目标重选 Cookie；读请求最多 3 次总尝试（500ms 起 10s 封顶，Retry-After 秒/HTTP-date），写请求不重试、响应丢失 UNCERTAIN；200 错误 body 原样交给 provider envelope；replay 工具逐条校验 method/host/path/query/headers/body 与顺序、未登记请求立即失败、结束断言全部消费。
- 验收对照：A041（同名不同 domain/path/hostOnly、Expires 逗号、多 Set-Cookie、恶意后缀 evilyuketang.cn/私网 127.0.0.1 拒绝）；A042（写响应丢失仅 1 次请求且 UNCERTAIN、读取消立即 CANCELED、HTTP200 错误 body 不变空）。
- 实际命令（Node v24.11.1）：pnpm install（tough-cookie 6.0.2 save-exact）→ exit 0，二次 --frozen-lockfile → exit 0；vitest run tests/http.test.ts → 14 passed；根 typecheck/lint/build → exit 0；check-boundaries → exit 0。修复过程：SessionCookieJar 未再导出、hostOnly 跨子域测试场景修正、LIKE/类型细节。
- 未运行项：真实网络请求未执行（fixture 均为 synthetic 且标注 source ref）。
- 下一个当前任务：T05。

### 2026-09-23 · T05 统一登录生命周期、WS和SDK工厂（done）

- 实际改动：src/runtime/types.ts（补 Options/BlobWriter/ArtifactStore/HeavyRenderer/ModelClient/Runtime/Socket/Transport/Clock）、src/auth/{flow.ts,legacy.ts}、src/runtime/node/transport.ts（NodeFetchTransport/NodeSocket）、src/types/client.ts（LearningClient 接口）、src/index.ts（createLearningClient/aggregateCourses 真实实现）、tests/helpers/ws.ts、tests/auth-flow.test.ts。
- 测试先行：先运行 vitest tests/auth-flow.test.ts 按预期失败（auth/runtime 模块缺失，exit 1）；实现后 14/14。
- 实现：AuthLifecycle 管理 generation（新 begin 取代旧 flow）、惰性 10 分钟总预算（超时 TIMEOUT）、cancel 销毁临时票据并 reject CANCELED、迟到/superseded finish 静默丢弃不写会话；probeSession 将网络/超时错误映射 indeterminate 且不动既有 Cookie；importLegacyCookies 纯本机 cookie-array 导入（identityVerified=false、generation+1）；NodeSocket 基于原生 WebSocket，邮箱 256 帧/单帧 1MiB 上限（超限 PROTOCOL 并关闭）；createLearningClient 工厂零网络（构造/capabilities 均不请求），未实现 provider 方法显式 UNSUPPORTED 不返回空列表；aggregateCourses 按 profile 独立成功/错误保持顺序。平台 allowhost：ykt=yuketang.cn+xuetangx.com（考试子系统）、xuetang=xuetangx.com、zhs=zhihuishu.com（源码核对）。
- 验收对照：A051（cancel 后 pushLateSuccess 不写会话、socket/timer 释放；旧 QR 迟到确认不能覆盖新 generation——lifecycle 级断言）；A052（probe 网络错 indeterminate 且旧会话原样；工厂/importLegacy cookie-array 零网络请求）。PLAN 片段按 lifecycle 等价实现（provider 接入在 T06/T08/T10）。
- 实际命令（Node v24.11.1）：vitest run tests/auth-flow.test.ts → 14 passed；全套 67/67；根 typecheck/lint/build → exit 0；check-boundaries → exit 0。
- 未运行项：真实平台 WS/HTTP 未连接；ykt/xuetang/zhs provider 方法按计划在 T06+。
- 下一个当前任务：T06。

### 2026-09-23 · T06 雨课堂登录、课程与两类大纲（done）

- 实际改动：src/providers/ykt/{schemas.ts,auth.ts,catalog.ts}、src/index.ts（ykt auth/catalog 接线、能力表、jar 惰性水合）、tests/ykt-catalog.test.ts、tests/fixtures/ykt/{nested-outline,kg-outline,courses-list,qr-login}.json。
- 测试先行：先运行 vitest tests/ykt-catalog.test.ts 按预期失败（provider 缺失，exit 1）；实现后 7/7。
- 实现：纯 API 扫码登录三步链（pre-info→app-web-login 长轮询（TIMEOUT=等待、404=换码）→/pc/web_login form 编码→userinfo 校验），AuthLaunch 挂入 T05 lifecycle；课程列表 errcode 信封→Course DTO（classroomId 稳定 key）；classroom 上下文（course_sign/free_sku_id/uv_id）独立获取；has_kg 带全套决定头（xtbz+university-id+uv-id+classroom-id+xt-agent），success=false 抛 PROTOCOL 与 has:false 分开；standard 异构 section_leaf_list 递归展开（folder 进 children、直挂 leaf 进 resources、空 folder 不成伪资源、缺 id 拒绝）；KG children/leaf_list 双递归、根级 leaf 保留为前置章；leaf_type 0/3/5/6→video/document/exam/homework；小节路径进 path。
- 验收对照：A061（fixture 逐头校验 xtbz/university-id 等，缺一即 mismatch 失败；kg false 与请求失败分开——parseHasKg 断言）；A062（根考试+深层资源同时保留、空 folder 不成资源、缺 leafId 抛错不 0 兜底）。
- 实际命令（Node v24.11.1）：vitest run tests/ykt-catalog.test.ts → 7 passed；全套 74/74；typecheck/lint/build → exit 0；check-boundaries → exit 0。T05 的两个 UNSUPPORTED 断言按计划改用 xuetang 平台（ykt 已实现属预期演进）。
- 未运行项：真实平台登录/课程读取（无授权）；userinfo data.id/name 字段形状来自源码+合成 fixture，E04 身份字段待真机核对。
- 下一个当前任务：T07。

按任务编号与日期追加：实际改动文件、命令/环境/退出码、通过与未运行层级、source/fixture变化、具体blocker和影响、下一个当前任务编号。done需要真实证据；partial/blocked不能写完成。延期不是blocked。

## 用户授权的真实验证

初始无。未授权不触发平台操作；没有实际执行不得写入虚构结果。
