# learning — SDK 契约与实现约定

版本 1.1；本期 SDK + CLI。`contracts.d.ts` 是规范声明，实际实现用 Zod schema + z.infer 生成数据类型，服务/端口 interface 按声明提供。不要维护第二份 DTO 手写结构。本文件不要求先生成几百行未实现方法；PLAN 到对应任务时增加真实模块。

## S01. 公开边界

包 `@learning/sdk` 根导出 createLearningClient、aggregateCourses、安全错误类型；`/public` 导出 DTO/schema，不能导出 Cookie 或 Runtime；`/node` 提供 Node 传输、SQLite StateStore、本机 ArtifactStore、CLI 初始化工具；`/render-node` 在 T24 提供实际重型算法与受控浏览器执行。本期不创建 `/cloudflare` 出口或空实现。Runtime 接口保持环境中立，未来 Web 再实现其适配。

provider 用内部 switch 选择 ykt/xuetang/zhs，三个模块共享纯代码，不共享未经证明的 wire 映射。不做配置驱动的万能 endpoint 执行器。每个原生 API 用具名普通函数，附近注释注明 source ref、HTTP 方法、是否改变上游状态、成功 envelope。关键 request/response 用 Zod 校验，额外无关字段允许保留/忽略，但关键 ID、success 和 data 结构不能缺失后静默兜底。

factory 仅构造对象，不能因为 import/创建就读 Cookie、联网或启动浏览器。应用初始化后请求调用才执行 I/O。

## S02. ID、资源与内容

所有完整 locator 在 docs/contracts.d.ts。key 用下段固定数组的 `SHA256(JSON.stringify(array))`；课程和资源用不同前缀，资源额外包含 course key。UTF-8、数组顺序固定、不拼含分隔符歧义的字符串。每个服务核对 scope 和 native kind；仅传来正确 hash 不代表有权限。

固定摘要输入数组如下（输出为小写hex）：Course为 `["learning.course.v1",userId,profileId,platform,...courseTuple]`；Resource为 `["learning.resource.v1",userId,profileId,platform,course.key,...resourceTuple]`。courseTuple分别为 `["ykt",classroomId]`、`["xuetang",classroomId,courseSign,skuId]`、`["zhs-share",recruitAndCourseId]`、`["zhs-hike",courseId]`；resourceTuple分别为 `["ykt",leafId,leafInfoId]`、`["xuetang",leafId,leafInfoId]`、`["zhs-share",chapterId,lessonId,smallLessonId,videoId]`、`["zhs-hike",fileId]`。可空leafInfoId显式null，不替换成空串。计算函数在tests中可用注入或已验证纯JS SHA-256实现同步调用，禁止引入node:crypto到public。

课程表示选课/教学班，不按同名合并。OutlineNode 可以同时有 children 和 resources；显示用 id 不代替 native locator。没有稳定树节点 ID 可使用当前快照路径编号，但写入必须使用资源 native ID。模型中的 path 只用于显示与文件名。

RichText.markdown 是清理后的内容，不是原始 HTML；plainText 用于匹配。parse5 保留块、列表、图片替代、换行；来源中可取到的 TeX/sub/sup 要保留。图片 URL 不受信任，要通过受控资产映射再显示；无法解析的公式保留文本并 warning，不能删掉。decodeState 不为 complete/not-needed 的题干不可自动匹配或给模型当明文。

Page.nextCursor=null 不能自动意味着全集，必须看 completeness。cursor 内的 profile、参数摘要和页码需校验，不接受任意 URL。初始页面默认 50、最大 200；平台固定 pageSize 可保持原值，由服务汇总。无法证明下一页/终止条件返回 unknown，并在能力文档列出证据缺口。

## S03. HTTP 与会话

`Transport.fetch` 只发一跳，不重试、不自动 redirect；Request 必须带 signal。SDK http/session-client 管 Cookie、出口白名单、重定向和已允许的读取重试。得到响应立即吸收各条 Set-Cookie；读取多条头使用运行时真正的多值 API，不按逗号 split。

原生参数类型按源代码，不将字符串数字/布尔全部标准化。中文 AES 按 UTF-8 字节，WebCrypto AES-CBC 自带 PKCS#7 时不再 pad；智慧树 MD5 单独实现 legacy helper，绝不用于站点凭据。支持不依赖 Node native 的 SHA/MD5 实现，本期 Node 与独立标准/Python fixture 同向量测试；workerd 测试延期。

读取总尝试最多 3 次，500ms 起、10s 封顶，429 尊重 Retry-After 秒数/HTTP-date。普通请求总时限 30s，job step 子请求使用 min(请求预算, step剩余预算)。二维码等待超时与普通网络超时分开。写接口不通用自动 retry；已发送后断线必须 uncertain。

