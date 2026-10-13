# learning — 本期 SDK + CLI 模型交接

版本1.1。本期只开发SDK与CLI；Web延期。使用能读写仓库并运行终端/测试的编码环境，不能让聊天环境假装已经实现或执行。

## 1. 准备与替换

仓库 `cqu-moe/learning` 已按 2026-10-14 用户确认改为公开。ZIP中的learning/内容放仓库根目录，AGENTS.md、README.md、docs/直接在根。只含文档/声明，工程由T01建立。

只把本版1.1作为活动规范，不并列旧1.0/v0.1/v0.2。如果已有代码与进度：先保留原git diff/PROGRESS，按本版范围逐项合并，不重建已完成实现、不删除既有Web代码、不清空测试记录。旧Web内容标deferred并从当前构建/任务依赖移出即可；需要删除实际文件须单独授权。

参考仓库通过授权读取或在.reference/准备只读checkout并gitignore，固定ref如下。提供源代码访问不是授权执行旧CLI或提供平台会话。

| 仓库 | 固定ref |
|---|---|
| cqu-moe/ykt-cli | 48a92c24498980d01aa045cf734ba3095d5f5bd1 |
| cqu-moe/xuetang-cli | 628a8fa8a4b90897f285a109aa591a8f6263846d |
| cqu-moe/zhs-cli | 56d02171cf73c45694d69f886c902d2ecedadaaa |

## 2. 新项目：第一次直接发送

```text
请在当前 cqu-moe/learning 仓库按1.1规范实施。本期只做共享SDK与本地CLI，Web延期。

先读取 AGENTS.md、docs/SPEC.md、docs/SDK.md、docs/contracts.d.ts、
docs/PLAN.md 的总说明及 T00–T02、docs/PROGRESS.md。
本次只完成 T00、T01、T02，不提前做其余任务。

当前严格只有 packages/sdk（@learning/sdk）和 apps/cli（@learning/cli）两个workspace。
不创建 apps/web、apps/executor、runtime/cloudflare、Dockerfile、Wrangler配置或占位测试。
不安装 React/Vite/Hono/Cloudflare依赖，不配置Access或其他规范禁止的冗余服务。
保留Runtime接口，但本期只实现Node适配；本地PDF/字体/课件渲染在T24仍需完成。

固定参考源码及证据；创建真正可构建的两包工作区；实现公共DTO/schema、稳定ID和测试内存存储。
T00尚无pnpm工程，只执行其Node检查脚本。测试先行，确认失败，再实现并运行相关回归。
缺私有源码权限则精确记录repo/ref/path，只阻塞对应能力，不从记忆猜协议或下载公开fork替代。

仅编辑本仓库并跑离线测试，不执行真实平台操作、付费模型、云部署、参考仓库修改或push main。
不以any/空返回/skip/删断言冒充完成。每项完成更新PROGRESS，给出文件、实际测试命令、
退出码、未运行项及原因、下一个任务编号。
本期执行顺序只为T00–T26然后T31；T27–T30延期，完成T31后停止。
```

首批核对workspace确实只有两个、根/public静态边界能拦住Node泄漏、无Web依赖和空脚本、测试调用实际实现、进度有真实命令。不要以代码行数判定完成。

## 3. 已按旧版开始：切换范围提示

```text
learning规范已更新到1.1：本期只完成SDK+CLI，Web/Cloudflare延期。
请先读当前AGENTS、SPEC、PLAN、PROGRESS和git diff，对照合并范围变化。
保留已有代码、完成记录和用户修改，不重置进度，不删除既有Web文件。
当前workspace/默认构建与测试只面向SDK和CLI；云代码如已存在，标为延期并解除本期依赖，
需要实际删除文件先报告，不自行执行。
T01只建两包；T05只做Node传输；T23只做本地ArtifactStore；T24本地渲染保留；
T31变为本机集成验收，不依赖T27–T30。
本次先完成这项范围对照并记录真实已完成/受影响任务；不要重新实现已通过模块。
```

## 4. 后续逐项继续

```text
继续learning。先读AGENTS、PROGRESS、当前git diff，以及当前PLAN中依赖已满足的下一个任务。
本次只做该任务，不重写已完成部分，不重新选型、不扩展到Web。
只选择T00–T26或T31；当前全部完成或无可执行任务时停止并报告，不从deferred目录找活做。
按当前任务测试先行并跑实际回归，更新PROGRESS和证据。缺口精确记录，禁止假成功。
没有明确授权不发真实平台请求、付费调用、部署或推送。
```

熟悉工程后可指定相邻两个小任务；不要求一口气写完。一次任务只读根约束、当前规范/接口/测试与对应源码，不要求重复通读整个历史设计。

## 5. 越界/冗余纠偏

```text
暂停新增设计。当前是SDK+CLI两包阶段，不是Web项目。
列出你本次引入的apps/web、apps/executor、runtime/cloudflare、Cloudflare/React依赖、
Docker/部署/站点登录与其他超范围内容。只撤回你本次新加的无关改动，保留用户和既有代码，
不要reset/clean全仓。
保持SDK中立接口、完整Cookie、账号隔离、加密保存、预览与不确定写入、本地渲染和必要测试。
恢复本期范围后运行相关测试，更新实际进度；不要为了少写代码删掉已定CLI功能。
```

## 6. 本期完成复核提示

```text
请独立复核learning的SDK+CLI，不默认相信PROGRESS。
对照1.1 SPEC/SDK/contracts/PLATFORMS/APPS/ACCEPTANCE及T00–T26/T31。
检查两包和根/public依赖边界、平台wire来源、Cookie/profile/generation隔离、HTTP200伪成功、
提交超时不重交、.part恢复/不覆盖、前台进程退出和恢复、本地PDF/字体质量与输入预算。
运行真实本机离线单测与构建后CLI E2E，确认测试不是只验证mock自己。
Web/Cloudflare/T27–T30是延期，不要求它们有代码、云账号或测试；Node通过也不能声称云兼容。
不发真实写入或付费请求。报告具体文件/位置、复现、影响、最小修复和缺少的证据。
```

## 7. 状态与授权

实现授权与平台真机/付费调用授权分开。Node离线代码工作不需要Cloudflare密钥；整个本期没有云部署任务。平台写入、考试交卷与付费模型须逐项确认，秘密通过安全本机配置注入，不粘贴进聊天/源码。

PLAN/tasks.json只收录28个当前任务，PROGRESS初始模板也只含当前项。真实证据分类为代码/fixture/Node集成/授权live；Web和云端写deferred，不计本期完成分母，也不需要创建skip测试。

SPEC/SDK/contracts/PLATFORMS/APPS决定做什么；PLAN决定顺序；ACCEPTANCE决定正确性；PROGRESS只记录实际结果。完成T31后停止，未来Web由用户另行发起。
