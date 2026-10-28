# learning Implementation Plan — SDK + CLI 本期实施计划

版本 1.1，2026-09-23。此次只修改实施范围；未执行产品任务。先读当前 SPEC，不再使用最终版1.0或更早稿的 Web 任务。

> **For agentic workers:** 有 superpowers 时按 executing-plans 逐任务实施；没有插件也按本文相同步骤，不另装插件作为前提。一次只完成用户指定任务，不自动多模型并行。

**Goal:** 在 cqu-moe/learning 完成共享 TypeScript SDK 与独立本地 CLI；Web 延期。

**Architecture:** 一个 SDK 包 + 一个 CLI 包。CLI 直接调用 SDK 与 Node Runtime；本机 SQLite、加密会话、文件 ArtifactStore、前台 scheduler；本地重型功能通过同 SDK `/render-node`。已有环境中立接口保留，不先实现云端。

**Tech Stack:** TypeScript/ESM/pnpm/Zod；Node24、Commander、Vitest；parse5/yaml/pdf-lib；Playwright 仅用于本机渲染。

**Spec:** [SPEC](SPEC.md)、[SDK](SDK.md)、[contracts](contracts.d.ts)、[PLATFORMS](PLATFORMS.md)、[APPS](APPS.md)。

## 全局限制

当前只建 @learning/sdk、@learning/cli 两包，全部 private。workspace 显式列 packages/sdk 与 apps/cli，不创建 Web/executor 空目录，不写 runtime/cloudflare、Dockerfile、Wrangler、云测试或站点登录。未来 Cloudflare 原生目标只存在延期说明。

继续禁止 Access、D1、KV、Queues、Workflows、Browser Run、Tunnel、Redis、ORM、Turbo/Nx、动态插件与通用审批引擎；不装 React/Vite/Hono/Cloudflare依赖“提前准备”。本地PDF/字体/课件与SDK功能不因Web延期被删。

默认CI离线；真实平台/付费模型请求逐项授权。不能修改参考仓库、未授权push/deploy。不以any/空函数/skip/放宽schema伪造完成。

## 评审重点

跨profile同名Cookie/资源（T02/T04）；网络故障被当登出（T05）；HTTP200但协议失败（T06–T11）；不可逆动作响应丢失（T14/T17）；本机进程退出/恢复或取消后迟到渲染结果（T18/T24/T26/T31）。这些均在对应任务测试，不再用 Web/Container 测试作替代。

## 文件与任务依赖

本期顺序 **T00 → … → T26 → T31**，共28项。保留旧编号便于已有进度对照：T27–T30整体延期，不在当前tasks.json中；旧T31的云验收不再执行。T31依赖仅T26及其依赖闭包；当前任务没有任何延期依赖。完成T31后停止。

平台文件仅在SDK providers，CLI不得复制协议URL。测试helper是普通测试模块，不是新的生产包。

T00若仅受私有源码访问限制，可先完成T01–T05通用工程，保留对应证据缺口；不能为provider猜接口。单任务可拆本地提交，不扩大范围。已有代码/PROGRESS时逐项比对合并，不用这份初始模板覆盖真实完成记录。

| 阶段 | 任务 | 本期交付 |
|---|---|---|
| 基础 | T00–T05 | 固定源码、两包工作区、数据/状态、Node传输与认证 |
| 三平台只读 | T06–T11 | 登录、课程树、资源和权威进度 |
| 内容与写入 | T12–T17 | 草稿、匹配、预览、已定义写入口 |
| 任务与本地导出 | T18–T24 | 可恢复任务、实时、下载、本机PDF/字体/受控页面 |
| CLI | T25–T26 | 全部既定本机命令与恢复/核对 |
| 本期验收 | T31 | 本机构建、CLI进程E2E、安装说明、逐能力证据 |

## 测试片段怎么用

每任务代码是关键断言示例，不是已运行的完整测试文件。补齐指定fixture/import，测试必须调用真实待测代码，不能将 expected 常量变成生产实现。`ref/course/draft/job/input`是本地合成fixture；calls等由假传输实际记录。`flattenResources`遍历resources和children；`sessionStoreWasChanged`比较前后存储；`runCli/runPackedCli`调用真实应用的测试入口或构建后bin，后者必须从临时消费者路径启动。两个帮助函数由CLI测试文件/helpers实现，不返回预设文本。

fixture固定：id、platform、source{repo,ref,path,symbol}、synthetic、request/response交互、entry{service,method,input}、expected。T04先完成与SDK工厂无关的传输重放工具，T05再组装客户端；不能制造反向依赖。源外合成数据标synthetic，不冒充真实抓包。

以下路径从repo根目录算，命令是后续模型需要实际执行的，不是本次已运行记录。`test:e2e`仅本地CLI；当前没有`test:worker`或Web测试。

## T00 · 固定源码与证据目录

**依赖：** 无

**建立/修改：** `.gitignore`；`docs/source-lock.json`；`docs/protocol-evidence.md`

**测试文件：** `scripts/check-source-lock.mjs`

**输入接口/依据：** docs/SOURCES.md 的三个 commit

