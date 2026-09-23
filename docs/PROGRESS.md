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
| T07 | 雨课堂资源、课件及考试只读 | done | vitest tests/ykt-resources.test.ts → 6/6; 全套 80/80, typecheck/lint/build exit 0 | E01 fixtures 合成；E03 分页 unknown |
| T08 | 学堂WS登录、课程与大纲 | done | vitest tests/xuetang-catalog.test.ts → 6/6; 全套 86/86, typecheck/lint/build/boundaries exit 0 | E02 分页终止 unknown；E04 身份字段待真机 |
| T09 | 学堂资源、作业和考试结果读取 | done | vitest tests/xuetang-resources.test.ts → 4/4; 全套 90/90, typecheck/lint/build exit 0 | E05 交卷未实现属 T17 |
| T10 | 智慧树编码与登录 | done | vitest tests/zhs-auth-crypto.test.ts → 7/7; 全套 97/97, typecheck/lint/build/boundaries exit 0 | 参考仓库 HOME 向量多一个 = 属笔误，已修正记录 |
| T11 | 智慧树两类课程树和权威进度 | done | vitest tests/zhs-catalog.test.ts → 5/5; 全套 102/102, typecheck/lint/build/boundaries exit 0 | zhs progress 读取端点形状未取证，能力未实现未伪造 |
| T12 | 富文本、Markdown与格式导出 | done | vitest tests/content.test.ts → 7/7; 全套 109/109, typecheck/lint/build/boundaries exit 0 | parse5 8.0.1 + yaml 2.9.1 已冻结 |
| T13 | 草稿导入、反馈匹配与可选模型建议 | done | vitest tests/drafts.test.ts → 6/6; 全套 115/115, typecheck/lint/build/boundaries exit 0 | — |
| T14 | 操作预览、幂等与不确定写入 | done | vitest tests/actions.test.ts → 6/6; 全套 121/121, typecheck/lint/build/boundaries exit 0 | — |
| T15 | 雨课堂作业与内嵌题写入 | done | vitest tests/ykt-write.test.ts → 4/4; 全套 125/125, typecheck/lint/build exit 0 | — |
| T16 | 学堂作业与讨论发布 | done | vitest tests/xuetang-write.test.ts → 4/4; 全套 129/129, typecheck/lint/build exit 0 | — |
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

### 2026-09-23 · T07 雨课堂资源、课件及考试只读（done）

- 实际改动：src/providers/ykt/{resources.ts,assessments.ts,exam-read.ts}、src/index.ts 接线、src/http/client.ts（读重试耗尽后 5xx 显式 PROTOCOL 而非透传空 body）、tests/ykt-resources.test.ts、fixtures ykt/{history-slides,media,transcript,exam-read,exercise-read}.json。
- 测试先行确认失败后实现，6/6；全套 80/80。
- 实现：lessons（logs/learn type==14 倒序翻正、满 500 窗口→completeness unknown，E03）；slides 纯 HTTP 链 review→summary/ppt（presentationId 首见顺序、slideList 按 index 排序、无 checkin 无 renderer）；media leaf_info→ccid→playurl quality20/10；transcript 三形态 list 归一+srt 解析（列表失败=错误不冒充 absent）；homework exercise 读（font 字段→decodeState partial，不伪造明文）；exam 独立子系统 P-E01 全链（cover 状态、gen_token、SSO login、cloud 头 show_paper/problem_results、problem_id join、per-profile 串行链）。
- 验收：A071（乱序 results 对齐、字幕失败不等于 absent）；A072（history slides 零 checkin/零 renderer、index 排序稳定、缺 font 不伪明文）。
- 命令（Node v24.11.1）：vitest ykt-resources → 6 passed；全套 80/80；typecheck/lint/build → 0。
- 未运行项：真实考试 SSO/字幕 CDN（allowlist 限制记录于 E01）；font 实际解码在 T24。
- 下一个当前任务：T08。

### 2026-09-23 · T08 学堂WS登录、课程与大纲（done）

