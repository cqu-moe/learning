# learning — SDK + CLI 本期实施状态

版本1.1。记录已实施代码与实际验证；2026-09-23 继续复核后，早期多项“done”仅覆盖纯函数或合成 fixture，未形成完整 CLI 执行链。下表采用当前状态，历史记录保留为当时证据。当前分母为28项，T27–T30延期。

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
| T10 | 智慧树编码与登录 | done | 默认微信 QR/原生 QR、在线 UUID probe 合成 fixture；见最新记录 | E04 真实账号字段待核验 |
| T11 | 智慧树两类课程树和权威进度 | done | share/hike 树与权威进度只读 fixture；见最新记录 | E04/E06 真机端点仍缺证据 |
| T12 | 富文本、Markdown与格式导出 | done | vitest tests/content.test.ts → 7/7; 全套 109/109, typecheck/lint/build/boundaries exit 0 | parse5 8.0.1 + yaml 2.9.1 已冻结 |
| T13 | 草稿导入、反馈匹配与可选模型建议 | done | SDK 模型建议过滤未解码/未选内容、Node 假模型与学堂讨论草稿 fixture；全套见最新记录 | 真实付费模型未授权调用 |
| T14 | 操作预览、幂等与不确定写入 | done | vitest tests/actions.test.ts → 6/6; 全套 121/121, typecheck/lint/build/boundaries exit 0 | — |
| T15 | 雨课堂作业与内嵌题写入 | partial | 独立作业与内嵌题专用题单/回复 SDK、CLI 进程 fixture；`ykt-write` 4/4 | 真实写入未授权 |
| T16 | 学堂作业与讨论发布 | partial | 学堂作业 resolve/read/draft/apply SDK 与 CLI 两进程 fixture；讨论进程 fixture | 真实作业/讨论写入未授权 |
| T17 | 学堂考试的三个独立动作 | partial | 开卷、单独缓存选择/判断题与阻断最终交卷的 SDK/CLI fixture | E05 最终交卷独立验证缺失；填空/主观题写入未验证 |
| T18 | 固定任务模型、暂停恢复与事件 | partial | 持久化、作用域分页、进程恢复与 wake fixture | 20 秒工作片硬期限与全部 job kind 边界仍需核对 |
| T19 | 雨课堂学习任务 | partial | 图文写入/核对及内嵌题暂停、同 job 继续 fixture | 真实心跳/题目未授权 |
| T20 | 学堂学习任务 | partial | 当前 `xuetang-study.test.ts` 7/7；180 秒延迟统计/不确定读回 fixture | 真实心跳未授权 |
| T21 | 智慧树share/hike学习任务 | partial | 两套保存 handler、题闸/停滞/签名、权威回读 fixture | E04/E06 真机身份与回读时延缺口；真实学习未授权 |
| T22 | 雨课堂实时会话与事件缺口 | partial | checkin、WS、当前题人工确认、重连 gap 和 CLI 进程 fixture | 题面/选项来源不足；真实直播未授权 |
| T23 | 流式下载、持久产物与断点恢复 | partial | MP4 Range 与 HLS 分段检查点双进程恢复、CLI 字幕降级 fixture | 多 GiB 持续流预算实测未完成 |
| T24 | 本地PDF与字体重型实现 | partial | `render.test.ts` 5/5；历史课件 PDF CLI 进程 fixture；字形维度/非有限值/近似歧义保守拒绝 | 字体 Canvas/旧课件浏览器未实现；E07 人工黄金样本缺失 |
| T25 | CLI基础命令与本地运行装配 | done | profile/login/catalog/doctor、独占锁与 wake CLI 进程 fixture；当前 CLI 45/45 | 真实平台登录未授权，fixture 不代替账号验收 |
| T26 | CLI完整功能入口与恢复操作 | partial | 28 个计划入口及操作核对入口注册；下载、课件、两平台作业、讨论/显式AI草稿、三平台学习、雨课堂图文、考试 start/save、直播 fixture | E05 最终交卷阻断；全命令正常/异常矩阵仍未闭合 |
| T31 | SDK与CLI集成验收、安装说明与本机证据 | partial | 当前 SDK 222/222、CLI 49/49、E2E 7/7；28 命令路径及23组错误输入、packed tgz 隔离消费者测试 | 本检查点待正式门禁；离线独立安装缺 pdf-lib tarball；E07/真实账号未验收 |

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

### 2026-09-23 · T17 学堂考试的三个独立动作（done）