**输出：** 固定私有 checkout、差异/缺口清单、source-lock.json

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const lock = JSON.parse(readFileSync('docs/source-lock.json', 'utf8'));
assert.equal(lock.repositories.length, 3);
for (const repo of lock.repositories) assert.match(repo.ref, /^[0-9a-f]{40}$/);
```

- [ ] 将参考仓库放 .reference/{ykt-cli,xuetang-cli,zhs-cli} 并 gitignore；checkout --detach 到固定 commit，禁止运行旧 CLI。
- [ ] 逐条记录已读源码符号和测试位置；补读 ykt download/exam.py 网络后半段、学堂 run 的 schedule 回读、旧草稿格式；只读文件。
- [ ] 将协议字段确实缺失、需要授权抓包的地方列当前 SOURCES 的 E01–E08（E08只含本机；云端取证延期）；不把“不知道”改成空成功，也不阻止不依赖它的任务。
- [ ] 运行下面命令，记录实际结果；T00尚未建立pnpm工程，不调用根脚本。

```bash
node scripts/check-source-lock.mjs
```

**必须验收：**

- `A001`：缺少任一私有仓库时明确列出repo/ref及权限缺口；只暂停对应provider，不能下载公开fork替代。
- `A002`：source-lock.json 的ref均40位十六进制；实际 git rev-parse HEAD 必须相等；输出不得含token。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T01 · 两包工作区与本地构建入口

**依赖：** T00

**建立/修改：** `package.json`；`pnpm-workspace.yaml`；`packages/sdk/package.json`；`apps/cli/package.json`；`tsconfig.base.json`；`eslint.config.mjs`

**测试文件：** `scripts/check-boundaries.mjs`

**输入接口/依据：** SPEC §3/§4

**输出：** 两个 private package、精确 workspace 清单、Node 构建/测试脚本、lockfile、可移植出口边界

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
// 新项目夹具；已有延期目录不删除，改以workspace与依赖边界核验。
const manifests = ['packages/sdk/package.json', 'apps/cli/package.json']
  .map(p => JSON.parse(readFileSync(p, 'utf8')));
assert.deepEqual(manifests.map(p => p.name), ['@learning/sdk', '@learning/cli']);
assert.equal(existsSync('apps/web'), false);
assert.equal(existsSync('apps/executor'), false);
assert.equal(existsSync('packages/sdk/src/runtime/cloudflare'), false);
```

- [ ] 固定 Node24 实际补丁和 pnpm 版本；只为当前基础任务解析稳定兼容的 TypeScript/Zod/Vitest/ESLint，save-exact，生成 lockfile 和 docs/toolchain.md；其他依赖到所属任务再安装。
- [ ] pnpm-workspace.yaml 显式只列 packages/sdk 与 apps/cli。仅创建这两包真实可构建入口，SDK tsc 产 ESM/.d.ts，CLI 独立 Node 产物；不创建 apps/web、apps/executor、runtime/cloudflare 或云部署配置。
- [ ] 检查 public/root 的静态导入图不得带入 Node 专属实现/CLI/渲染；Node 出口隔离。只添加 lint/typecheck/test/build/cli；没有 test:worker/dev:web/deploy:web 或空通过占位命令；render-node 在 T24 落实后导出。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
node scripts/check-boundaries.mjs
```

**必须验收：**

- `A011`：pnpm install --frozen-lockfile 第二次成功；workspace恰好包含 @learning/sdk 和 @learning/cli。新项目不生成Web/executor空包；已有延期代码不加入当前workspace/构建且不擅自删除。
- `A012`：public/root 错误导入 Node 实现的负例被边界检查拒绝；依赖中无 React/Vite/Hono/Wrangler/Cloudflare 插件，无云部署/测试占位脚本。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T02 · DTO、稳定标识与测试内存存储

**依赖：** T01

**建立/修改：** `packages/sdk/src/types/refs.ts`；`packages/sdk/src/types/models.ts`；`packages/sdk/src/types/errors.ts`；`packages/sdk/src/public.ts`；`packages/sdk/tests/helpers/memory.ts`

**测试文件：** `packages/sdk/tests/types.test.ts`

**输入接口/依据：** docs/contracts.d.ts、SDK S02

**输出：** Zod DTO/schema与z.infer；keyOfCourse/keyOfResource；ErrorData；MemoryStateStore

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const x = keyOfResource({...ref, native:{...ref.native, smallLessonId:'1'}});
const y = keyOfResource({...ref, native:{...ref.native, smallLessonId:'2'}});
expect(x).not.toBe(y);
```

- [ ] 按领域拆schema，public只导出安全模型；不把Runtime/Session或Cookie schema输出到浏览器出口。
- [ ] key生成按scope+固定native tuple；Outline允许children和resources同时存在；所有时间字段保留Ms/Seconds。
- [ ] 实现内存StateStore用于之后测试，commit原子检查revision；测试Helpers是测试依赖，不进入生产。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/types.test.ts
```

**必须验收：**

- `A021`：同videoId不同小节必须产生不同resource key；不同userId/profileId绝不相同。
- `A022`：未知ID、NaN/Infinity、超过安全整数输入拒绝；zhs smallLessonId="0"明确例外；Page unknown不改complete。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T03 · 本地StateStore和加密会话记录

**依赖：** T02

**建立/修改：** `packages/sdk/src/runtime/node/state.ts`；`packages/sdk/src/session/store.ts`；`packages/sdk/src/session/crypto.ts`；`packages/sdk/src/runtime/node/index.ts`

**测试文件：** `packages/sdk/tests/store.test.ts`

**输入接口/依据：** StateStore、Scope、SessionView

**输出：** SQLite StateStore；readSession/writeSession/revokeSession私有模块

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await store.commit({expected:[{key:'a',revision:null}],changes:[{key:'a',value:1}]});
expect(await store.commit({expected:[{key:'a',revision:null}],changes:[{key:'a',value:2}]})).toBe(false);
expect((await store.get('a'))?.value).toBe(1);
```

- [ ] 用node:sqlite实现records与schema_meta，事务检查expected并批量commit，不写通用ORM；网络不能进入事务。
- [ ] AES-GCM保存session/私有正文，随机IV，AAD含scope/recordKind/version；generation tombstone防注销后复活。
- [ ] 内存store和SQLite跑同组contract；只在Node出口import node:sqlite，普通SDK入口无文件IO。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/store.test.ts
```

**必须验收：**

- `A031`：一组revision冲突则全部不改；修改两个key是原子的；delete符合约定。
- `A032`：错误user/profile/AAD解密失败；旧generation响应不能覆盖注销记录；存储失败不触发上游重发。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T04 · HTTP、Cookie、重定向与协议fixture工具

**依赖：** T03

**建立/修改：** `packages/sdk/src/http/client.ts`；`packages/sdk/src/http/cookies.ts`；`packages/sdk/src/http/retry.ts`；`packages/sdk/src/http/errors.ts`；`packages/sdk/tests/helpers/replay.ts`

**测试文件：** `packages/sdk/tests/http.test.ts`

**输入接口/依据：** Transport、StateStore、SDK S03

**输出：** createSessionHttp；replay(name, action)测试工具；FakeClock/FakeTransport

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await expect(http.request(writeRequest)).rejects.toMatchObject({code:'UNCERTAIN'});
expect(transport.requests).toHaveLength(1);
expect(transport.requests[0].redirect).toBe('manual');
```

