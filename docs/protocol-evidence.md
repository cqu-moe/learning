# learning — 协议证据记录

版本 1.1；T00 建立，2026-09-23。本文件只记录从固定 ref 实际读取到的源码证据与缺口，不记录臆测。每条证据给出 repo/ref/path 与已读范围。运行级验证（fixture/本机/真机）在对应任务完成时追加，此处不预填。

## E00 · 固定源码状态

三个私有仓库均从本机已有 checkout 克隆到 `.reference/`（gitignored、`--detach` 固定 commit、只读、禁止运行旧 CLI）：

| directory | ref（40位） | 首层来源 |
|---|---|---|
| .reference/ykt-cli | 48a92c24498980d01aa045cf734ba3095d5f5bd1 | cqu-moe/ykt-cli（本机 /Users/uu/Developer/cqu-moe/ykt-cli 同 ref） |
| .reference/xuetang-cli | 628a8fa8a4b90897f285a109aa591a8f6263846d | cqu-moe/xuetang-cli（本机同 ref） |
| .reference/zhs-cli | 56d02171cf73c45694d69f886c902d2ecedadaaa | cqu-moe/zhs-cli（本机同 ref） |

核对方式：`node scripts/check-source-lock.mjs`（T00）逐仓库比对 `git rev-parse HEAD` 与 source-lock.json。输出不含任何 token。

## T00 补读记录（只读源码）

### P-E01 · ykt 独立考试子系统网络链（部分补齐）

来源：.reference/ykt-cli/src/download/exam.py（本次完整读取 1–315 行，含此前未完全展开的网络方法后段）。

- 预筛：`GET {BASE_URL}/v/exam/cover?exam_id=&classroom_id=`，用 ykt_post_headers；无 SSO、不加锁；返回 `data.show_perm`/`data.result.status`。
- SSO 第一跳：`POST {BASE_URL}/v/exam/gen_token`，body `{"exam_id": "<str>", "classroom_id": "<str>"}`；success=false 抛错；`data = {token, exam_host, user_id}`。
- SSO 第二跳：`GET {exam_host}/login?exam_id=&user_id=&crypt=<token>&next={exam_host}/result/{exam_id}?isFrom=2&language=zh`，跟随重定向链，把 examination 子系统 cookie 种进共享 jar。
- 取卷/取结果：`GET {exam_host}/exam_room/show_paper?exam_id=` 与 `GET {exam_host}/exam_room/problem_results?exam_id=`；两者必须带 headers `{"xtbz": "cloud", "x-client": "web"}`（xtbz=cloud，区别于作业的 mooc-api=ykt）；envelope 按 `errcode`（0/None 才成功）。
- 题目与作答 join 键：`problem_id`；`show_paper.problems` 提供题面/选项/正确答案，`problem_results` 提供我的作答与每题得分。
- errcode 实测语义：10006 同一时间只允许打开一份试卷；10007 未到试卷查看时间（锁定）；10107 试卷尚未提交（进行中）。
- 会话约束：examination 登录态逐考试、不可复用（考试 A 的 crypt 查考试 B → 10006）；源实现全程持 asyncio.Lock 串行"开一份读完再放锁"。SDK 侧对应 T07/T17 的串行与 generation 约束。
- 剩余缺口：真实 fixtures（各 errcode 分支、SSO 重定向链具体 Set-Cookie 序列）仍需 E01 授权采样；本条只补齐"网络方法与 envelope 形状"。

### P-E02 · 学堂 run 的权威 schedule 回读（部分补齐）

来源：.reference/xuetang-cli/src/run/api.py（完整 35 行）、src/run/orchestrator.py（重点 85–145 行）。

- 端点：`GET {BASE_URL}/api/v1/lms/learn/course/schedule?cid=<classroom_id>&sign=<course_sign>`，xtx_headers()。
- envelope：`(payload.data ?? payload).leaf_schedules` 为 `{leaf_id(str): progress 0..1}`；`progress >= 1` 即服务端完成。
- 回读语义：视频上报结束后统计管道异步，源实现轮询最多 15 次 × 6s（≈90s）等待 schedule 攀升到 1.0；超时抛"进度仍未确认"。SPEC/SDK 的 180s 核对预算覆盖该行为，T20 实现时沿用"先 waiting、确认才完成"。
- 续播语义：run 前先取 schedule，已完成 leaf 跳过；未完成 leaf 以已获 progress 作为 start_at 续播。
- 剩余缺口：课程分页终止条件与更多课程的真实边界仍属 E02；本条只补齐 schedule 回读链。

### P-E03 · 旧草稿/答案 YAML 格式（补齐）

来源：.reference/xuetang-cli/src/homework/scaffold.py（完整）、src/cli/fill_answers.py（前 100 行）、.reference/ykt-cli/src/homework/answers.py（前 90 行）、src/homework/orchestrator.py（关键行）。

