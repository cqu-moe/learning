# learning — 来源与证据边界

版本1.1，文档整理日期2026-09-23。本轮仅依据最终版1.0交接包调整为 SDK + CLI 本期范围；未重新 clone 三仓库、访问 registry、核对网页或复测平台。下列源码阅读范围是之前讨论的已读记录。源码注释、测试通过数、旧探测日志都不能写成本轮执行证据。

## 固定基线

| 仓库 | ref |
|---|---|
| cqu-moe/ykt-cli | 48a92c24498980d01aa045cf734ba3095d5f5bd1 |
| cqu-moe/xuetang-cli | 628a8fa8a4b90897f285a109aa591a8f6263846d |
| cqu-moe/zhs-cli | 56d02171cf73c45694d69f886c902d2ecedadaaa |

原仓库只能通过用户授权读取；不能找公开同名仓库替代。不把参考 checkout、真实凭据、字体文件或敏感样本提交到新 repo。当前运行源码 > 同 ref 测试 > 协议记录 > 历史设计；但已知源码 bug 不要求复现。

## 2026-10-09 · Chaoxing 追加来源

用户当日在原始三平台范围外明确追加“超星学习通，只接刷课”。补充来源是公开仓库 `Samueli924/chaoxing` 固定 commit `45d2106b16764231c2de2038fb042e71b23d878f`；只读对照，不运行该项目：