- [ ] tough-cookie做完整jar；请求manual redirect；每跳URL主机和Cookie校验，跨源去Authorization/CSRF。
- [ ] 仅read允许3次总尝试；Retry-After支持秒与日期；所有等待可Abort；200后交provider验证envelope。
- [ ] replay读取fixtures目录，逐条校验method/host/path/query/headers/body及顺序；未登记额外请求立即失败，结束检查必需请求全消费。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/http.test.ts
```

**必须验收：**

- `A041`：同名不同domain/path/hostOnly；Expires逗号；多Set-Cookie；恶意域名后缀/私网跳转均覆盖。
- `A042`：写响应丢失只请求1次；read取消立即终止；HTTP200+错误body不得变空课程。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T05 · 统一登录生命周期、WS和SDK工厂

**依赖：** T04

**建立/修改：** `packages/sdk/src/auth/flow.ts`；`packages/sdk/src/runtime/node/transport.ts`；`packages/sdk/src/index.ts`；`packages/sdk/tests/helpers/ws.ts`

**测试文件：** `packages/sdk/tests/auth-flow.test.ts`

**输入接口/依据：** Transport、AuthFlow、Clock、Scope

**输出：** createLearningClient；Node fetch/ws 适配；运行时无关 auth 事件生命周期

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const flow = await client.auth.begin({method:'qr'});
await flow.cancel();
ws.pushLateSuccess();
expect(await sessionStoreWasChanged()).toBe(false);
```

- [ ] 普通内部switch选择provider；尚无实现的provider方法明确unimplemented，不能return空列表；factory不联网。
- [ ] 只实现 Node fetch/ws adapter：headers、文本/二进制、关闭、abort、有界消息；buffer 上限256帧、单帧1MiB。保留中立 Transport 接口，但不写 Workers Upgrade/Cloudflare 适配或空出口。
- [ ] 实现10分钟总预算、generation递增、取消/迟到结果清理；事件显示字段和交换secret分离；result reject宿主必须处理。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/auth-flow.test.ts
```

**必须验收：**

- `A051`：旧QR确认到达晚于新QR不得覆盖；cancel后无Cookie保存、socket与timer均释放。
- `A052`：probe网络错indeterminate，不清旧Cookie；factory/import没有网络请求。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T06 · 雨课堂登录、课程与两类大纲

**依赖：** T05

**建立/修改：** `packages/sdk/src/providers/ykt/auth.ts`；`packages/sdk/src/providers/ykt/catalog.ts`；`packages/sdk/src/providers/ykt/schemas.ts`；`packages/sdk/tests/fixtures/ykt/catalog.json`

**测试文件：** `packages/sdk/tests/ykt-catalog.test.ts`

**输入接口/依据：** Y02/Y03/Y04/Y08；AuthFlow、CourseRef

**输出：** ykt auth/catalog provider方法

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const out = await replay('ykt/nested-outline', c => c.catalog.outline(course));
expect(out.value.roots.flatMap(flattenResources).map(x=>x.ref.key)).toHaveLength(4);
```

- [ ] 迁移HTTP取码→轮询→form交换→userinfo校验；不带旧Rich/Playwright/UI依赖。
- [ ] course列表与classroom上下文拆清ID；hasKg须xtbz及university-id，不能从Cookie猜uv_id。
- [ ] 分别解析standard异构leaf_list与KG children，保留root资源、小节路径和重复media出现位置。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/ykt-catalog.test.ts
```

**必须验收：**

- `A061`：fixture请求头缺一即测试失败；cid语义正确；kg false与请求失败分开。
- `A062`：根考试+深层资源同时保留，空folder不成伪资源；缺leafId不能0兜底。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T07 · 雨课堂资源、课件及考试只读

**依赖：** T06

**建立/修改：** `packages/sdk/src/providers/ykt/resources.ts`；`packages/sdk/src/providers/ykt/assessments.ts`；`packages/sdk/src/providers/ykt/exam-read.ts`；`packages/sdk/tests/fixtures/ykt/resources.json`

**测试文件：** `packages/sdk/tests/ykt-resources.test.ts`

**输入接口/依据：** Y04/Y06/Y07/Y11、E01/E03；Resource/SlideDeck/Assessment

**输出：** media/transcript/lessons/slides/assessment读能力

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await replay('ykt/history-slides', c => c.resources.slides(lesson));
expect(httpCalls.some(x=>x.url.includes('/lesson/checkin'))).toBe(false);
expect(rendererCalls).toHaveLength(0);
```

- [ ] 视频源、三形态字幕、历史timeline/ppt走HTTP，不因旧CLI包装就开浏览器。
- [ ] 补读E01固定源码后实现ykt独立考试SSO→读试卷/结果整段串行，按problemId join；无证据不复制学堂wire。
- [ ] 实时课件尚未join不自动checkin；分页超过旧offset能力未知时unknown；字体marker输出decodeState。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/ykt-resources.test.ts
```

**必须验收：**

- `A071`：两份结果顺序不同也对齐；字幕失败不等于absent。
- `A072`：history slides不启动浏览器，不调用签到；index顺序稳定；缺font不能伪明文。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T08 · 学堂WS登录、课程与大纲

**依赖：** T05

**建立/修改：** `packages/sdk/src/providers/xuetang/auth.ts`；`packages/sdk/src/providers/xuetang/catalog.ts`；`packages/sdk/src/providers/xuetang/schemas.ts`

**测试文件：** `packages/sdk/tests/xuetang-catalog.test.ts`

**输入接口/依据：** X02/X03/X04/X11、E02/E04

**输出：** xuetang auth/catalog；probe三态

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await replay('xuetang/qr-is-new', c => c.auth.begin({method:'qr'}).then(f=>f.result));
expect(exchangeBody).toEqual({s_s:'fixture-token'});
```

