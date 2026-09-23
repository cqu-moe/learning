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