- scaffold YAML 字段：`exercise_id`、`leaf_id`、`leaf_name`、`classroom_id`（xtx 另有 `course_sign`、`sku_id`），随后 `answers: {problem_id: value}`；题面/选项以注释形式随行。
- 值约定：单选 scalar（`A`）；多选 list（`[A, B]`）；判断 token `正确/对/t/true` vs `错误/错/f/false`；填空 list 或 scalar；主观一段文字；`~`/null 跳过。
- ykt ProblemType 编码（get_exercise_list content.ProblemType，稀疏不连续）：1=单选、2=多选、6=判断（经实测确认，非 3）、4=填空；未知编码抛 UnknownProblemType 记录待补，不静默丢弃。
- apply 定位键：ykt 以 `(exercise_id, problem_id)` 二元组从 scaffold 目录回查；题间随机停顿防风控。
- 回填匹配：fill-answers 用官方答案 raw.json 建 索引，按题面/选项文字相似度（默认阈值 0.82）匹配；xtx 以 `exam_id:` 头区分考试 YAML，源 raw.json 以含 `show_paper`（考试）或 `problems`（作业）分堆。
- 对 T13 的含义：`importDraft(format: 'ykt' | 'xuetang')` 需兼容上述字段与值约定；未知题型/未匹配保持原值并报告，不选第一项。

## 缺口对照（沿用 SOURCES E01–E08，本任务不新增结论）

E01（ykt 考试 fixtures）、E02（学堂分页终止）、E03（ykt lesson 分页/字体字段）、E04（三平台身份字段）、E05（学堂交卷取证）、E06（智慧树回读时延）、E07（字体黄金样本）、E08（Node 24 本机实测）仍按 SOURCES.md 负责 任务 推进；云端取证部分整体延期。T00 只补齐上列 P-E01/P-E02/P-E03 的源码级证据，未做任何网络请求或平台操作。

### P-E04 · 2026-09-23 智慧树协议 fixture 校正（源码对照，非真机）

固定参考 `.reference/zhs-cli` 的 `src/client.py::zhidao_query/hike_query`、`src/share.py::load_course`、`src/hike.py::HikeApi`：共享课 studyservice 使用 `VIDEO_KEY`、`/gateway/t/v1/`、POST 表单 `secretStr` + `dateFormate`；home 列表才使用 `HOME_KEY` 的 GET。原 SDK 的 studyservice 路径/密钥及只校验请求地址的合成 fixture 均错，已更正并逐项校验 body、Origin、Referer。Hike 课程/资源树是 GET；树嵌套字段为 `childList`，视频 `dataType=3`，而非旧 fixture 的 `children`/`1`。对应合成 fixture 和解析器已同改。

此校正不证明智慧树登录后的身份 UUID、真实保存进度、验证码或账号风控可用；E04/E06 仍待授权的实际平台核验。

### P-E05 · 2026-09-23 已授权本机只读 userinfo 形态校正

使用用户授权的本机旧雨课堂会话，仅调用 `GET https://www.yuketang.cn/v2/api/web/userinfo`。真实响应 HTTP 200、`errcode:0`，但 `data` 是单项数组，元素含 `user_id`（number）、`name`（string）等字段；先前合成 fixture 的 `data:{id,name}` 单对象仍可作为兼容形态，不能把它当唯一真实形态。旧解析器因此抛 ZodError，被探测层误标 `NETWORK`；现以两形态严格解析，并要求可识别 `user_id` 才可升级导入会话。没有保存/提交响应原文、学号、姓名或 Cookie。此项只补 E04 的雨课堂身份字段形态；不证明课程写入或字体质量。

### P-E06 · 2026-09-23 已授权智慧树共享课列表字段校正

经在线 UUID 核验后，只读调用 `queryShareCourseInfo` 第一页。真实 `courseOpenDtos` 有 `secret`（string）、`courseId`（number）、`recruitId`（number）和 `courseName`，没有合成 fixture 唯一使用的 `recruitAndCourseId`。固定参考源码 `.reference/zhs-cli/src/main.py` 也优先取 `secret` 作为 RAC ID；SDK 现按此优先级解析，不拼造 courseId/recruitId。未提交 `secret` 值、课程原始载荷、UUID 或 Cookie。此项仅修复课程定位字段，真实学习保存/回读仍需另验。

同次授权的只读 `hikeservice.../getMyCourseList` 响应为 HTTP 200 且业务 `code:200`，`result.startInngcourseList` 为数组；旧合成 fixture 使用 `code:0`。两者均视为成功，但缺失课程数组或其他状态码仍拒绝。未保存课程原文或用户 UUID。

### P-E07 · 2026-09-23 已授权雨课堂 KG 目录零 ID

只读查看一门 KG 课程的 `student_learn_chapter`：章节目录节点出现 `id:0`，其 `leaf_list` 含多个真实叶子。旧 `RawNode` 共用 schema 要求所有节点 ID >0，导致整棵树 ZodError；现仅允许目录节点 ID 为 0，`toLeaf` 仍拒绝零 ID 资源，避免错误资源 key。没有保存章节原始名称、叶子 ID 或学生数据。本条是协议证据编号 P-E07，**不是** SOURCES 中字体黄金样本缺口 E07。