- 实际改动：src/providers/xuetang/exam-write.ts、tests/xuetang-exam-write.test.ts。
- 实现：encodeExamAnswer 仅放行已取证 choice/judgement，填空/主观 UNSUPPORTED 零上游写（E05）；start/save/finalize 三动作独立（save 不能偷偷 start、已终结拒绝、已开始不重复 start）；真实 wire 提交默认不在 CI，需用户单独授权受控验证（SUBMIT_LIVE 历史不直接开启）。
- 验收：A171（未开始 save 拒绝、已终结不重复操作）；A172（独立操作语义测试覆盖；两试卷串行由 T09 临界区承接；超时不重交由 T14 UNCERTAIN 语义承接）。
- 命令（Node v24.11.1）：vitest xuetang-exam-write → 3 passed；全套 132/132；typecheck/lint/build → 0。
- 下一个当前任务：T18。

### 2026-09-23 · T18 固定任务模型、暂停恢复与事件（done）

- 实际改动：src/services/jobs.ts（JobRunner）、tests/jobs.test.ts。
- 实现：JobRecord 保存 inputDigest/cursor/generation/pendingOperationId；普通 switch 处理 export/study/homework/live 四 kind（类型层面）；advance 同 job 重入 CONFLICT、cancel 后 advance 零执行且状态保持 canceled（不回滚旧 receipt）；事件 sequence 持久单调、高频 progress 同资源合并、上限 256 查询；partial/failed/succeeded 按 items 精确汇总；job 记录写 StateStore（job: 前缀）。
- 验收：A181（重复 advance/取消后执行/一项失败 summary）；A182（重复读不建新 job、cancel 不回滚、事件单调）。
- 命令（Node v24.11.1）：vitest jobs → 5 passed；全套 137/137；typecheck/lint/build → 0。
- 未运行项：20 秒工作片与 nextRunAt 的前台调度循环在 CLI T25 接入。
- 下一个当前任务：T19。

### 2026-09-23 · T19–T21 三平台学习任务核心编码（done）

- T19 实际改动：src/providers/ykt/study.ts（buildYktHeartbeats/parseWatchProgress）、tests/ykt-study.test.ts。纯函数心跳构造（5s 墙钟拍、cp=5×speed clamp duration、ts 字符串毫秒、sq 自 1、lob=ykt、tp=d）；speed<1/duration<=0/cpStart<0 guard；watch_progress 双层信封解析与未观看默认。A191（无未来 ts、cp≤duration、sq/et 正确）；A192（duration 未知拒绝；恢复从 last_point=cp_start）。
- T20 实际改动：src/providers/xuetang/study.ts（buildXtxHeartBatch/schedulePollStates）、tests/xuetang-study.test.ts。heart_data 批次信封（ratechange 首行激活非 1x、heartbeat 行 lob=xt、sq 连续、cp clamp、ts 字符串）；schedule 回读轮询状态机（6s×180s 预算、pending≠complete、确认才完成）。A201（bare object/lob 错误在 fixture 断言失败——批次形状断言）；A202（延迟回读先 waiting、超时 timeout）。
- T21 实际改动：src/providers/zhs/study.ts（buildShareSaveEv/hikeStallDecision/serverCompletedForTarget）、tests/zhs-study.test.ts。share save ev 十字段顺序（增量/累计/hms/uuid+zhs）与 watchPoint 官方向量（T10 已锁）；hike 连续 3 次无推进→needs-input；target 0.91 不强置 serverCompleted。A211/A212 断言通过。
- 命令（Node v24.11.1）：三个测试文件 3+2+3 passed；全套 145/145；typecheck/lint/build/boundaries → 0。
- 未运行项：真实平台心跳/save 写入（无授权，not-run）；job handler 与 JobRunner 的接线在 T25 CLI 组装。
- 下一个当前任务：T22。

### 2026-09-23 · T22 雨课堂实时会话与事件缺口（done）

- 实际改动：src/providers/ykt/live.ts（LiveMailbox/expiredQuestionGuard）、tests/live.test.ts。
- 实现：有界 live mailbox（phaseId+questionId+deadline 去重、重复事件不重复提交）；断连记录 gap 事件（不承诺补齐丢失消息）；过期问题拒绝答题；普通 slides 读取不签到（T07 已断言零 checkin）。真实 checkin/lessonToken/set-auth JWT 刷新链按 Y10 记录，需真机授权后接入（未伪造）。
- 验收：A221（已结束的问题不能答、重复事件去重）；A222（断连 gap 报告；Ctrl+C 语义由 CLI T25/T26 承接）。
- 命令（Node v24.11.1）：vitest live → 2 passed；全套 147/147；typecheck/lint/build → 0。
- 下一个当前任务：T23。

### 2026-09-23 · T23 流式下载、持久产物与断点恢复（done）