| 编号 | 固定源码 | 已读范围 | 支持的设计判断 |
|---|---|---|---|
| C01 | [api/base.py](https://github.com/Samueli924/chaoxing/blob/45d2106b16764231c2de2038fb042e71b23d878f/api/base.py) | 课程大纲、卡片与学习上报关键段 | `studentcourse`、`knowledge/cards`、`ananas/status`、多媒体 log 的参数和时序 |
| C02 | [api/decode.py](https://github.com/Samueli924/chaoxing/blob/45d2106b16764231c2de2038fb042e71b23d878f/api/decode.py) | HTML/JSON 提取段 | `mArg` 平衡 JSON、视频 attachment 字段 |
| C03 | [api/config.py](https://github.com/Samueli924/chaoxing/blob/45d2106b16764231c2de2038fb042e71b23d878f/api/config.py) | 常量段 | MD5 盐、`rt=0.9`、上报字段 |

同日对用户提供的课程页做只读浏览器验证：真实 `studentcourse` HTML 含 9 个 `.chapter_unit`、48 个知识点；单元题为 `.catalog_title .clicktitle`，知识点为 `.chapter_unit li div[id^="cur"]`，点题为 `a.clicktitle`，任务数为 `input.knowledgeJobCount`。`knowledge/cards` 的当前 query 需 `v=2025-0424-1038-3&mooc2=1`。真实浏览器验证 `ananas/status` 需视频模块 Referer；同 URL 无 Referer 直达为 403。未导出、保存或提交 Cookie。

用户随后明确基础登录也在范围内。补充只读固定源码 `DanMo661/Xuexitong-mcp@ebce2cc735bc7acc45fac7ccf32bcefe1a6b2a54`：

| 编号 | 固定源码 | 已读范围 | 支持的设计判断 |
|---|---|---|---|
| C04 | [xuexitong_mcp/client.py](https://github.com/DanMo661/Xuexitong-mcp/blob/ebce2cc735bc7acc45fac7ccf32bcefe1a6b2a54/xuexitong_mcp/client.py) | 常量、AES、`ChaoxingClient.login`、base 探测 | `fanyalogin` 的 URL、九个表单字段、AES key/iv/PKCS7/base64、浏览器 UA、`status=true` 与 `i.chaoxing.com/base` 核验 |
| C05 | [README.md](https://github.com/DanMo661/Xuexitong-mcp/blob/ebce2cc735bc7acc45fac7ccf32bcefe1a6b2a54/README.md) | 登录逆向说明与 2026-09 真实账号声明 | 交叉确认登录算法；该仓库的“曾实测”不代表本仓库已完成验收 |

该源码把密码错误与验证码合并为失败提示，没有提供权威状态码区分。本实现仅在 `msg2` 明确包含验证码/风险/安全验证时输出人工处理类错误；其余失败统一按拒绝凭据处理，不猜协议状态码。

该公开仓库是本次用户追加能力的补充对照，不改变 `docs/source-lock.json` 中三个私有基线仓库的完整性检查；Chaoxing 的工程证据以本仓库 fixture 测试和后续用户授权的本机验收为准。

## S03. 源码索引

| 编号 | 固定源码 | 已读范围 | 支持的设计判断 |
|---|---|---|---|
| Y00 | [cqu-moe/ykt-cli / AGENTS.md](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/AGENTS.md) | 分发/设计说明；结合最后commit读取 | 私有源码分发、九月API改版、历史说明可能过时 |
| Y01 | [cqu-moe/ykt-cli / src/main.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/main.py) | 完整命令入口 | 实际注册的run/slide/live/download/homework/fill-answers |
| Y02 | [cqu-moe/ykt-cli / src/core/auth.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/core/auth.py) | 关键登录/票据/验证/浏览器交接段 | HTTP二维码、form交换、probe、flat Cookie与UI耦合 |
| Y03 | [cqu-moe/ykt-cli / src/core/api.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/core/api.py) | 共享HTTP模型/headers；前一轮讨论读取 | YktSession、课程列表、universityId/CSRF来源 |
| Y04 | [cqu-moe/ykt-cli / src/download/api.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/download/api.py) | 主要接口与归一化段 | 章节/小节/leaf、media、subtitle、exercise、font触发 |
| Y05 | [cqu-moe/ykt-cli / src/core/fontdecode.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/core/fontdecode.py) | 主要实现 | Pillow/fontTools、参照字形、marker与partial语义 |
| Y06 | [cqu-moe/ykt-cli / src/slide/api.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/slide/api.py) | 完整主要API | 历史timeline、live checkin/WS、课件顺序 |
| Y07 | [cqu-moe/ykt-cli / src/cli/slide.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/cli/slide.py) | 入口与交互前半段 | 浏览器包装与HTTP能力的分离 |
| Y08 | [cqu-moe/ykt-cli / src/core/kg.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/core/kg.py) | 多段：检测/树/进度/心跳/内嵌题reply；非逐行完整审计 | cid语义、headers、GET写、题单数组、未验证font位置 |
| Y09 | [cqu-moe/ykt-cli / src/homework/api.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/homework/api.py) | 完整模块 | 雨课堂作业提交body与429处理 |
| Y10 | [cqu-moe/ykt-cli / src/live/client.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/live/client.py) | 完整模块 | checkin、lessonToken、set-auth JWT刷新、live answer |
| Y11 | [cqu-moe/ykt-cli / src/download/exam.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/download/exam.py) | 模块前段/渲染/SSO说明；网络方法后段未完全展开 | 独立examination子系统、cloud headers、题目/结果join、数学 |
| Y12 | [cqu-moe/ykt-cli / src/run/ai_course.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/run/ai_course.py) | 前220行与CLI调用背景 | KG/standard映射、内嵌题状态、非当前调用路径的旧注释 |
| X01 | [cqu-moe/xuetang-cli / CLAUDE.md](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/CLAUDE.md) | 项目说明主要段 | 功能清单、fork差异、SUBMIT_LIVE文档冲突 |
| X02 | [cqu-moe/xuetang-cli / src/core/ws_login.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/core/ws_login.py) | 完整模块 | WS requestlogin/QR/token交换/到期重连 |
| X03 | [cqu-moe/xuetang-cli / src/core/api.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/core/api.py) | 完整主要内容 | 主站headers、XtxSession、第一页课程 |
| X04 | [cqu-moe/xuetang-cli / src/download/api.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/download/api.py) | 主要接口/树归一化 | sku路径、KG树、playurl、lecture note |
| X05 | [cqu-moe/xuetang-cli / src/run/progress.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/run/progress.py) | 完整主要内容 | heart_data、lob=xt、ratechange、speed上限、实时时序 |
| X06 | [cqu-moe/xuetang-cli / src/download/exam.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/download/exam.py) | 分段覆盖读/SSO/锁的关键实现 | 双层data、exam_host、x_access_token、account级冲突 |
| X07 | [cqu-moe/xuetang-cli / src/exam/api.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/exam/api.py) | 完整主要内容；同时读取cli/submit_exam.py前165行 | start/save/finalize的body及源代码SUBMIT_LIVE=True |
| X08 | [cqu-moe/xuetang-cli / src/exam/answers.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/exam/answers.py) | 完整模块 | 考试支持题型及填空/主观未证实拒绝 |
| X09 | [cqu-moe/xuetang-cli / src/homework/api.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/homework/api.py) | 完整主要内容 | answer/answers、主观对象、429/Retry-After |
| X10 | [cqu-moe/xuetang-cli / src/discuss/api.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/discuss/api.py) | 完整模块 | 顶层thread envelope、分页comments、post body |
| X11 | [cqu-moe/xuetang-cli / src/core/session.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/core/session.py) | 完整模块 | check_is_l探针、flatCookie、网络失败误判登出 |
| Z01 | [cqu-moe/zhs-cli / README.md](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/README.md) | 完整说明 | 纯API、两个课程体系、现有命令和非功能范围 |
| Z02 | [cqu-moe/zhs-cli / src/client.py](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/src/client.py) | 两个分段覆盖主要实现 | 多种认证、OAuth重定向、Cookie、home/study/hike编码 |
| Z03 | [cqu-moe/zhs-cli / src/crypto.py](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/src/crypto.py) | 完整模块 | AES/IV/key、ev、watchPoint、MD5连接顺序 |
| Z04 | [cqu-moe/zhs-cli / src/share.py](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/src/share.py) | 1–265行 | 课程/视频结构、多种ID、进度/题目/保存接口 |
| Z05 | [cqu-moe/zhs-cli / src/share.py](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/src/share.py) | 266行后主要内容 | runner时序、无答案第一项fallback、完成确认不足 |
| Z06 | [cqu-moe/zhs-cli / src/hike.py](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/src/hike.py) | 完整模块 | 资源树、GET view/save、签名、server rt与停滞 |
| Z07 | [cqu-moe/zhs-cli / tests/test_crypto.py](https://github.com/cqu-moe/zhs-cli/blob/56d02171cf73c45694d69f886c902d2ecedadaaa/tests/test_crypto.py) | 完整测试文件；只读未运行 | AES/ev/watchPoint回归向量 |

### 额外直接对照文件

- [src/cli/submit_exam.py](https://github.com/cqu-moe/xuetang-cli/blob/628a8fa8a4b90897f285a109aa591a8f6263846d/src/cli/submit_exam.py)：当前SUBMIT_LIVE=True与CLI门控行为；配合X01/X07说明文档冲突。
- [src/cli/run.py](https://github.com/cqu-moe/ykt-cli/blob/48a92c24498980d01aa045cf734ba3095d5f5bd1/src/cli/run.py)：当前run走API主路径，旧浏览器选项已废弃；不是因为browser.py还存在就判定所有功能依赖浏览器。

### 后续实现必须补齐的协议资料，不视作已验证结论

ykt历史考试网络方法的完整fixtures、学堂run权威schedule读取链/课程分页终止、雨课堂超500条lesson分页、各平台在线身份字段以及旧YAML/反馈导入样例，需要实施时从上述固定仓库继续定位或经用户授权采样。现有spec已规定输入/输出语义、隔离和失败方式；这些证据缺口不得由实现模型猜接口补齐。

## 沿用的官方参考资料（本轮未重新核对）

这些链接沿用1.0，只供实现时按需要核对；本轮没有重新浏览。W-PNPM/W-NODE与当前本地工作相关，其余 Cloudflare/Hono 条目仅作延期阶段历史参考，不是本期依赖、测试或验收要求。应用架构/限制默认值是本项目决定，不是官网要求必须这么设计。

| 编号 | 官方资料 | 既有资料记录（非本轮新验证） |
|---|---|---|
| W-PNPM | https://pnpm.io/workspaces | 单仓库 workspace 与 workspace:* 本地依赖 |
| W-NODE | https://nodejs.org/en/about/previous-releases | Node 24 LTS；不用 Current 线作默认生产环境 |
| W-TEST | https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ | @cloudflare/vitest-plugin 与 Vitest4.1+；不是旧 pool 包模板 |
| W-STATIC | https://developers.cloudflare.com/workers/static-assets/ | 前端静态文件与 Worker 同一部署 |
| W-COOKIE | https://hono.dev/docs/helpers/cookie | getSignedCookie/setSignedCookie helper |
| W-CONTAINER | https://developers.cloudflare.com/containers/get-started/ | Container 类、Wrangler 绑定与镜像部署 |
| W-CONTAINER-API | https://developers.cloudflare.com/containers/reference/container-class/ | 生命周期、sleepAfter、请求转发与接口 |
| W-LIFECYCLE | https://developers.cloudflare.com/containers/concepts/architecture/ | 临时磁盘，不用于唯一持久状态 |
| W-SIZE | https://developers.cloudflare.com/containers/platform/limits/ | standard-1=0.5vCPU/4GiB/8GB；是初始选择不是性能保证 |
| W-ALARM | https://developers.cloudflare.com/durable-objects/api/alarms/ | alarm最多一个、at-least-once，需按最早任务重新安排 |
| W-WS | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ | 出站WS不Hibernation，需处理断连/驱逐 |

## 必须继续取证的细项

| 编号 | 缺口 | 负责任务 | 没有证据时怎样办 |
|---|---|---|---|
| E01 | ykt历史考试网络方法和fixture完整链 | T00/T07 | 该能力unverified；不照抄学堂的URL |
| E02 | 学堂真实课程分页终止和权威schedule回读 | T00/T08/T20 | 分页unknown；不能确认的完成状态明确展示 |
| E03 | ykt超500条lesson分页、内嵌题font字段 | T00/T07/T24 | 列表unknown；字体unavailable，不猜 |
| E04 | 三平台在线身份核实字段 | T06/T08/T10 | identityVerified=false，不继承旧会话任务 |
| E05 | 学堂最终交卷及填空/主观写入分别取证 | T17 | 未验证题型无网络写；不以保存答案代替交卷证据 |
| E06 | 智慧树share完成后的权威回读时延 | T21 | ACK与完成分开，超预算needs-input |
| E07 | 字体黄金样本与渲染结果 | T24 | 明确拒识，不用错误匹配凑覆盖 |
| E08 | Node 24 传输/存储/恢复、CLI 构建后安装、本机渲染资源实测 | T03/T05/T23/T24/T31 | 未跑层级列 not-run，不以 fake 适配器通过代替本机集成 |

原 E08 的 workerd/Cloudflare 出口与 Containers 部分已整体延期，见 deferred/WEB.md；不得作为本期完成的阻塞条件，也不得描述成已经验证。

以上是实际证据采集任务，不是让实现者自由选择协议。可独立的其他任务继续；产品状态清楚区分source-only、fixture-tested、live-tested。确认缺口被补齐时，追加日期/方法/脱敏样本，不篡改本次未实测的说明。