Session 私有记录最少包含 schemaVersion=1、scope、generation、platformUserId/identityVerified、完整 CookieJar、平台必要短期字段。平台身份只来自在线/已验证认证交换；Cookie 本地自带 uuid 不足以认证身份。主 CookieJar 每 profile 一个，同 profile 的串行请求避免两个旧快照覆盖新 Cookie；CSRF 按 URL 和当前 jar 获取，不常驻复制成过期常量。

Cookie 导入只解析用户指定文件中的必要 Cookie，不扫描系统浏览器、不导入无关 localStorage。旧 flat ykt/xtx 仅允许已知主站 Cookie 定位到确切 www 主机，报告有损导入；考试 Cookie 域缺失时丢弃并重新做已允许 SSO。zhs 不猜所有 Cookie 都是同一域。验证成功再替换，不因导入失败删除旧账号。

## S04. 存储接口不演变成 ORM

StateStore 已由宿主绑定 userId。key 只由 SDK 内部生成，格式为 `profile:<id>`、`session:<id>`、`preview:<id>`、`job:<id>`、`operation:<id>`、`draft:<id>`、`artifact:<id>`、`event:<jobId>:<paddedSequence>`、`auth:<flowId>`。

本地 SQLite 只需一个 `records(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)` 表，`schema_meta(version)` 单独记录数据库版本。大型数据/文件放 ArtifactStore，不往记录塞 base64 视频。不要基于这个表建设通用可配置数据平台。

commit 的 expected 必须覆盖所有被修改 key；null 表示原本不存在。检查任一 revision 不符则整组不改、返回 false；成功每 key revision+1（新建=1）。changes.value=null 表示删除。一次 commit 在本地 SQLite 事务中完成，无跨 actor callback/网络。会话注销保留 generation tombstone，不删除后重用 generation=1。

state 中会话、私有草稿/操作正文由 SDK 用 AES-256-GCM 包装；随机 96-bit IV，AAD 包括 userId/profileId/recordKind/schemaVersion；本期主密钥由 CLI 本机文件或环境变量注入，不创建 Web Secret 配置。普通展示状态可明文。标准存储错误不能让业务自动重新发送已确认的上游写入。

## S05. 简单预览和写入记录

prepare 保存完整规范化 ActionInput 与 fingerprint，返回不带秘密的 Preview。无 blocker 时用户确认后调用 execute(id)。服务重新读题型、已交状态、内容 fingerprint 和 generation；不变才发送或排入已固定输入的任务。普通 SSO 可以用于读取核对，但不隐式 start_paper/checkin/article_finish。

execute 映射：homework.apply → homework job；study → study job；live.join → live job。exam.start/save/finalize、discussion.post、document.visit、live.answer 是短动作，返回 Receipt。preview 第一次执行原子地记录 executionId/jobId，之后重复 execute 返回同一个结果。live.answer 可在其 live job 活跃时执行，但仍走该 profile 的写队列，不被排到直播结束之后。

Preview 过期只影响尚未开始的执行，不让已批准长任务十分钟后强停。任务 deadline 来自输入 maxDurationSeconds，暂停不延长。批次固定 resource/question IDs，不能运行中自动加新课程。重新登录或更换用户使旧 preview/任务需重新确认；同身份的新 generation 也先重新核对，不自动继承。

操作记录：`id, scope, generation, actionKind, inputHash, state, createdAtMs, result`。state 至少 sending/confirmed/uncertain/rejected。每个题目/心跳批次等实际写有独立子 operationId；使用 jobId + 稳定步骤号生成。写意图先于网络；收到明确结果与 step checkpoint 一起 commit。result 必须安全 schema，不直接存完整原始响应供 API 返回。

reconcile 只做读回核对：能证明当前内容和这次输入对应才 confirmed；仅“已有一次作答”不证明本次答案，仍 uncertain。CLI 提供“去平台核对/结束此任务”，不可自动以新 id 再提交。未知题型、unset、无效选项在网络前拒绝。

## S06. 固定任务而非工作流平台

内部 JobRecord = Job + schemaVersion(1) + protocolVersion + inputRef + generation + cursor(Json) + pendingOperationId + pauseRequested/cancelRequested + deadlineAtMs。cursor 单条上限 64KiB，含完成子项、上传状态或确认进度引用，不含 socket、函数、timer、密钥或整题库。Job.items API 超过 200 项分页/单独查看，不无限回传。

advance 的固定顺序：检查版本/取消/期限 → generation → pending sending/uncertain 核对 → 读取必要上游状态 → 执行一个有界工作片 → 原子保存 → nextRunAt。每用户仅一个 active 长任务由宿主控制；SDK 遇到同 job 重入返回 CONFLICT，不继续发请求。status 查询不进入长任务锁。