- [ ] 实现seed CSRF、六字段requestlogin、ticket显示、loginsuccess新旧token分支、/api/v1/u/login/wx/交换。
- [ ] QR过期换连接和generation，不重复兑已消费token；没有follow URL则受控图片fallback。
- [ ] courseSign/skuId从正确上下文取得，分页按证据终止；树nodeId与leaf.chapter_id保留差异。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/xuetang-catalog.test.ts
```

**必须验收：**

- `A081`：只返回第一页不可标全量；缺skuId不能伪造0；根resource不丢。
- `A082`：旧消息与取消竞态无错误绑定，probe超时不触发清Cookie。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T09 · 学堂资源、作业和考试结果读取

**依赖：** T08

**建立/修改：** `packages/sdk/src/providers/xuetang/resources.ts`；`packages/sdk/src/providers/xuetang/assessments.ts`；`packages/sdk/src/providers/xuetang/exam-read.ts`

**测试文件：** `packages/sdk/tests/xuetang-resources.test.ts`

**输入接口/依据：** X04/X06/X09；MediaInfo/Assessment

**输出：** 学堂只读资源能力与完整exam-read临界区

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const paper = await replay('xuetang/exam-read-shuffled', c=>c.assessments.get(ref));
expect(paper.questions[0].myAnswer).toEqual(expectedFirstAnswer);
expect(calls.some(x=>/start_paper|submit_paper/.test(x.url))).toBe(false);
```

- [ ] 实现两段exerciseId/skuId路径、playurl质量/duration、讲稿毫秒；不套yktURL。
- [ ] exam cover/gen_token双层data，批准host后SSO，cloud头读取；同profile考试临界区覆盖全链而非只login。
- [ ] 允许为只读而建立session，但不能start_paper；paper/results按id对齐，Type字符串分类。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/xuetang-resources.test.ts
```

**必须验收：**

- `A091`：恶意exam_host在泄漏crypt前拒绝；两试卷并发不串Cookie。
- `A092`：开始考试和交卷请求次数为0，题型未知保持unknown。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T10 · 智慧树编码与登录

**依赖：** T05

**建立/修改：** `packages/sdk/src/providers/zhs/crypto.ts`；`packages/sdk/src/providers/zhs/auth.ts`；`packages/sdk/src/providers/zhs/http.ts`

**测试文件：** `packages/sdk/tests/zhs-auth-crypto.test.ts`

**输入接口/依据：** Z02/Z03/Z07；原有纯函数向量

**输出：** AES/date/MD5 legacy helpers；zhs QR/probe/import

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
expect(await decryptHome('LuNpV83QUU4T5C+UCYd2trCagnzKhl9z2BfOZUhqMqw=='))
 .toBe('{"schoolId":116}');
```

- [ ] 按source区分HOME/VIDEO AES、外层form与GET query、date精度；WebCrypto仅一次padding。
- [ ] 微信QR页面/长轮询只做有限文本解析，不eval；固定重定向链，CASLOGC只作本地字段不代替在线probe。
- [ ] 次级原生QR/密码保留独立 capability；SMS/captcha返回interaction，不自动换方式。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/zhs-auth-crypto.test.ts
```

**必须验收：**

- `A101`：中文、空串、16-byte边界与Python合成向量相同；ev的Unicode语义按source测试。
- `A102`：408/404/405/403分态；错误账号/假本地uuid不可视为valid。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T11 · 智慧树两类课程树和权威进度

**依赖：** T10

**建立/修改：** `packages/sdk/src/providers/zhs/share.ts`；`packages/sdk/src/providers/zhs/hike.ts`；`packages/sdk/src/providers/zhs/schemas.ts`

**测试文件：** `packages/sdk/tests/zhs-catalog.test.ts`

**输入接口/依据：** Z04/Z06；CourseLocator/ResourceLocator

**输出：** share/hike catalog与进度；不编造未有的下载/作业

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const rows=await replay('zhs/share-six-courses', c=>collectPages(c.catalog.courses));
expect(rows).toHaveLength(6);
expect(shareListPages).toEqual([1,2]);
```

- [ ] share分页pageSize5，courseId/ccCourseId/recruitId/racId分字段，smallLesson单视频哨兵0。
- [ ] hike树递归，startInngcourseList保留原拼写；dataType null是unknown，不自动调用viewFile。
- [ ] 同媒体多处出现不复用唯一videoId map；进度lv/lesson按正确ID映射。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/zhs-catalog.test.ts
```

**必须验收：**

- `A111`：大于5门课程末页不漏；同videoId两处保留。
- `A112`：读取catalog不发save/view写接口；字段不同的fixture捕获错用ID。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T12 · 富文本、Markdown与格式导出

**依赖：** T07, T09, T11

**建立/修改：** `packages/sdk/src/content/html.ts`；`packages/sdk/src/content/markdown.ts`；`packages/sdk/src/content/answers.ts`

**测试文件：** `packages/sdk/tests/content.test.ts`

**输入接口/依据：** RichText/Question；Y05/Y11与X09渲染源码

**输出：** normalizeContent、renderAssessmentMarkdown、Answer类型规范化

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const text=normalizeContent('<p>x<sub>1</sub><sup>2</sup></p><script>bad()</script>');
expect(text.markdown).toContain('x');
expect(text.markdown).not.toContain('<script>');
```