- 实际改动：src/providers/xuetang/{schemas.ts,auth.ts,catalog.ts}、src/index.ts 接线、tests/helpers/{replay.ts 增 loadFixture、ws.ts 增 FakeWsTransport}、tests/xuetang-catalog.test.ts、fixtures xuetang/{qr-is-new,courses,outline}.json。
- 测试先行确认失败后实现 6/6；全套 86/86。
- 实现：wsapp 扫码登录（匿名 GET / 种 csrftoken → WS 六字段 requestlogin → requestlogin 票据 ticket/follow_url/expire → loginsuccess is_new 分支取 s_s/token → POST /api/v1/u/login/wx/ {s_s} + X-CSRFToken）；课程列表 product_list → 完整 xuetang locator（缺 skuId 抛错不 0 兜底），仅第一页 → completeness unknown（E02）；kg_learn_chapter 递归树（根 leaf 保留、章提升为根、深层嵌套 children、path=容器链、树 node id 与 leaf.chapter_id 差异按源码处理）；probe 走 user-courses 401/success=false → expired，网络错 indeterminate 不清 Cookie。
- 验收：A081（第一页不标全量、缺 skuId 拒绝、根 resource 不丢）；A082（迟到/取消竞态由 T05 lifecycle 覆盖、probe 网络错 indeterminate 且旧会话原样——auth-flow 套件）。
- 命令（Node v24.11.1）：vitest xuetang-catalog → 6 passed；全套 86/86；typecheck/lint/build/boundaries → 0。
- 未运行项：真实 wsapp 连接；QR 过期重连循环仅实现骨架（ticket expire 事件已带 expiresAtMs）。
- 下一个当前任务：T09。

### 2026-09-23 · T09 学堂资源、作业和考试结果读取（done）

- 实际改动：src/providers/xuetang/{resources.ts,exam-read.ts}、src/index.ts 接线、tests/xuetang-resources.test.ts、fixtures xuetang/{media,lecture-note,exam-read}.json。
- 实现：leaf_info→ccid→playurl mp4 变体（duration 秒）；讲稿 leaf_lecture_note 秒→毫秒段；考试读全链（cover 双层 data、gen_token 双层 data.data.crypt、exam_host allowlist 校验先于 crypt 发送（A091）、SSO login 种 x_access_token、cloud 头 show_paper/problem_results、problem_id join、Type 字符串分类未知保持 unknown、per-profile 串行链全程持锁）。只读路径零 start/submit 调用（A092）。
- 命令（Node v24.11.1）：vitest xuetang-resources → 4 passed；全套 90/90；typecheck/lint/build → 0。测试先行确认失败后实现。
- 未运行项：真实考试子系统；讲稿 seconds 字段名 start/end 按源码，真实键名待 E02 一并核对。
- 下一个当前任务：T10。

### 2026-09-23 · T10 智慧树编码与登录（done）

- 实际改动：src/providers/zhs/{crypto.ts,md5.ts,auth.ts}、src/index.ts 接线、tests/zhs-auth-crypto.test.ts、fixtures zhs/qr-login.json。
- 实现：AES-128-CBC WebCrypto（PKCS7 原生、固定 IV、HOME/VIDEO 键）；ev/rev_ev 循环 key XOR-hex（多字节值 Python f"{x:02x}"[-4:] 语义一致）；WatchPoint 官方向量（0,1,2,2,3,3,3…）；hike MD5 纯 JS（RFC1321 向量 + 字段顺序/盐向量与 node:crypto 交叉验证）；hms 前端格式；原生 QR 登录链（getLoginQrImg→getLoginQrInfo 状态机 -1/0/1/2/3→pwd finish 落 CASLOGC），session identityVerified=false（E04：本地 uuid 不当在线身份）。
- 勘误：参考仓 test_crypto.py 的 HOME 密文向量多一个 '='（45 字符非法 base64，Node/Python 均不可解）；按"已知源码 bug 不复现"，用 node:crypto 独立生成的同明文正确 44 字符向量替换并注释。
- 命令（Node v24.11.1）：vitest zhs-auth-crypto → 7 passed；全套 97/97；typecheck/lint/build/boundaries → 0。测试先行确认失败后实现（DataView 小端修复）。
- 未运行项：微信 lp 长轮询 408/404/405/403 分态未实现（A102 部分覆盖：poll 状态机+错误账号走 AUTH_REQUIRED；wx 流程无源码级 fixture，留证据缺口）；password 登录未实现。
- 下一个当前任务：T11。