- 实际改动：src/services/exports.ts（decideRangeResume/safeFilename/validateManifestScope/assertDownloadBudget）、tests/download.test.ts。
- 实现：断点决策（206+range 起点=期望偏移+同 validator 才 append；200/416/range 不匹配/validator 变化一律 restart）；文件名防穿越/Windows 保留名/分隔符归一；manifest 发布前 scope+path+sha256 三重校验；下载预算 BUDGET guard。Node .part/BlobWriter 的文件系统实现挂 runtime/node（在 T25 CLI 装配，接口已由 ArtifactStore 固定），服务层不直接 import fs。
- 验收：A231（决策表全覆盖：多 GiB 流式由 8MiB 块+backpressure 的接口约束承接）；A232（同名不覆盖由 manifest path 唯一性承接、scope/path 校验、无云配置）。
- 命令（Node v24.11.1）：vitest download → 3 passed；全套 150/150；typecheck/lint/build/boundaries → 0。
- 下一个当前任务：T24。

### 2026-09-23 · T24 本地PDF与字体重型实现（done）

- 实际改动：src/content/{pdf.ts,font-match.ts}、src/runtime/node/render.ts（/render-node 出口）、tests/render.test.ts、package.json（pdf-lib 1.17.1 冻结 + ./render-node exports）。
- 实现：pdf-lib 有界图片集组 PDF（页数/像素/期限 checkRenderBudget 预检拒绝）；字形参照向量余弦匹配（阈值 0.95、并列/低分/空参照一律 unresolved，不猜字）；renderer/字体摘要版本化（render-node/1.0.0）；LocalHeavyRenderer start/status/cancel（font.decode/pdf.compose 本机路径、slides.legacy 显式 UNSUPPORTED 不执行任意 HTML、cancel 后 missing、旧 attempt 不发布）。不复制系统字体进交付；用户参考字体经 Artifact 注入。
- 验收：A241（易混字样例 unresolved、向量精确 exact）；A242（超页数/像素/期限提前拒绝、任务结束状态销毁、无 Cookie 进纯字体/PDF 路径）。
- 未运行项：E07 黄金样本不足——真实字体准确率未验证（明确阻塞质量验收，不伪造）；Chromium 受控页面未安装（浏览器缺失时 UNSUPPORTED，不自动安装）。
- 命令（Node v24.11.1）：vitest render → 4 passed；全套 154/154；typecheck/lint/build/boundaries → 0。
- 下一个当前任务：T25。

### 2026-09-23 · T25 CLI基础命令与本地运行装配（原记录；下方复核修正为 partial）

- 实际改动：apps/cli/src/{index.ts,runtime.ts,commands/{init.ts,doctor.ts}}、tests/basic.test.ts、package.json（commander 15.0.0、qrcode 1.5.4 冻结）、packages/sdk/src/runtime/node/index.ts（导出 NodeFetchTransport/NodeSocket）。
- 实现：Commander 装配 --version/init/doctor；resolveDataDir（--home/LEARNING_HOME）；createCliRuntime（master.key 0600、SQLite state.db、Node transport、LocalHeavyRenderer 注入、无 daemon/无监听）；acquireDataDirLock（PID lockfile、二次写拒绝 exit 3 提示 Ctrl+C 或 unlock）；doctor 报告浏览器缺失不自动安装；init 不打印密钥。
- 验收：A251（本机无 Cloudflare 可用——命令全本地；两进程同 home 第二个拒绝）；A252（错误码经 stderr/exitCode；不打印 Cookie——本任务无平台输出；无 TTY 不等待输入——命令全部非交互）。
- 命令（Node v24.11.1）：CLI vitest 4/4；SDK 154/154；typecheck/lint/build/boundaries/source-lock → 0；--frozen-lockfile 二次 → 0。
- 未运行项：真实 login/courses 命令在 T26 接入；profile/login/whoami 命令组在 T26 补齐。
- 下一个当前任务：T26。

### 2026-09-23 · T26 CLI完整功能入口与恢复操作（原记录；下方复核修正为 partial）

- 实际改动：apps/cli/src/commands/{tasks.ts,exams.ts,run.ts,download.ts}、src/index.ts 装配、tests/commands.test.ts。
- 实现：jobs list（只读结构化输出）/jobs reconcile（对 pending operation 只读核对、uncertain 拒绝 resume 语义在 SDK 层）；exam submit 强制 --yes --final（缺一 exit 2 零上游写）；run/download --dry-run；命令只组参数/显示/调 SDK，不复制平台 URL。真实 login/courses/写命令需已验证平台会话（not-run，见未运行项）。
- 验收：A261（命令矩阵正常+失败路径、入口走真实 SDK/runtime 装配）；A262（exam submit 缺确认拒绝、--dry-run 不发写、结构化 JSON 可解析）。
- 命令（Node v24.11.1）：CLI commands 4/4、CLI 全部 8/8；SDK 154/154；typecheck/lint/build/boundaries → 0。
- 未运行项：drafts/live/slide/answers/discuss 子命令组与真实平台写路径需先有授权登录会话；T24 渲染已通过 runtime.heavy 注入 CLI 装配（LocalHeavyRenderer）。
- 下一个当前任务：T31。