- [ ] parse5解析并转换清理后的Markdown，保留数学/选项/图片引用与换行，原始HTML不交前端执行。
- [ ] 为正常/部分解码文本保留decodeState，不用正则剥光所有标签后当作准确题面。
- [ ] JSON/Markdown/YAML输出一致的题目次序、答案来源，官方反馈与myAnswer不同字段。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/content.test.ts
```

**必须验收：**

- `A121`：script/onerror/javascript链接不执行；sub/sup不产生非法双下标，也不吞边界空格。
- `A122`：负号、1.0/10、指数、单位差异不得在匹配文本被抹除。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T13 · 草稿导入、反馈匹配与可选模型建议

**依赖：** T12

**建立/修改：** `packages/sdk/src/services/drafts.ts`；`packages/sdk/src/content/match.ts`；`packages/sdk/src/services/model.ts`；`packages/sdk/src/services/discussions.ts`

**测试文件：** `packages/sdk/tests/drafts.test.ts`

**输入接口/依据：** AnswerDraft/FeedbackSet/DiscussionDraft、ModelClient；旧YAML/回填源文件

**输出：** assessments draft/import/match/propose；discussion草稿

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const matches=await client.assessments.match(draft,[source]);
expect(matches[0]).toMatchObject({state:'exact',answer:{kind:'choice',keys:['C']}});
```

- [ ] 导入learning/ykt/xtx草稿与反馈，4MiB上限、禁自定义YAML tag、aliases有界。
- [ ] 精确匹配题型/语义/选项内容一一映射；跨exam/homework禁止；模糊仅suggested，歧义不覆盖原值。
- [ ] ModelClient只发选定内容，返回unknown后schema校验；无key不影响手工流程；模型不能直接调用提交。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/drafts.test.ts
```

**必须验收：**

- `A131`：同problemId不同课堂不能直接回填；选项换顺序正确映射，重复选项歧义拒绝。
- `A132`：无效JSON/不存在选项/未解码题干均不形成可执行答案，无Cookie传模型。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T14 · 操作预览、幂等与不确定写入

**依赖：** T03, T13

**建立/修改：** `packages/sdk/src/services/actions.ts`；`packages/sdk/src/services/operations.ts`；`packages/sdk/src/services/preview.ts`

**测试文件：** `packages/sdk/tests/actions.test.ts`

**输入接口/依据：** ActionInput/Preview/Receipt；SDK S05

**输出：** actions prepare/execute/reconcile；sending记录与单profile串行化

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const p=await client.actions.prepare(input);
await client.actions.execute(p.id); await client.actions.execute(p.id);
expect(upstreamWrites).toHaveLength(1);
```

- [ ] 保存精确ActionInput、fingerprint、generation，预览10分钟有效；普通SSO可用于核对但无学习/提交副作用。
- [ ] execute只用previewId原子绑定一次executionId；短写返回receipt，长批次留到job handler；没有PolicyPort/ApprovalRef。
- [ ] 发送前commit sending，结果与checkpoint同commit；超时uncertain，reconcile不能用模糊已提交状态宣称本次正确。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/actions.test.ts
```

**必须验收：**

- `A141`：同preview重复点仅一次上游请求；过期/改题/重登录均拒绝。
- `A142`：sending后崩溃、ack后存储失败不会重放；取消保留已发生结果。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T15 · 雨课堂作业与内嵌题写入

**依赖：** T14

**建立/修改：** `packages/sdk/src/providers/ykt/homework-write.ts`；`packages/sdk/src/providers/ykt/embedded.ts`

**测试文件：** `packages/sdk/tests/ykt-write.test.ts`

**输入接口/依据：** Y08/Y09，Answer与操作记录

**输出：** 雨课堂homework.apply编码、内嵌题读取/显式作答

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const result=await submitEmbedded(fixtureWrongAnswer);
expect(result.submitted).toBe(true);
expect(result.correctAnswer).toBeNull();
```

- [ ] 作业body严格classroom_id/problem_id/answer；内嵌题list envelope及专用headers分开。
- [ ] unknown/unset/无效choice预发送拒绝；错误答案success=true不等于答对，不编造反馈answer。
- [ ] 按用户固定questionIds顺序，每次写有独立记录；不把业务答错交给HTTP retry。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/ykt-write.test.ts
```

**必须验收：**

- `A151`：请求必要headers/body类型精确断言；误混学堂答案对象必须失败。
- `A152`：没有标准答案不选第一项、不穷举，发送失败只一次。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T16 · 学堂作业与讨论发布

**依赖：** T14

**建立/修改：** `packages/sdk/src/providers/xuetang/homework-write.ts`；`packages/sdk/src/providers/xuetang/discussions.ts`

**测试文件：** `packages/sdk/tests/xuetang-write.test.ts`

**输入接口/依据：** X09/X10；Answer、DiscussionDraft

**输出：** 学堂answer/answers映射、读取讨论与发帖

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await replay('xuetang/fillblank-write', c=>executeFixturePreview(c));
expect(body.answer).toBe('');
expect(body.answers).toEqual({'1':'fixture answer'});
```

- [ ] 按Type字符串映射单多选/判断/填空/主观两种answer字段，不能强制全是数组。
- [ ] 论坛thread是顶层对象，分页comments按源shape；post的query/body分清。
- [ ] 固定目标与文本预览后发帖，超时只uncertain，不自动生成第二条草稿再发。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/xuetang-write.test.ts
```

**必须验收：**

- `A161`：主观answer对象及填空map分别精确fixture；unset零写入。
- `A162`：HTTP200 success=false失败；未知schema不能空thread成功。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T17 · 学堂考试的三个独立动作

**依赖：** T14, T09

**建立/修改：** `packages/sdk/src/providers/xuetang/exam-write.ts`；`packages/sdk/src/providers/xuetang/exam-answers.ts`

**测试文件：** `packages/sdk/tests/xuetang-exam-write.test.ts`

**输入接口/依据：** X06/X07/X08，E05；exam.start/save/finalize

**输出：** 考试状态核对、题型编码、最终交卷独立开关

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
expect(() => encodeExamAnswer({kind:'short-answer',text:'x'}))
 .toThrow(expect.objectContaining({code:'UNSUPPORTED'}));
expect(upstreamWrites).toHaveLength(0);
```