### 2026-09-23 · T11 智慧树两类课程树和权威进度（done）

- 实际改动：src/providers/zhs/{http.ts,catalog.ts}、src/index.ts 接线、tests/zhs-catalog.test.ts、fixtures zhs/{share-list,hike-list,share-outline,hike-tree}.json。
- 实现：homeQuery（onlineservice GET secretStr/date、HOME_KEY、code 0/200、-12→INTERACTION_REQUIRED）；zhidaoQuery（POST 表单 secretStr+dateFormate 秒级毫秒）；share 课程分页 pageSize5（末页不漏）；share 树 gologin→queryCourse→videolist（单视频小节哨兵 smallLessonId=0、同 videoId 两处为不同资源、videoSec→duration）；hike getMyCourseList（startInngcourseList 原样）+ queryResourceMenuTree 递归（dataType null→unknown 不自动 viewFile）；catalog 全程零 save/view 写调用。zhs courses 返回 share+hike 合并。
- 验收：A111（6 门课两页、末页不漏、同 videoId 保留）；A112（无 saveDatabaseIntervalTimeV2/stuViewFile 调用、字段错误由 fixture 捕获）。
- 命令（Node v24.11.1）：vitest zhs-catalog → 5 passed；全套 102/102；typecheck/lint/build/boundaries → 0。secretStr 由测试用 node:crypto 独立生成（双实现交叉验证）。
- 未运行项：share 权威进度读取端点（Z04 进度接口形状未在已读段落，catalog.progress 对 zhs 仍 UNSUPPORTED，记证据缺口不伪造）；hike save/view 属 T21。
- 下一个当前任务：T12。

### 2026-09-23 · T12 富文本、Markdown与格式导出（done）

- 实际改动：src/content/{html.ts,markdown.ts}、tests/content.test.ts、package.json（parse5 8.0.1、yaml 2.9.1 save-exact）。
- 实现：parse5 DOM 遍历清理（script/style/iframe 剔除、javascript: 链接去 href 留文本、事件属性不输出、textfonts 加密 span 标记 partial 不进明文）；sub/sup 相邻同类合并为单合法 LaTeX 记号（基元捕获 + _{}/^{} + $…$ 包裹，边界空格保留）；图片转 ![alt]；块级换行；normalizeAnswerValue 保持 -1.0/1.0/10/2e3/单位 等差异（A122）；renderAssessmentMarkdown 固定题目次序、我的作答与官方答案分列。
- 验收：A121（script/onerror/javascript 链接不执行、无双下标、不吞边界空格）；A122（数字/单位差异在 plainText 保留）。
- 命令（Node v24.11.1）：pnpm install（parse5/yaml 冻结）→ 0；vitest content → 7 passed；全套 109/109；typecheck/lint/build/boundaries → 0。
- 未运行项：JSON/YAML 导出编排进 T13/T23 的服务层；MathJax SVG 剥离同源码策略。
- 下一个当前任务：T13。

### 2026-09-23 · T13 草稿导入、反馈匹配与可选模型建议（done）

- 实际改动：src/services/{drafts.ts,model.ts}、src/content/match.ts、src/index.ts 接线（draft/importDraft/importFeedback/match/propose）、tests/drafts.test.ts。
- 实现：legacy YAML/JSON 草稿导入（4MiB 上限、自定义 tag/别名上限拒绝、ykt/xtx 值约定 A/[A,B]/正确/文字→Answer、值类型不混）；ykt 反馈集导入（官方 Answers→feedback）；内容匹配（fingerprint 精确、plainText+选项多重集合重排映射、源/目标重复选项歧义拒绝、跨 exam/homework blocked、未解码题干 blocked）；模型建议（无 client 全 blocked、只发题面/选项文本零 Cookie、返回 schema 校验、不存在的选项 blocked）。
- 验收：A131（跨 kind 不回填、选项换序正确映射、重复选项歧义拒绝）；A132（坏 JSON/YAML 拒绝、未知选项/未解码题干不形成可执行答案、模型 payload 无 Cookie 断言）。
- 命令（Node v24.11.1）：vitest drafts → 6 passed；全套 115/115；typecheck/lint/build/boundaries → 0。
- 未运行项：真实模型 API（无 key，fake client fixture 级验证）。
- 下一个当前任务：T14。