study 处理器按平台编写，不做一个无限循环的万能播放器。所有位置增加只对应活跃工作时间；停止/驱逐/重启后重新读取服务器位置，不补发过去样本。目标完成与 serverCompleted 分开；源码 0.91 只可作为目标，不意味着正式完成。最多 180s 核对期，超过回到需要处理的状态并展示“不确定/未确认”，不是 succeeded。

初始任务执行参数：study speed=1，targetFraction=1，questionMode=pause，maxDurationSeconds=3600（上限21600）。速度上限必须按 PLATFORMS 的已验证范围；不静默提速。model 模式必须在本次任务预览里明确，且有已配置模型；解析失败/未解码/未知选项不能自动选第一项。

live 的运行连接由本地任务宿主持有，必要状态写 SQLite。收到上游消息放有界 mailbox，触发 runtime.wake；advance 消费、保存去重与事件，再通知 CLI。Socket 断线或进程恢复时重新握手并发 gap；不承诺补齐离线消息。进程退出不继续监听。过期问题拒绝答题，未确认的旧提交不重放。

export 将资源解析和传输分开。下载时即取签名 URL，不存作长期身份。按资源状态推进，副产物失败记录 warning 不回滚已完成视频。本期只实现 Node .part 恢复；source validator、Content-Range 不匹配必须重下，206才追加，200重开，416仅在有足够长度/校验证据时完成。ArtifactStore.checkpoint 为私有上传状态，不出现在公开 Job DTO。

## S07. 下载与重型处理接口

ArtifactStore 在宿主已绑定 userId/profileId，artifactId 由 SDK 生成。create/resume 的 writer.write 有背压；finish 校验字节数与增量SHA-256，不全量 buffer 视频。临时文件完成不等于导出成功，只有 manifest 在 StateStore commit 后 SDK/CLI 才显示该产物可用。

Node 输出临时唯一 .part，完成后同文件系统 atomic rename，并提交映射记录；崩溃未完成 partial 由任务恢复或本地有限清理回收。R2 适配属于延期阶段，不建立 cloud checkpoint 或传输端点。旧文件覆盖必须有同 source manifest；规范文件名为安全标题 + 稳定 key 前缀，不依靠标题唯一性。

HeavyRenderer 是本地重型能力的窄接口，保留未来复用能力，不是本期容器调度平台。start 同 taskId/attempt 幂等；status 分 running/succeeded/failed/missing；missing 只读渲染可新 attempt，最多两次，不能把 legacy 页面潜在副作用当纯计算重试。本地渲染输出经 scope/input/generation 校验后才成为已提交 Artifact；进程丢失返回 missing，不假装任务还在执行。

ModelClient 只提供一个 propose 方法；用所配置的兼容 API 与普通 fetch，不绑定某个厂商 SDK。返回 unknown 再由 Zod 校验；没有 key 仍能查询、下载、手工草稿和用户明确给定答案。平台 Cookie、访问密钥和整个账户日志不传给模型。

## S08. 关闭、错误与应用消费

close 释放该实例 socket/timer，不注销账户或删除后台任务。CLI 的 Ctrl+C 记录暂停、处理在途 uncertain、关闭本机连接后退出；本期不实现 Web 刷新/订阅控制。auth flow 被用户取消后销毁临时票据，迟到事件不得提交会话。

SDK 抛 ErrorData 包装的 Error；安全 message 不含原始 cause/body/URL query。批量 aggregateCourses 每 profile 独立成功或错误，保持调用顺序，不跨 profile 合并同名课程。可选模块没实现就返回相应 capability 状态与 UNSUPPORTED/MISSING_RUNTIME，不能 return [] 假成功。

需要新增方法时先看现有服务分组；一个 provider 的缺失 wire 资料记入 SOURCES/PROGRESS，不能通过给全部方法增加 any/Record<string,any> 来逃避建模。

## S09. 本期 Node 交付与延期隔离

`StateStore`、`ArtifactStore`、`Transport`、`Clock`、`HeavyRenderer` 和 `ModelClient` 的声明保持；只实现 Node 和离线测试版本。不要生成 cloudflare.ts 抛“稍后实现”来满足接口，更不要把站点用户/HTTP API 放进 SDK。

`Scope.userId='local'` 由 CLI 创建，profileId 是稳定本机 ID。不同 LEARNING_HOME 数据库独立，本期不自动迁移/同步到云端。`/public` 与平台/业务目录不得传递依赖 Node 专属实现，通过静态依赖检查保持未来可移植边界；不据此声称已经过 Cloudflare 验证。

20 秒工作片、wake 与 nextRunAt 由前台 Node scheduler 驱动。wake 是有界唤醒信号：循环读取已保存到期任务后等待最早时间或新信号，不启动本地服务，不递归调用重入 advance。退出后需要用户明确 resume。