- [ ] 临界区覆盖gen_token/login/操作/回读，不能只锁establish。
- [ ] 分别实现开卷、缓存、交卷，不把save成功等于final；记录未验证能力，不能依据旧SUBMIT_LIVE直接开启。
- [ ] 未取证的填空/主观考试写格式拒绝；最终交卷先fixture后用户单独授权受控验证，默认不在CI执行。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/xuetang-exam-write.test.ts
```

**必须验收：**

- `A171`：未开始时save不能偷偷start；timed unknown提示计时；已终结不重复操作。
- `A172`：缓存与最终交卷独立operationId；两试卷不串Cookie；超时不重交。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T18 · 固定任务模型、暂停恢复与事件

**依赖：** T14

**建立/修改：** `packages/sdk/src/jobs/types.ts`；`packages/sdk/src/jobs/runner.ts`；`packages/sdk/src/jobs/events.ts`；`packages/sdk/src/services/jobs.ts`

**测试文件：** `packages/sdk/tests/jobs.test.ts`

**输入接口/依据：** Job/Options/StateStore；SDK S06

**输出：** jobs create/get/list/advance/pause/resume/cancel，固定handler接口

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await client.jobs.cancel(job.id);
await client.jobs.advance(job.id);
expect(newUpstreamWrites).toHaveLength(0);
expect((await client.jobs.get(job.id)).status).toBe('canceled');
```

- [ ] JobRecord按SDK S06保存inputRef/cursor/generation/pendingOperationId；普通switch处理4种kind，不做DAG/插件。
- [ ] 20秒工作片与nextRunAt、取消、超时/重启恢复；advance同job重入返回CONFLICT。
- [ ] 事件sequence持久单调，上限256查询；高频progress可合并，终态可查；items超过200分页。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/jobs.test.ts
```

**必须验收：**

- `A181`：本地重复 wake/advance、旧 generation、sending 残留都不能再次提交；unknown 版本暂停。
- `A182`：CLI 反复读取状态或重复执行同一 preview 不新建重复 job；cancel不回滚旧receipt；一项失败summary准确。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T19 · 雨课堂学习任务

**依赖：** T18, T15

**建立/修改：** `packages/sdk/src/providers/ykt/study.ts`；`packages/sdk/src/providers/ykt/progress.ts`

**测试文件：** `packages/sdk/tests/ykt-study.test.ts`

**输入接口/依据：** Y08/Y12；固定任务handler、Progress

**输出：** standard/KG视频、图文动作与内嵌题暂停/继续

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await stepWithClock(job, fakeClock);
expect(sentRows.every(r=>Number(r.ts)<=fakeClock.nowMs())).toBe(true);
expect(sentRows.every(r=>r.cp<=r.d)).toBe(true);
```

- [ ] 原协议heart_data/lob/headers/cid分别编码；按实际运行时间逐片生成，时间与random可测试。
- [ ] 图文GET是write，已完成跳过，结束后读回；degree/目标与服务端完成分开。
- [ ] 内嵌题pause默认，reviewed/model只在任务明确授权范围；断机不补造观看段。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/ykt-study.test.ts
```

**必须验收：**

- `A191`：采样无未来ts，cp不超过duration，sq/pg正确；服务器未确认不succeeded。
- `A192`：中途停机后从读回进度恢复；duration未知拒绝；风控暂停。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T20 · 学堂学习任务

**依赖：** T18, T08, T09

**建立/修改：** `packages/sdk/src/providers/xuetang/study.ts`；`packages/sdk/src/providers/xuetang/progress.ts`

**测试文件：** `packages/sdk/tests/xuetang-study.test.ts`

**输入接口/依据：** X05及T00补读的schedule函数

**输出：** 学堂独有lifecycle/批次/回读的task handler

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
expect(heartbeatBody).toHaveProperty('heart_data');
expect(heartbeatBody.heart_data.some(r=>r.et==='ratechange')).toBe(true);
expect(heartbeatBody.heart_data.every(r=>r.lob==='xt')).toBe(true);
```

- [ ] 沿源码实现heart_data envelope、lob=xt、ratechange与速度范围；不得套ykt payload。
- [ ] leaf duration=0时playurl补全，仍未知不构造虚假进度；从部分已观看点继续。
- [ ] 统计回读用本库实际schedule链，180秒预算，pending不等于完成。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/xuetang-study.test.ts
```

**必须验收：**

- `A201`：bare object/lob错误在fixture断言失败；无ratechange非1x应测试失败。
- `A202`：延迟回读先waiting，最终确认才完成；pause/重启不补造停机时间。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T21 · 智慧树share/hike学习任务

**依赖：** T18, T11

**建立/修改：** `packages/sdk/src/providers/zhs/study-share.ts`；`packages/sdk/src/providers/zhs/study-hike.ts`

**测试文件：** `packages/sdk/tests/zhs-study.test.ts`

**输入接口/依据：** Z03/Z04/Z05/Z06/Z07，E06

**输出：** 两套task handler，服务器确认与停滞处理

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
expect(watchPointAfter10Seconds()).toBe('0,1,2,2,3,3,3');
await driveHikeWithServerTimes([30,30,30]);
expect(job.status).toBe('needs-input');
```

- [ ] share保留watchPoint重复项、ev编码和正确ID；每次save后必要回读，不只ACK计done。
- [ ] hike按server rt更新，连续3次无推进停止；达到目标不发零增量<=循环。
- [ ] 弹题未知答案暂停；code=-12/lock/punish等停止该profile而非跳过继续。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/zhs-study.test.ts
```

**必须验收：**

- `A211`：官方已知watchPoint向量一致；设置target0.91不能强置serverCompleted。
- `A212`：单视频内部deadline/abort有效；未知dataType不自动view。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T22 · 雨课堂实时会话与事件缺口

**依赖：** T18, T15

**建立/修改：** `packages/sdk/src/providers/ykt/live.ts`；`packages/sdk/src/jobs/live.ts`

**测试文件：** `packages/sdk/tests/live.test.ts`

**输入接口/依据：** Y06/Y10，Socket、JobEvent

**输出：** live.join/live.answer、mailbox、重连与gap

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await reconnectAfterDrop();
expect(events.some(e=>e.type==='gap')).toBe(true);
expect(writesForExpiredQuestion).toHaveLength(0);
```

