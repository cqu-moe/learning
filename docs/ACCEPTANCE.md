# learning — SDK + CLI 本期验收

版本1.1。以下是未来产品测试要求，不是本轮已通过结果。本期56组编号要求对应T00–T26及T31；Web/云端测试整体延期，不计当前分母。

| ID | 任务 | 必须断言 | 测试文件 |
|---|---|---|---|
| A001 | T00 | 缺少任一私有仓库时明确列出repo/ref及权限缺口；只暂停对应provider，不能下载公开fork替代。 | `scripts/check-source-lock.mjs` |
| A002 | T00 | source-lock.json 的ref均40位十六进制；实际 git rev-parse HEAD 必须相等；输出不得含token。 | `scripts/check-source-lock.mjs` |
| A011 | T01 | pnpm install --frozen-lockfile 第二次成功；workspace恰好包含 @learning/sdk 和 @learning/cli。新项目不生成Web/executor空包；已有延期代码不加入当前workspace/构建且不擅自删除。 | `scripts/check-boundaries.mjs` |
| A012 | T01 | public/root 错误导入 Node 实现的负例被边界检查拒绝；依赖中无 React/Vite/Hono/Wrangler/Cloudflare 插件，无云部署/测试占位脚本。 | `scripts/check-boundaries.mjs` |
| A021 | T02 | 同videoId不同小节必须产生不同resource key；不同userId/profileId绝不相同。 | `packages/sdk/tests/types.test.ts` |
| A022 | T02 | 未知ID、NaN/Infinity、超过安全整数输入拒绝；zhs smallLessonId="0"明确例外；Page unknown不改complete。 | `packages/sdk/tests/types.test.ts` |
| A031 | T03 | 一组revision冲突则全部不改；修改两个key是原子的；delete符合约定。 | `packages/sdk/tests/store.test.ts` |
| A032 | T03 | 错误user/profile/AAD解密失败；旧generation响应不能覆盖注销记录；存储失败不触发上游重发。 | `packages/sdk/tests/store.test.ts` |
| A041 | T04 | 同名不同domain/path/hostOnly；Expires逗号；多Set-Cookie；恶意域名后缀/私网跳转均覆盖。 | `packages/sdk/tests/http.test.ts` |
| A042 | T04 | 写响应丢失只请求1次；read取消立即终止；HTTP200+错误body不得变空课程。 | `packages/sdk/tests/http.test.ts` |
| A051 | T05 | 旧QR确认到达晚于新QR不得覆盖；cancel后无Cookie保存、socket与timer均释放。 | `packages/sdk/tests/auth-flow.test.ts` |
| A052 | T05 | probe网络错indeterminate，不清旧Cookie；factory/import没有网络请求。 | `packages/sdk/tests/auth-flow.test.ts` |
| A061 | T06 | fixture请求头缺一即测试失败；cid语义正确；kg false与请求失败分开。 | `packages/sdk/tests/ykt-catalog.test.ts` |
| A062 | T06 | 根考试+深层资源同时保留，空folder不成伪资源；缺leafId不能0兜底。 | `packages/sdk/tests/ykt-catalog.test.ts` |
| A071 | T07 | 两份结果顺序不同也对齐；字幕失败不等于absent。 | `packages/sdk/tests/ykt-resources.test.ts` |
| A072 | T07 | history slides不启动浏览器，不调用签到；index顺序稳定；缺font不能伪明文。 | `packages/sdk/tests/ykt-resources.test.ts` |
| A081 | T08 | 只返回第一页不可标全量；缺skuId不能伪造0；根resource不丢。 | `packages/sdk/tests/xuetang-catalog.test.ts` |
| A082 | T08 | 旧消息与取消竞态无错误绑定，probe超时不触发清Cookie。 | `packages/sdk/tests/xuetang-catalog.test.ts` |
| A091 | T09 | 恶意exam_host在泄漏crypt前拒绝；两试卷并发不串Cookie。 | `packages/sdk/tests/xuetang-resources.test.ts` |
| A092 | T09 | 开始考试和交卷请求次数为0，题型未知保持unknown。 | `packages/sdk/tests/xuetang-resources.test.ts` |
| A101 | T10 | 中文、空串、16-byte边界与Python合成向量相同；ev的Unicode语义按source测试。 | `packages/sdk/tests/zhs-auth-crypto.test.ts` |
| A102 | T10 | 408/404/405/403分态；错误账号/假本地uuid不可视为valid。 | `packages/sdk/tests/zhs-auth-crypto.test.ts` |
| A111 | T11 | 大于5门课程末页不漏；同videoId两处保留。 | `packages/sdk/tests/zhs-catalog.test.ts` |
| A112 | T11 | 读取catalog不发save/view写接口；字段不同的fixture捕获错用ID。 | `packages/sdk/tests/zhs-catalog.test.ts` |
| A121 | T12 | script/onerror/javascript链接不执行；sub/sup不产生非法双下标，也不吞边界空格。 | `packages/sdk/tests/content.test.ts` |
| A122 | T12 | 负号、1.0/10、指数、单位差异不得在匹配文本被抹除。 | `packages/sdk/tests/content.test.ts` |
| A131 | T13 | 同problemId不同课堂不能直接回填；选项换顺序正确映射，重复选项歧义拒绝。 | `packages/sdk/tests/drafts.test.ts` |
| A132 | T13 | 无效JSON/不存在选项/未解码题干均不形成可执行答案，无Cookie传模型。 | `packages/sdk/tests/drafts.test.ts` |
| A141 | T14 | 同preview重复点仅一次上游请求；过期/改题/重登录均拒绝。 | `packages/sdk/tests/actions.test.ts` |
| A142 | T14 | sending后崩溃、ack后存储失败不会重放；取消保留已发生结果。 | `packages/sdk/tests/actions.test.ts` |
| A151 | T15 | 请求必要headers/body类型精确断言；误混学堂答案对象必须失败。 | `packages/sdk/tests/ykt-write.test.ts` |
| A152 | T15 | 没有标准答案不选第一项、不穷举，发送失败只一次。 | `packages/sdk/tests/ykt-write.test.ts` |
| A161 | T16 | 主观answer对象及填空map分别精确fixture；unset零写入。 | `packages/sdk/tests/xuetang-write.test.ts` |
| A162 | T16 | HTTP200 success=false失败；未知schema不能空thread成功。 | `packages/sdk/tests/xuetang-write.test.ts` |
| A171 | T17 | 未开始时save不能偷偷start；timed unknown提示计时；已终结不重复操作。 | `packages/sdk/tests/xuetang-exam-write.test.ts` |
| A172 | T17 | 缓存与最终交卷独立operationId；两试卷不串Cookie；超时不重交。 | `packages/sdk/tests/xuetang-exam-write.test.ts` |
| A181 | T18 | 本地重复 wake/advance、旧 generation、sending 残留都不能再次提交；unknown 版本暂停。 | `packages/sdk/tests/jobs.test.ts` |
| A182 | T18 | CLI 反复读取状态或重复执行同一 preview 不新建重复 job；cancel不回滚旧receipt；一项失败summary准确。 | `packages/sdk/tests/jobs.test.ts` |
| A191 | T19 | 采样无未来ts，cp不超过duration，sq/pg正确；服务器未确认不succeeded。 | `packages/sdk/tests/ykt-study.test.ts` |
| A192 | T19 | 中途停机后从读回进度恢复；duration未知拒绝；风控暂停。 | `packages/sdk/tests/ykt-study.test.ts` |
| A201 | T20 | bare object/lob错误在fixture断言失败；无ratechange非1x应测试失败。 | `packages/sdk/tests/xuetang-study.test.ts` |
| A202 | T20 | 延迟回读先waiting，最终确认才完成；pause/重启不补造停机时间。 | `packages/sdk/tests/xuetang-study.test.ts` |
| A211 | T21 | 官方已知watchPoint向量一致；设置target0.91不能强置serverCompleted。 | `packages/sdk/tests/zhs-study.test.ts` |
| A212 | T21 | 单视频内部deadline/abort有效；未知dataType不自动view。 | `packages/sdk/tests/zhs-study.test.ts` |
| A221 | T22 | 普通slides读取不签到；已结束的问题不能答；重复事件不重复提交。 | `packages/sdk/tests/live.test.ts` |
| A222 | T22 | 本机 WS 断线或进程恢复后新握手并报告 gap；Ctrl+C 后持久暂停且释放连接，退出后不继续后台监听。 | `packages/sdk/tests/live.test.ts` |
| A231 | T23 | 多GiB合成流不全buffer；崩溃不发布manifest；取消保留可识别的本机.part恢复记录或按既定策略清理。 | `packages/sdk/tests/download.test.ts` |
| A232 | T23 | 同名资源不覆盖；scope/path/已提交 manifest 检查正确；整个本地导出不需要云配置或远端存储。 | `packages/sdk/tests/download.test.ts` |
| A241 | T24 | 至少覆盖旧易混字样例与3份独立样本/200个核实字形；缺样本明确阻塞质量验收，不伪造准确率。 | `packages/sdk/tests/render.test.ts` |
| A242 | T24 | 超页数/像素/期限提前拒绝；一个任务结束context销毁，Cookie不带入纯字体/PDF。 | `packages/sdk/tests/render.test.ts` |
| A251 | T25 | 本机未配置Cloudflare仍能用fixture完成login/course；两个进程同时运行写入第二个拒绝。 | `apps/cli/tests/basic.test.ts` |
| A252 | T25 | 错误码按APPS，导入成功不打印Cookie；无TTY不无限等输入。 | `apps/cli/tests/basic.test.ts` |
| A261 | T26 | 完整fixture命令矩阵，每个命令至少正常与失败；确保入口能调用真实SDK而不是输出固定文案。 | `apps/cli/tests/commands.test.ts` |
| A262 | T26 | 命令被打断后恢复不重复提交；旧格式导入先检查不误覆盖。 | `apps/cli/tests/commands.test.ts` |
| A311 | T31 | SDK/CLI 共用唯一 provider 实现；当前workspace仅两包，本期未新增Web/executor/cloudflare代码或云测试脚本；已有延期代码不参与当前构建。 | `apps/cli/tests/e2e.test.ts` |
| A312 | T31 | 全新本机环境按 INSTALL/USAGE 完成安装、构建、离线CLI E2E；退出与恢复不误提交；真机/字体未验证不写全部通过，延期Web不计本期缺陷。 | `apps/cli/tests/e2e.test.ts` |