### 2026-10-12 · 智慧树微信确认响应的有限文本解析（离线回归）

截图中的 `WeChat confirmed without a safe code` 由 SDK 在读取 `wx_errcode=405` 后未匹配 `wx_code` 时主动抛出；不表示用户需要输入验证码。固定参考 `.reference/zhs-cli/src/client.py::wx_qr_poll` 与原 SDK 均仅接受单引号及 `[A-Za-z0-9]+`。合成 fixture 经 SDK `auth.begin` 实际重放：仅将 code 改为含 `-`、`_` 或双引号便能复现同一错误；赋值空白另触发 unexpected status。已改为有限赋值语法，兼容单双引号、赋值空白与 `[A-Za-z0-9_-]+`，仍拒绝空值、不配对引号、非法字符及字符串拼接表达式；不执行响应脚本，不将 code 放入公开事件。缺少用户当次微信轮询响应，不能断言具体是哪一种格式，也未做真实扫码、Cookie 交换或登录验收。

### 2026-10-12 · 已授权微信扫码诊断：JPEG 与 wxTransit 登录链

用户明确授权生成一次真实二维码并自行扫码，只记录图片格式、HTTP 状态和 Cookie 名称/域/路径，不记录值。隔离 CookieJar 的诊断复现了第二张截图的 `AUTH_REQUIRED WeChat exchange did not set CASLOGC`：

- 微信二维码响应 HTTP 200，Content-Type `image/jpeg`，47,045 bytes，JPEG 魔数 `FF D8 FF`。旧实现将它标为 PNG，PNG-only 终端渲染失败后回退为文件。这是当次“仍给文件”的实际原因。
- 用户确认后，OAuth `wxLogin` 返回 302；user.zhihuishu.com 的 Set-Cookie 仅见 `acw_tc`、`INGRESSCOOKIE`、`JSESSIONID`、`SERVERID`。其中 JSESSIONID 为 `/zhsuser`，其余为 `/`，均 hostOnly。重定向到 `https://login.zhihuishu.com/wxTransit/0`，query 只有名称 `cacheId/isLock/service` 被记录；页面返回 200 text/html，未设置 CASLOGC。
- 在 user/login/passport/onlineservice 四个源查 Cookie 名称，均未见 CASLOGC，因此不是仅仅从错误域读 Cookie。诊断失败后停止，没有写入用户 profiles/session，也没有进行课程操作。

匿名只读下载当前官网公开 HTML 和脚本，静态分析调用链（不执行第三方脚本）：

| 官方脚本 | SHA256 |
|---|---|
| `https://login.zhihuishu.com/assets/index-CiBUKrg9.js` | `13ab2f2d1afc0ff711457d86cc281ecbd40ad1a397fa46ec41702649096f1a32` |
| `https://login.zhihuishu.com/assets/wx-BHV9bcKG.js` | `e3221fe3a90c7325622e80bd260496d15fd3965ac4532fbcdc55ea5bf3afefeb` |
| `https://login.zhihuishu.com/js/pre-login.js` | `fe626d915bf78c0220387ed2c3ec790de99f464e4232a0638157a6b17ecc8359` |

`/wxTransit/:scene` 的 LOGIN(0) 读取 cacheId/isLock。wx 模块 `f` 调用主模块 `xx`（GET `/zhsuser/user/cache/{cacheId}`），只接受 status 200 + rt；`U` 在 mobile 非空或 `WR`（GET `/zhsuser/login/isNewUser/{cacheId}`，status 200 + boolean rt）返回 false 时继续。certifyList 为空转人工认证；同账号跨学校先 agencyChoose，SDK 保留人工闸门，不自动选第一个。正常单学校走 `vx`（POST `/zhsuser/login/code/skipSet/{cacheId}`，null body），status 1 时取得 rt.pwd，再由 UserStore `goOnceLogin → LoginDirectly` 跳转 `//passport.zhihuishu.com/login?pwd=...&service=...`。

主模块的 `He/OA` 分别为 axios post/get；实例 `Xg` 使用 `Content-Type: application/json;charset=UTF-8` 与 withCredentials。skipSet 的 null body 不触发数据加密分支。SDK 沿用既定 onlineservice canonical service，通过完整 CookieJar 保留 user 域 `/zhsuser` 会话、passport/domain Cookie 和服务端重定向；没有迁移官网的埋点或其他产品跳转。

REA 静态分析完成但首个结果超工具传输上限，改读 retained-evidence 摘要确认 2 个 JS 均已解析、无语法失败；语义覆盖为 PARTIAL（节点上限），故具体网络方法/路径/状态分支又通过本地 TypeScript AST 和精确源码片段复核。该证据是当前官方公开源码，不是修复后整条认证的真机成功记录。修复后的后半链需要下一次人工扫码验收；不把严格合成 fixture 的通过当成真实 CASLOGC 已获取。