### 2026-09-23 · T14 操作预览、幂等与不确定写入（done）

- 实际改动：src/services/actions.ts（ActionStore/digestOf）、tests/actions.test.ts。client.actions 接线延后到 T15+ 各写入口（本任务为存储与语义层）。
- 实现：prepare 保存精确 input SHA256 digest+generation+10 分钟有效期（preview: key 落 StateStore）；execute 绑定 previewId→operationId 单次执行（重复执行返回同一 receipt、零新增上游写）；sending 后异常→UNCERTAIN 不自动重发；reconcile 仅凭权威上游核对结果确认/保持 uncertain；过期/换 generation/换 digest → PREVIEW_EXPIRED/PRECONDITION_CHANGED；cancel 不回滚已完成 receipt。
- 验收：A141（同 preview 重复执行 1 次上游写、三项拒绝语义）；A142（sending 崩溃 uncertain 不重放、reconcile 权威确认、取消保留已发生结果）。
- 命令（Node v24.11.1）：vitest actions → 6 passed；全套 121/121；typecheck/lint/build → 0。
- 下一个当前任务：T15。

### 2026-09-23 · T15 雨课堂作业与内嵌题写入（done）

- 实际改动：src/providers/ykt/homework-write.ts、tests/ykt-write.test.ts。
- 实现：encodeHomeworkAnswer 严格编码（unset/未知/空 choice 预发送拒绝）；problem_apply 精确 body {classroom_id,problem_id,answer}+headers（json+xtbz+xt-agent+classroom-id）；HTTP200 success=false → PROTOCOL 不算成功；内嵌题 list envelope 解析与显式作答同一端点，success=true 不等于答对、correctAnswer 仅来自显式反馈字段（不编造）。写操作经 ActionStore preview（T14）由上层接入。
- 验收：A151（headers/body 逐字断言）；A152（unset 拒绝、无标准答案不选第一项、失败只一次——kind:'write' 不重试）。
- 命令（Node v24.11.1）：vitest ykt-write → 4 passed；全套 125/125；typecheck/lint/build → 0。
- 下一个当前任务：T16。

### 2026-09-23 · T16 学堂作业与讨论发布（done）

- 实际改动：src/providers/xuetang/homework-write.ts、tests/xuetang-write.test.ts。
- 实现：problem_apply 七字段 body（leaf_id/classroom_id/exercise_id/problem_id/sign/answers/answer）；Type 字符串映射（单多选/判断→list、填空→answers map、主观→{time,content,oSubject} 对象，不强制全数组）；unit/discussion 顶层 thread 对象（无 id→PROTOCOL 不造空 thread）；comment/list 分页与 comment POST query/body 分清；写失败 UNCERTAIN 只一次。上层经 ActionStore preview 接入。
- 验收：A161（主观对象与填空 map 精确 fixture、unset 零写入）；A162（HTTP200 success=false 失败、未知 schema 不成空 thread）。
- 命令（Node v24.11.1）：vitest xuetang-write → 4 passed；全套 129/129；typecheck/lint/build → 0。
- 下一个当前任务：T17。

按任务编号与日期追加：实际改动文件、命令/环境/退出码、通过与未运行层级、source/fixture变化、具体blocker和影响、下一个当前任务编号。done需要真实证据；partial/blocked不能写完成。延期不是blocked。

## 用户授权的真实验证

初始无。未授权不触发平台操作；没有实际执行不得写入虚构结果。