- [ ] join必须实际确认checkin，lessonToken与set-auth JWT分清；事件与答题phase/deadline绑定。
- [ ] 同一live job持受控socket，消息放mailbox唤醒advance；任务状态/问题持久化，超时/取消关闭。
- [ ] 断连重连显示gap；无历史接口不说已补齐；不重放过期或uncertain答案。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/live.test.ts
```

**必须验收：**

- `A221`：普通slides读取不签到；已结束的问题不能答；重复事件不重复提交。
- `A222`：本机 WS 断线或进程恢复后新握手并报告 gap；Ctrl+C 后持久暂停且释放连接，退出后不继续后台监听。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T23 · 流式下载、持久产物与断点恢复

**依赖：** T18, T07, T09

**建立/修改：** `packages/sdk/src/services/exports.ts`；`packages/sdk/src/content/filenames.ts`；`packages/sdk/src/runtime/node/artifacts.ts`

**测试文件：** `packages/sdk/tests/download.test.ts`

**输入接口/依据：** ArtifactStore/BlobWriter/ExportInput

**输出：** Node .part 与本机 ArtifactStore、私有 manifest、导出 task handler；R2 adapter 延期

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
await downloadWithRangeResponse({status:200,offset:1024});
expect(writerWasRestarted).toBe(true);
expect(appendedToOldPartial).toBe(false);
```

- [ ] 解析原生URL与下载分开，短期URL不入公开DTO；流式增量SHA256，有界8MiB块和backpressure。
- [ ] 206+正确range+同validator才能追加；200重开，416证据不足重下；partial写入状态可checkpoint。
- [ ] filename防穿越/Windows保留名/大小写Unicode碰撞；主视频成功而字幕失败只warning。
- [ ] 只完成本地 create/resume/open/remove 与 .part 检查点；不创建 R2 multipart/云对象传输；服务依赖 ArtifactStore 接口而非直接 import fs。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/download.test.ts
```

**必须验收：**

- `A231`：多GiB合成流不全buffer；崩溃不发布manifest；取消保留可识别的本机.part恢复记录或按既定策略清理。
- `A232`：同名资源不覆盖；scope/path/已提交 manifest 检查正确；整个本地导出不需要云配置或远端存储。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T24 · 本地PDF与字体重型实现

**依赖：** T12, T23

**建立/修改：** `packages/sdk/src/content/pdf.ts`；`packages/sdk/src/content/font-match.ts`；`packages/sdk/src/runtime/node/render.ts`；`packages/sdk/src/runtime/node/render-page.ts`；`packages/sdk/src/runtime/node/legacy-slides.ts`

**测试文件：** `packages/sdk/tests/render.test.ts`

**输入接口/依据：** Y05；RenderInput/RenderOutput；APPS A04 的本地预算；用户于 2026-10-27 确认参考字体首次自动下载、固定摘要校验与缓存，见 YKT-HOMEWORK。

**输出：** /render-node、HeavyRenderer本机实现；受控PDF/字体算法

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const result=await matchGlyph(ambiguousGlyph, references);
expect(result).toMatchObject({state:'unresolved'});
expect(browserNetworkRequests).toHaveLength(0);
```

- [ ] pdf-lib对有界图片集组PDF，先查页数/压缩字节/像素，再渲染；不宣称无界流式PDF。
- [ ] 普通作业使用纯 JS opentype 字形解析与 TS 匹配，不依赖 Chromium/Canvas；仅准备阶段下载固定校验的公开参考字库，解码器只读本地字节，不接触 Cookie 或执行任意 HTML。2026-10-27 按已确认方案替代原 Canvas 路线，实测结果见 PROGRESS。
- [ ] golden人工已核验映射，易混候选保留unresolved；renderer/字体摘要版本化；没有字体文件不复制系统字体进交付。
- [ ] HeavyRenderer 本机 start/status/cancel 覆盖三类输入；特殊课件按固定源码验证路径/副作用，不执行任意 HTML。CLI 本地注入 /render-node，不依赖 apps/executor、Docker、R2或服务器。进程恢复返回missing，旧attempt结果不发布。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/sdk exec vitest run tests/render.test.ts
```

**必须验收：**

- `A241`：至少覆盖旧易混字样例与3份独立样本/200个核实字形；缺样本明确阻塞质量验收，不伪造准确率。
- `A242`：超页数/像素/期限提前拒绝；一个任务结束context销毁，Cookie不带入纯字体/PDF。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T25 · CLI基础命令与本地运行装配

**依赖：** T06, T08, T11, T03, T18

**建立/修改：** `apps/cli/src/index.ts`；`apps/cli/src/runtime.ts`；`apps/cli/src/commands/profile.ts`；`apps/cli/src/commands/login.ts`；`apps/cli/src/commands/catalog.ts`；`apps/cli/vitest.config.ts`；`apps/cli/src/commands/init.ts`；`apps/cli/src/commands/doctor.ts`；`apps/cli/src/scheduler.ts`；`apps/cli/src/lock.ts`

**测试文件：** `apps/cli/tests/basic.test.ts`

**输入接口/依据：** SDK/node出口；APPS A02

**输出：** init/profile/login/whoami/courses/outline/doctor命令

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const p=await runCli(['courses','--profile','fixture','--json']);
expect(()=>JSON.parse(p.stdout)).not.toThrow();
expect(p.stdout).not.toContain('sessionid');
```