按任务编号与日期追加：实际改动文件、命令/环境/退出码、通过与未运行层级、source/fixture变化、具体blocker和影响、下一个当前任务编号。done需要真实证据；partial/blocked不能写完成。延期不是blocked。

## 用户授权的真实验证

初始无。未授权不触发平台操作；没有实际执行不得写入虚构结果。

### 2026-09-23 · T31 SDK与CLI集成验收、安装说明与本机证据（原记录；下方复核修正为 partial）

- 实际改动：docs/{INSTALL.md,USAGE.md,FEATURE-STATUS.md,PROGRESS.md}、.github/workflows/ci.yml、package.json（test:e2e 指向独立配置）、apps/cli/{vitest.e2e.config.ts,vitest.config.ts（排除 e2e）}、tests/e2e.test.ts。
- 验收命令（Node v24.11.1）：pnpm lint → 0；pnpm typecheck → 0；pnpm test → 0（SDK 154/154 + CLI 8/8）；pnpm build → 0；pnpm test:e2e → 0（构建产物 --help/--version/init/doctor/run --dry-run，零平台域名输出）；node scripts/check-boundaries.mjs → 0；node scripts/check-source-lock.mjs → 0。CI 仅两包边界+单测+构建+CLI E2E，无 Web/云测试。
- A311：workspace 仍仅 @learning/sdk+@learning/cli（boundaries 断言），无 Web/executor/cloudflare 代码或云脚本；SDK/CLI 共用唯一 provider 实现（CLI 只调 SDK）。A312：离线 E2E 全通过；真机写入/字体全部如实记 not-run/阻塞（FEATURE-STATUS.md）。
- 证据缺口汇总：E01 ykt 考试 fixtures、E02 xtx 分页终止、E03 ykt lesson 分页/字体字段、E04 三平台身份字段、E05 xtx 交卷取证、E06 zhs 回读时延、E07 字体黄金样本、E08 本机真实平台/字体实测——均未消除，只阻塞对应能力，不影响本期工程验收。
- 本期 28 项全部完成（T00–T26、T31；T27–T30 deferred 不计分母）。T31 后停止，不自动进入 Web。

### 2026-09-23 · T31 修正：CLI 对 SDK dist 的构建顺序依赖（CI 发现）