## 本期发布要求

默认CI没有真实用户Cookie；未登记平台请求失败。验证Node真实传输/SQLite/文件适配与CLI进程调用，不能只测假实现自洽。工作区计数只含SDK+CLI，不将未来空包算作正确架构。

每个启用平台endpoint至少有正常、权限/协议错误、关键字段缺失fixture；写入另有响应丢失和sending恢复；method/path/query/header/body均核对。Crypto用独立明确向量，不能仅往返自我一致测试。

本地传输/下载覆盖206/200/416、validator变化、Retry-After HTTP-date、Cookie域/path、恶意redirect、目录穿越、同名/大小写/Unicode碰撞、scope与manifest。渲染覆盖有界内存、取消、进程missing、旧attempt结果、易混字golden；使用真实本机浏览器不等于开发Web。

证据分层：声明/边界检查 → SDK/CLI离线fixture → Node适配与真实本机渲染 → 构建包的CLI E2E → 用户逐项授权的平台只读/写入验证。每层独立说明；缺字体golden明确blocked；未授权真机操作not-run。不得用永久关闭功能代替实现并声称全覆盖。

Cloudflare/workerd/R2/DO/Containers/Web登录/页面/E2E/部署全部为deferred，不创建skip测试或假通过脚本，不属于本期失败项。未来进入Web需另建真实验收，当前Node通过不代表它通过。

T31最终离线命令：`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`。只含当前两包与本地CLI集成，不需要云密钥或Docker。

## CLI 0.2 体验补充验收

- UX01–UX08 对应的输出、提示、偏好、课程选择、登录、进度、确认及恢复测试位于 apps/cli/tests；真实 PTY 覆盖补参、Clack、取消、quiet 预览和进程 SIGINT 后的独立状态读回。
- 33 条叶子命令以实际 Commander 注册树核对；包括原帮助矩阵漏掉的 exam draft、operations reconcile，以及三个 config 命令。
- 严格业务 fixture 在独立的合成状态副本中分别运行机器格式与 plain，比较退出结果，保留原业务断言和未登记请求拒绝。
- packed E2E 使用 pnpm 11 的真实离线 tarball 安装，并核对 SDK/CLI 各自版本。
- 实际门禁结果记在 PROGRESS；此节为验收项，不提升旧任务中真实平台、字体或硬工作片的证据等级。