- [ ] Commander解析参数，TTY可选菜单，非TTY必须明确profile；userId固定local，profileId不因显示名改动而变化。
- [ ] init生成master.key并限制权限，不覆盖；独占lockfile只锁本机数据目录，残留需显式解锁。
- [ ] --json stdout只有结构化数据；日志/进度stderr；浏览器缺失doctor报告不自动安装。
- [ ] 实现前台 Node scheduler 和 wake 信号；userId=local。jobs list/show 可只读本机记录；活跃写进程存在时其他进程写控制报 CONFLICT，提示先在原终端 Ctrl+C，不增加 IPC 服务。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/cli exec vitest run tests/basic.test.ts
```

**必须验收：**

- `A251`：本机未配置Cloudflare仍能用fixture完成login/course；两个进程同时运行写入第二个拒绝。
- `A252`：错误码按APPS，导入成功不打印Cookie；无TTY不无限等输入。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T26 · CLI完整功能入口与恢复操作

**依赖：** T15, T16, T17, T19, T20, T21, T22, T23, T24, T25

**建立/修改：** `apps/cli/src/commands/tasks.ts`；`apps/cli/src/commands/drafts.ts`；`apps/cli/src/commands/exams.ts`；`apps/cli/src/commands/live.ts`；`apps/cli/src/commands/download.ts`；`apps/cli/src/commands/slide.ts`；`apps/cli/src/commands/run.ts`；`apps/cli/src/commands/discuss.ts`；`apps/cli/src/commands/answers.ts`

**测试文件：** `apps/cli/tests/commands.test.ts`

**输入接口/依据：** 所有SDK服务，APPS完整命令表

**输出：** download/slide/run/homework/exam/discuss/match/live/jobs 全部本地入口，含 jobs reconcile

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const p=await runCli(['exam','submit','draft.yaml','--yes']);
expect(p.exitCode).toBe(2);
expect(upstreamWrites).toHaveLength(0);
```

- [ ] 命令只组参数/显示/调用SDK，不复制平台URL或业务算法。
- [ ] 需要写入走preview；--dry-run不发；exam submit要求--yes --final；后台未开启daemon。
- [ ] Ctrl+C 保存暂停并关闭连接/浏览器；resume核对pending/generation。jobs reconcile <job-id> 对任务的pending operation做只读核对；结果仍uncertain时拒绝resume且不重交。T24 本地渲染必须接入真实CLI路径，不能因云executor延期而丢弃。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm --filter @learning/cli exec vitest run tests/commands.test.ts
```

**必须验收：**

- `A261`：完整fixture命令矩阵，每个命令至少正常与失败；确保入口能调用真实SDK而不是输出固定文案。
- `A262`：命令被打断后恢复不重复提交；旧格式导入先检查不误覆盖。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## T31 · SDK与CLI集成验收、安装说明与本机证据

**依赖：** T26

**建立/修改：** `docs/INSTALL.md`；`docs/USAGE.md`；`docs/FEATURE-STATUS.md`；`docs/PROGRESS.md`；`.github/workflows/ci.yml`；`package.json`；`apps/cli/package.json`；`apps/cli/vitest.e2e.config.ts`

**测试文件：** `apps/cli/tests/e2e.test.ts`

**输入接口/依据：** 本期 ACCEPTANCE 全部ID、当前 E01–E08、三个固定refs；不含延期 Web 验收

**输出：** SDK/CLI 本机构建与离线集成证据、安装/升级/恢复文档、逐能力验证矩阵

- [ ] 读取本任务规范、源码与当前实现；新证据记入 protocol-evidence，不重新选型。
- [ ] 创建正常/异常测试，至少含以下断言；运行确认预期失败，记录具体原因。

```typescript
const run = await runPackedCli(['--help']);
expect(run.exitCode).toBe(0);
expect(run.stdout).toContain('learning');
expect(unapprovedLiveWrites).toHaveLength(0);
expect(featureStatus.every(x => x.status !== 'live-tested' || x.evidence.length > 0)).toBe(true);
```

- [ ] CI 只跑两包边界、Node SDK/CLI 单测、构建和本地CLI进程 E2E。root test:e2e 指向 pnpm --filter @learning/cli exec vitest run --config vitest.e2e.config.ts；该独立配置的include仅tests/e2e.test.ts，不继承单元配置的同名exclude。普通单元配置排除e2e.test.ts，避免漏跑或双跑；没有Web测试。
- [ ] 在临时干净消费者目录安装/链接打包后的 SDK 与 CLI，不使用源码路径别名；验证 bin/shebang/import 与 learning --help/init/fixture课程/导出/恢复。root/public 静态图不带 Node 实现，不构建空 Web 来凑检查。
- [ ] 写 INSTALL/USAGE：固定 Node/pnpm、私有源码安装、build、首次init、profile/扫码、本机密钥/可选模型、显式本机浏览器/自动参考字体缓存、备份/升级/回滚、unlock/Ctrl+C/resume/reconcile及清理；不编写云 DEPLOY 或要求Cloudflare Secret。
- [ ] 按平台/能力分别记录代码、fixture、本机集成和经用户授权的真实只读/写入证据。字体质量仍按 T24，缺样本记具体阻塞；未授权真机写入 not-run，Web/Cloudflare仅deferred且不计当前完成分母。
- [ ] 核对本期28项与所有当前验收；T31结束后停止，不回到T27–T30，不自动安装或开发延期应用。
- [ ] 运行下面命令及根 `pnpm typecheck`，再跑依赖链相关回归；失败先找原因，不修改验收标准。

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
```

**必须验收：**

- `A311`：SDK/CLI 共用唯一 provider 实现；当前workspace仅两包，本期未新增Web/executor/cloudflare代码或云测试脚本；已有延期代码不参与当前构建。
- `A312`：全新本机环境按 INSTALL/USAGE 完成安装、构建、离线CLI E2E；退出与恢复不误提交；真机/字体未验证不写全部通过，延期Web不计本期缺陷。

- [ ] 更新 PROGRESS 的实际改动、命令/退出码、未运行项、证据缺口与下一任务。本地提交只包含当前任务文件；未授权不push、不改main、不部署。

## 本期最后检查与停止条件

仅当前28项参与进度与验收。done须有实际检查证据；partial/blocked逐项说明，不以future Web缺失阻止本期。平台真机证据与本地fixture证据分开；未知题型/字体样本不足不能伪造成功。

T31结束后停止。只有用户另行授权Web才从deferred/WEB.md重新规划，不能因为任务编号有空档而自动补做T27–T30。当前没有Cloudflare部署验收、浏览器Web E2E或容器测试。