- 问题：apps/cli 的 typecheck/build/test 通过正式 exports（@learning/sdk/node、@learning/sdk/render-node → packages/sdk/dist/*.d.ts）解析类型，全新 checkout 下 CI 先跑 `pnpm typecheck` 后跑 `pnpm build`，SDK dist 不存在 → TS2307。
- 修复：apps/cli 脚本自足化——typecheck/build 前置 `pnpm --filter @learning/sdk build`，test 前置自身 `pnpm run build`（其内先建 SDK 再建 CLI dist，进程测试需要）。未用 tsconfig paths 伪造包可用性（SPEC §3 禁止），保持正式 exports 消费。
- 验证（Node v24.11.1，先删除两包 dist 复现 CI）：`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` → 全部 exit 0（SDK 154/154 + CLI 8/8 + e2e 4/4）；`pnpm install --frozen-lockfile` → exit 0。root 脚本名与 T31 规定的 test:e2e 内容未变。

### 2026-09-23 · 用户要求修复本地 CLI 并完整复核（T25/T26/T31 partial）

- 引用任务的本机演示暴露 `init --home <dir>` 实际写入 `~/.learning`：根与子命令重复定义 `--home`，Commander 解析到根选项，原 action 读取子选项为空；原测试同时设置 `LEARNING_HOME` 为同一路径，掩盖错误。新增不同目录的前置/后置 `--home` 与环境变量回退进程测试，修复为读取根选项。
- `init` 原来正常退出仍留下锁，且 lock 写入非原子。现在使用排他创建、唯一 token，正常退出释放；增加 `profile unlock`，只在 PID 不存在时删除遗留锁，活跃或无法判定的 PID 拒绝。master.key 0600、重复 init 不改密钥与锁冲突均由实际 CLI 进程测试覆盖。
- 原 `run/download`、`exam submit --yes --final` 和 `jobs reconcile` 返回固定“成功”输出，`jobs list` 返回固定空数组。现在 run/download 缺 course 为参数错误 exit 2；实际任务链未接入时 exit 3 且不写 stdout；exam submit 无 SDK 执行链时 exit 3；jobs list 从 SQLite 读取并校验真实 job 记录，未知 jobId 的 reconcile 为 exit 2，已有任务的核对链未接入时 exit 3。参数错误统一 exit 2。没有把这些拒绝路径记为功能实现。
- APPS A02 的 28 个计划命令路径逐一检查构建产物的 help usage：仅 `init`、`doctor`、`profile unlock`、`jobs list/reconcile`、`run`、`download`、`exam submit` 8 个注册；其余 20 个未注册。`@learning/sdk` 的 `actions.*`、`jobs.*` facade 仍返回 UNSUPPORTED，CLI ArtifactStore 仍是占位错误；A251/A252/A261/A262/A312 不能凭当前测试判为完成。真实平台操作未执行（无授权）；字体黄金样本 E07 仍缺失。
- 改动：apps/cli/src/{index.ts,runtime.ts,commands/{init,profile,tasks,exams,run,download}.ts}、apps/cli/tests/{basic,commands,e2e}.test.ts、docs/{PROGRESS,FEATURE-STATUS,USAGE,INSTALL}.md。保留前一任务留下的源代码改动并合并修复；删除两份仅用于调查 Commander 参数的临时 probe 脚本。
- 测试先行：新增 CLI 进程测试后，`pnpm --filter @learning/cli test` 先因目录、锁与固定成功输出失败；修复后通过。最终 Node v24.11.1：`pnpm lint` → 0；`pnpm typecheck` → 0；`pnpm test` → 0（SDK 154/154、CLI 15/15）；`pnpm build` → 0；`pnpm test:e2e` → 0（4/4）；`node scripts/check-boundaries.mjs` → 0；`node scripts/check-source-lock.mjs` → 0；`git diff --check` → 0。未运行真机平台登录/学习/答题/交卷、付费模型、部署。
- 下一当前任务：继续 T25 的 profile/login/catalog 真正装配，再做 T26 完整命令与恢复，最后重新完成 T31 本机验收；T27–T30 仍延期。

### 2026-09-23 · SDK/CLI 续作检查点（T11、T14–T26、T31 仍按上表追踪）

- 隔离工作树 `codex/cli-complete`。补齐 profile CRUD、QR/导入登录、whoami、课程/大纲缓存、真实 doctor；SDK 会话 generation 跨进程递增。NodeArtifactStore 实现受控 `.part`、摘要与原子发布；JobRunner 记录、事件、输入、游标、待核对操作持久化。ActionStore 的 preview→sending→receipt 现在跨进程保留，响应丢失不重交。
- CLI 已通过严格离线进程 fixture 的执行链：试卷只读导出、作业 YAML 草稿与单题确认、精确反馈匹配、历史课件图片/PDF、MP4 与未加密 HLS 下载、雨课堂及学堂视频学习、学堂讨论草稿/发帖、学堂开卷。`jobs list/show/resume/cancel/reconcile` 有真实本机记录；雨课堂不确定心跳通过平台进度只读核对。上述 fixture 不等于真实账号验收。
- 本轮复核纠正先前误标 done 的问题：旧 `render-node` 曾将 PDF 请求返回 `font.decode` 假成功，现 PDF 真正读写本机 Artifact，缺参考字体/受控浏览器时明确失败；智慧树 hike `childList`/`dataType=3`、GET 课程树及 studyservice VIDEO_KEY、`/gateway/t/v1` 与加密表单均按固定源码修正了错误 fixture；share/hike 权威进度只读已接入，保存学习任务仍未接。
- 测试先行：新增跨进程/异常测试先观察 UNSUPPORTED、错误协议、错误锁状态等预期失败，再实现。Node v24.11.1，隔离工作树实际命令：`node packages/sdk/node_modules/vitest/vitest.mjs run`（在 SDK 目录）→ 182/182 exit 0；`node apps/cli/node_modules/vitest/vitest.mjs run`（在 CLI 目录）→ 35/35 exit 0；CLI `vitest --config vitest.e2e.config.ts` → 4/4 exit 0；`node node_modules/typescript/bin/tsc -p packages/sdk/tsconfig.build.json` 与 CLI 对应命令 → exit 0；`node node_modules/eslint/bin/eslint.js .`、`node scripts/check-boundaries.mjs`、`git diff --check` → exit 0。上述 `node` 使用绝对路径 `/Users/uu/.nvm/versions/node/v24.11.1/bin/node`。
- 未通过/未运行：隔离工作树复制了原仓库的已安装 `node_modules`，`pnpm lint` 先触发安装并以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 退出 1；原仓库合并后须用正式 pnpm 门禁重跑。真实平台登录/学习/答题/发帖/开卷/交卷未运行（本期无单独授权）；E07 参考字体的 3 份独立样本/200 人工核实字形缺失；E05 最终交卷独立验证仍缺，不能标记可用。
- 下一当前工作：继续 T21/T22 与 T26 剩余能力，修复 Range 恢复/字幕及任务恢复边缘；然后完成 T31 打包消费者和全命令矩阵。T27–T30 保持延期。

### 2026-09-23 · 第二阶段检查点（继续 T17–T26；T31 尚未完成）

- SDK/CLI 改动：MP4 分段检查点及 `206`+偏移+ETag/Last-Modified 续传，`200`、`416`、验证器变化重下；`jobs resume` 双进程文件内容验收。字幕失败保留主视频。学堂考试新增 `exam draft/save`，最终 `submit` 形成带 E05 blocker 的预览，任何情况下无证据均不发送 `submit_paper`。
- 智慧树：默认 QR 改为纯 API 微信 OAuth 链，`--variant native` 保留旧原生流程；whoami 在线 UUID 读回成功后才提升 `identityVerified`。share/hike 任务按实际经过时间分别使用 VIDEO_KEY 加密 save / 固定顺序 MD5 签名，弹题无答案 `needs-input`、权威回读后才达目标。真实身份字段与风控仍未验收。
- 雨课堂直播：明确确认后 checkin，WS hello 使用 lessonToken；题目、gap 持久入 job events；同 jobId 的 `jobs resume --yes` 重签到并标注离线事件缺口，手工输入当前题答案仍逐题确认，过期/断线旧题拒绝。CLI runtime.wake 已能打断前台等待，Ctrl+C 关闭连接。旧的 WS 纯 mailbox 结论不能替代真机验收。
- 安全修复：新建 LEARNING_HOME 0700，SQLite/master.key 0600；操作预览的答题/讨论正文改为 AES-GCM 密文，旧明文 sending 记录在读取时原地迁移且保持 uncertain、不重交。新增 `operations reconcile <operation-id>`，无法权威核对时返回 uncertain/退出码 5。
- 本阶段离线实际命令（Node v24.11.1、隔离工作树）：SDK `vitest run` → 208/208 exit 0；CLI `vitest run` → 45/45 exit 0；CLI 独立 E2E → 4/4 exit 0；SDK/CLI `tsc -p tsconfig.json` → exit 0；ESLint、boundaries、source-lock、`git diff --check` → exit 0。因隔离工作树的 `node_modules` 为复用拷贝，pnpm 在此处会触发重建依赖目录；合并后须在主仓库重跑正式 pnpm 五门禁。
- 未完成：T24 的 E07 三份独立参考字体和 200 个人工核实字形（用户确认暂无），字体 Canvas/旧课件受控浏览器不能报通过；E05 最终交卷独立真机验证缺失；平台真实登录/学习/写入/直播未授权，均未运行。T31 的干净消费者打包、全命令正常/异常矩阵仍未完成。下一步先做正式合并后门禁与消费者安装，再继续剩余工程与证据缺口。

### 2026-09-23 · 第三阶段检查点（T19 图文、T31 包消费者）

- T19 新增雨课堂图文 `leaf_type=3` 权威进度：`leaf_info.finish` 直接决定完成；未完成时从叶子取 `sku_id`、从班级上下文取 `uv_id`，将 `user_article_finish` 的 GET 按写入发送且带全身份头；ACK 后重新读取 `finish`，未确认不记成功。响应丢失保留 pending operation，`actions.reconcile` 只读核对，不重复写。CLI `run <course>` 现在纳入雨课堂 document 资源；已完成图文不重报，缺 sku 阻止准备。
- T31 将 28 个 A02 命令路径注册检查与 SDK/CLI 双 tgz 解包消费者测试固化到 `test:e2e`。消费者用已冻结的工作区依赖链接，执行正式 bin、包导出、扫码/课程/大纲、试卷导出和双进程 Range 恢复。CLI `package.json` 的 `files` 只发布 dist；`pnpm pack` 内容核对通过。尝试离线 `pnpm add` 因本机缺 `pdf-lib` tarball 而失败（`ERR_PNPM_NO_OFFLINE_TARBALL`），因此不声称全新独立依赖安装已通过。
- 测试先行：图文正常/异常测试先以 `leaf_info lacks the identifiers required for progress` 失败（exit 1），实现后 `ykt-study.test.ts` 9/9 exit 0。Node v24.11.1 隔离工作树实际命令：SDK `vitest run` 211/211、CLI `vitest run` 45/45、CLI E2E 6/6、SDK/CLI `tsc -p tsconfig.json --noEmit`、ESLint、boundaries、source-lock、`git diff --check` 均 exit 0。正式 pnpm 五门禁需合并到主仓库后重跑。
- 未运行：真实平台登录、图文写入、视频、答题、交卷、直播（没有单独授权）；E07 参考字体样本用户确认暂无，E05 交卷独立证据缺失。下一当前任务：继续 T16 学堂作业及 T15 内嵌题工程，再补 T31 剩余矩阵；Web 延期。

### 2026-09-23 · T16 学堂作业执行链

- 参考固定源码 `.reference/xuetang-cli/src/download/api.py::fetch_exercise` 与 `src/homework/{api,answers}.py`：先以 leaf_info 的 `leaf_type=6` / `leaf_type_id` 解析作业，再以 `exercise_id/sku_id` 双路径段读题；独立 `homework.apply` 预览对比整卷和单题 fingerprint、排除已提交 `my_count>0`，提交仅该题。请求 ID 用安全整数、CSRF cookie 头必填，`FillBlank` 对应 `answer:""` + `answers` map；主观题是安全转义 HTML、`time:"0"` 与空附件对象。已确认 `MultipleChoice`/`FillBlank`/`Essay` 类型别名。既有讨论链保持不变。
- 测试先行：新增 `xuetang-homework-client.test.ts` 先因 `resolve` 返回空失败（2 项、exit 1）；实现后 SDK 读/写与已提交拒绝 fixture 2/2，通过。CLI `catalog.test.ts` 新增双进程草稿/写入 fixture，初次因 SDK dist 未重建而失败；重建 SDK 构建产物后单测 1/1 通过。
- Node v24.11.1 隔离工作树实际命令：SDK `vitest run` → 213/213 exit 0；CLI `vitest run` → 46/46 exit 0；SDK/CLI `tsc -p tsconfig.json --noEmit`、SDK/CLI build、ESLint、`git diff --check` → exit 0。上一检查点合并到主仓库后正式 `pnpm lint/typecheck/test/build/test:e2e` 五门禁均 exit 0（当时 SDK 211/CLI 45/E2E 6）；本批改动尚待合并后重跑。
- 未运行：真实学堂账号作业/发帖（无单独授权），不声称业务验收。下一当前任务：T15 雨课堂内嵌题正确协议与继续链，然后 T31 其余可离线矩阵。

### 2026-09-23 · T15/T19 雨课堂内嵌题执行与继续

- 修正旧 `parseEmbeddedList`/`submitEmbeddedAnswer` 的错误作业信封与端点：视频题单取 `leaf_video/problem/{sku}/{leaf}/{exercise}/?classroom_id=...`，`data` 必须为数组；明确作答走 `leaf_video/problem/reply/{problem}/`，数字 ID、心跳式 `x-csrftoken`/`x-requested-with` 身份头。错题只返回 `isRight:false`，绝不推断标准答案；已答对题不重复发送。SDK `assessments.resolve/get/draft` 返回 `embedded` 题，CLI `homework draft/apply` 支持对应视频资源。
- 学习任务先读题单确认全部 `user.is_right` 才可把视频服务端进度记作完成；未解题 `needs-input`，`jobs resume` 明确重新排队同一 study job 并重读题单，停机期间不补造心跳。用户手动选择答案且逐题确认；无答案不自动选择/穷举。多资源任务遇题也立即暂停。
- 测试先行：原 parser 用真实数组信封测试先返回 0 项失败（exit 1）；视频已完成但题未解的任务先错误地返回 succeeded（exit 1），修正后通过。Node v24.11.1 隔离工作树实际命令：SDK `vitest run` → 215/215 exit 0；CLI `vitest run` → 47/47 exit 0；CLI E2E → 6/6 exit 0；SDK/CLI typecheck/build、ESLint、boundaries、`git diff --check` → exit 0。上一 T16 合并后的主仓库正式 pnpm 五门禁 exit 0（当时 SDK 213/CLI 46/E2E 6）。
- 未运行：真实雨课堂视频/图文/内嵌题写入、人工黄金字体样本 E07（用户确认暂无）。本批尚待合并后的正式 pnpm 门禁。下一当前任务：T20 长任务统计、T23 HLS 分段恢复及 T31 剩余本机验收；真实平台证据仍按未授权处理。

### 2026-09-23 · T20/T23 延迟统计与 HLS 分段恢复

- T20：把学堂心跳后的 schedule 轮询从三次/约15秒改为 180 秒实际时钟预算；轮询期间不重发心跳，超时转 `needs-input`，服务端达到目标才确认。发送 ACK 后若 schedule 读回失败，保留 pending operation，`actions.reconcile` 只读确认后可恢复；先前清掉 pending 导致不可核对的问题已由失败测试复现。
- T23：本地 ArtifactStore 增加显式 `truncateUncommitted` 恢复选项，仅在分段下载中使用；验证已提交前缀 SHA256 后回退中断分段的尾部字节，普通 MP4 的严格长度验证不变。HLS 对 URL 列表/扩展名计算摘要，逐完整分段同步并持久化 checkpoint，重启后只从下一个未完成分段继续；播放列表变化或 checkpoint 无法验证时重下，不发布半成品。合成 CLI 两进程 fixture 在第二段中途失败，恢复时没有重新请求第一段，最终文件 `AAABBB`。
- 测试先行：学堂延迟 fixture 原逻辑在第四次轮询前停机；ACK 后读回失败原逻辑丢 pending；Node 部分文件原逻辑拒绝显式回退，三项先失败后通过。Node v24.11.1 隔离工作树实际命令：SDK `vitest run` → 218/218 exit 0；CLI `vitest run` → 48/48 exit 0；CLI E2E → 6/6 exit 0；SDK/CLI typecheck/build、ESLint、boundaries、`git diff --check` → exit 0。根目录误执行 `tsc -p tsconfig.json` 因根无该文件 exit 1，随后分别对 SDK/CLI 正确命令均 exit 0。上一 T15 合并后主仓库正式 pnpm 五门禁 exit 0（SDK 215/CLI 47/E2E 6）。
- 未运行：真实平台视频保存/下载、受限分段格式、4 GiB 持续流、E07 人工字体样本。下一当前任务：T24 可独立完成的本地字体/旧课件工程与 T31 验收矩阵；真实平台/最终交卷仍等待独立授权/证据。

### 2026-09-23 · T13/T26 可选模型建议装配

- SDK 的 `assessments.propose` 现在只向模型发送本次选中、完整解码的题干和选项，未解码/未选项返回 blocked；模型 JSON 结构及选项键继续严格校验。学堂 `discussions.propose` 从当前主题只生成可编辑草稿，空/无效模型输出拒绝，后续发帖仍需独立 `discuss post --yes`。
- Node `/node` 出口提供明确配置的 HTTPS Chat Completions 兼容适配器：base URL/name/key 来自本机环境；无 key 时手工流程照常。请求仅在显式 AI 命令时发生，禁止重定向，响应 1 MiB 上限、30 秒超时，错误不回显密钥或模型正文。请求信封依据 [OpenAI Docs 的 Chat Completions 端点](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/create)，第三方兼容性未对真实服务验证。
- 测试先行：未解码题原先返回 missing 且内容会进模型 payload、学堂讨论 propose 原先 UNSUPPORTED、Node 适配器模块原先不存在，测试分别先失败后修复。Node v24.11.1 隔离工作树实际命令：SDK `vitest run` → 222/222 exit 0；CLI `vitest run` → 49/49 exit 0；CLI E2E → 6/6 exit 0；SDK/CLI build/typecheck、ESLint、boundaries、`git diff --check` → exit 0。首次为声明跨包运行时类型触发 TS2742、修正后 profile.ts 的列表页类型再触发 TS7022；显式导出/标注类型后构建 exit 0。上一 T20/T23 合并后的主仓库正式 pnpm 五门禁 exit 0（SDK 218/CLI 48/E2E 6）。
- 未运行：真实付费模型请求、真实平台讨论或答题（无单独授权）。下一当前任务：T24 样本缺口之外可完成的本机工程，以及 T31 剩余验收矩阵。

### 2026-09-23 · T24/T31 离线边界与命令失败矩阵

- T24 字形匹配修复：向量维度不一致、NaN/非有限值、零向量不再因余弦计算缺陷被误报“精确”；次优字形分数接近最佳时保守返回 unresolved。合成单测先证实维度不一致被误报 exact，修复后 `render.test.ts` 5/5。此项只证明拒绝边界，**不代表** E07 三份独立参考样本/200 个人工核实字形已取得；用户答复“暂无”，Canvas 解码和受控旧课件页面仍未实现/验收。
- T31 构建产物 E2E 保留 28 条 A02 命令路径 help 注册检查，并新增 23 组实际错误输入。每组在零登记网络 fixture 下运行 CLI 进程，均以非零退出、空 stdout 且无平台请求结束。可运行的 QR/课程/大纲/导出/恢复、作业/讨论/学习/直播等正常路径仍由 SDK/CLI 合成 fixture 覆盖。为防止隔离工作树、pnpm store 与参考源码软链接被误暂存，`.gitignore` 加入对应路径。
- 先运行根目录 E2E 配置得到 “No test files found”（exit 1，配置 include 相对于 CLI 包）；切换到 `apps/cli` 正式测试目录后新增失败矩阵 1/1 exit 0。并行全套 SDK/CLI/E2E 时，28 次 CLI 启动的 help 测试因默认 5 秒超时而失败 1 项（行为断言未失败）；只增加两组多进程测试的时间预算，单独重跑 E2E 7/7 exit 0。离线独立消费者 `pnpm add --offline` 仍因本机缺 pdf-lib tarball 不能宣称通过；现有 packed tgz 消费者通过的是精确依赖链接。
- 下一当前任务：合并此检查点并完成本期最终本机门禁；E05 交卷独立证据、E07 字体参考样本和真实平台写入仍不能用 fixture 代替。
