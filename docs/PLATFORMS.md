# learning — 三平台协议与功能范围

版本 1.1。本文件的源码判断继承先前已读的三个固定版本；本轮依据附件复核，没有重新调用平台或重新读取远端 HEAD。源码“曾实测”的注释不等于本次验证。来源编号在 SOURCES.md。任何通用架构用词以新的 SPEC/SDK 为准，不能恢复旧 PolicyPort、ApprovalRef 或7包架构。

## P01. 迁移范围

| 功能 | 雨课堂 | 学堂在线 | 智慧树 share/hike |
|---|---|---|---|
| QR/导入/多账号/课程树 | 全部迁移，standard/KG 分解析器 | 全部迁移，WS登录 | 全部迁移，两课程系统分协议 |
| 服务器进度/已有学习任务 | 迁移 | 迁移 | 两系统均迁移 |
| 视频下载/字幕或讲稿 | 迁移 | 迁移 | 现有流探测不当完整下载，暂不承诺 |
| 课件/PDF/实时课件 | 迁移；历史API优先 | 没有对应完整来源 | 没有对应完整来源 |
| 作业草稿/回填/提交 | 迁移 | 迁移 | 无现有完整功能，不编造 |
| 考试结果读取 | 迁移独立SSO读取链 | 迁移 | 不因源码有EXAM常量就实现 |
| 考试开始/保存/交卷 | 无完整旧写入口 | 迁移分步操作；未知题型拒绝，最终交卷独立验证 | 无 |
| 讨论草稿/发布 | 无 | 迁移 | 无 |
| 实时课堂/答题 | 迁移 | 无 | 无 |
| 字体解码 | 迁移算法与显式解码状态 | 只按观测支持，不由fork推断 | 无 |

“迁移”表示最终目标，不表示初始版本可留空却宣称支持。本期按先只读、后写操作/实时、再本机渲染与完整 CLI 的顺序实施；这些目标均在当前 PLAN 内。Web 与云端适配延期，不改变本表平台能力范围。可选 AI 只是生成建议，不是成功查询课程的前提。

| 旧入口 | 最终 SDK 入口 |
|---|---|
| login / whoami / profile | auth + 宿主 profile 目录 |
| courses | catalog.courses / aggregateCourses |
| run | actions.prepare(study) → execute → jobs.advance |
| download | resources / assessments → jobs.createExport |
| slide | resources.slides → jobs.createExport |
| live | actions.prepare(live.join) → execute；jobs.events；actions(live.answer) |
| submit-homework | assessments.draft → actions(homework.apply) |
| submit-exam | actions(exam.start/save/finalize)，三个独立动作 |
| discuss | discussions.draft/propose → actions(discussion.post) |
| fill-answers | assessments.importFeedback + match，不直接提交 |

源文件中方法只是协议参考，新 SDK 方法名按 contracts.d.ts；不要求保留 Python 类名。

## P02. 雨课堂 provider

### 身份和调用上下文

base host 为 `www.yuketang.cn`。CourseRef 稳定字段是 classroomId。provider 的已解析上下文单独保存 `courseSign`、`skuId/freeSkuId`、`universityId`、必要的 `courseId` / `platformUserId`；这些字段来源不同，不能互相代替。

特别地，`/video-log/get_video_watch_progress/` 的 cid 是 **course_id**，而章节接口的 cid 是 **classroom_id**。universityId 从 classroom 接口的 uv_id 获取，不从 Cookie 推导。2026-09-29 真机验证：登录全流程与认证页面均不再下发 csrftoken，heartbeat 不带 x-csrftoken 被接受且服务端进度推进；嵌入式答题 POST 的 CSRF 要求未验证，守卫保留。[Y03、Y08]

### Endpoint 映射

下表中的路径是 wire 规范依据；具体 payload 的字段类型、大小写和可选值还须由相应源码 fixture 冻结。注册 operationId 用 `ykt.<本表动作>.v1`。

| 动作 | 方法 / 路径 | 输入与响应重点 | effect / 证据 |
|---|---|---|---|
| auth.qr.begin | GET `/api/v3/user/login/app-web-pre-info` | data.qrContent + token；票据 TTL 取已知 JWT 时间差但不把 decode 当签名验证 | session，Y02 |
| auth.qr.poll | POST `/api/v3/user/login/app-web-login` | `{token}`；服务端 hold；单次 5s read timeout 视为 waiting | session，Y02 |
| auth.exchange | POST `/pc/web_login` | form `{UserID, Auth}`；收 Set-Cookie | session，Y02 |
| auth.probe | GET `/v2/api/web/userinfo` | errcode=0；网络错误不是失效 | read，Y02 |
| catalog.list | GET `/v2/api/web/courses/list` | identity=2；data.list | read，Y03 |
| catalog.classroom | GET `/v2/api/web/classrooms/{classroomId}` | role=5；course_sign / free_sku_id / uv_id | read，Y04 |
| catalog.hasKg | GET `/c27/online_courseware/course/classroom/{classroomId}/has_kg/` | xtbz:ykt **且 university-id**；data.has / kg_id | read，Y08 |
| catalog.standard | GET `/mooc-api/v1/lms/learn/course/chapter` | cid=classroomId，sign；data.course_chapter 数组 | read，Y04 |
| catalog.kg | GET `/mooc-api/v1/lms/kg/student_learn_chapter/` | cid=classroomId，term=latest，uv_id，classroom_id；data.course_chapter 根节点 | read，Y08 |
| resource.leaf | GET `/mooc-api/v1/lms/learn/leaf_info/{cid}/{leafId}/` | **classroom_id query** + xtbz:ykt | read，Y04 |
| resource.playurl | GET `/api/open/audiovideo/playurl` | video_id=ccid，provider=cc，file_type=1，is_single=0，domain=www.yuketang.cn | read，Y04 |
| resource.subtitle | GET `/api/open/yunpan/video/subtitle/list` | cc_id；bare strings/list objects/map 三种 data | read，Y04 |
| homework.read | GET `/mooc-api/v1/lms/exercise/get_exercise_list/{exerciseId}/` | classroom_id query；data.problems；font URL 若有须验证 host | read，Y04 |
| homework.submit | POST `/mooc-api/v1/lms/exercise/problem_apply/` | `{classroom_id, problem_id, answer}`；不是学堂的扩展 body | write，Y09 |
| progress.read | GET `/video-log/get_video_watch_progress/` | cid=courseId，user_id，classroom_id，video_id；字段详见下段 | read，Y08 |
| study.heartbeat | POST `/video-log/heartbeat/` | `{"heart_data":[...]}`；lob=ykt；专属 heartbeat headers | write，Y08 |
| study.article | GET `/mooc-api/v1/lms/learn/user_article_finish/{leafId}/` | cid=classroomId，sid=skuId；回读 leaf_info.finish | write，Y08 |
| embedded.read | GET `/mooc-api/v1/lms/exercise/leaf_video/problem/{skuId}/{leafId}/{exerciseId}/` | classroom_id query；data **直接数组**，不是 problems 信封 | read，Y08 |
| embedded.answer | POST `/mooc-api/v1/lms/exercise/leaf_video/problem/reply/{problemId}/` | `{exercise_id,sku_id,leaf_id,answer}`；使用 heartbeat headers；答错 success=true 但无标准 answer | write，Y08 |
| lessons.list | GET `/v2/api/web/logs/learn/{cid}` | actype=14，旧代码 page=0/offset=500/sort=-1；超限完整性 gated | read，Y06 |
| slides.review | GET `/api/v3/classroom-report/student/review` | lesson_id；timelineList.presentationId，按首次出现去重 | read，Y06 |
| slides.title | GET `/api/v3/lesson-summary/student/presentation` | lesson_id + presentation_id | read，Y06 |
| slides.pages | GET `/api/v3/classroom-report/student/ppt` | lesson_id + **presentationId**；slideList 按 index 排序 | read，Y06 |
| live.checkin | POST `/api/v3/lesson/checkin` | `{source:1, lessonId}`；lessonToken + 响应 set-auth JWT | write，Y06、Y10 |
| live.connect | WSS `/wsapp/` | hello 使用 lessonToken；live timeline 用 pres 不是 presentationId | session，Y06 |
| live.slides | GET `/api/v3/lesson/presentation/fetch` | presentation_id；Bearer JWT + xtbz:ykt | read，Y06 |
| live.info | GET `/api/v3/lesson/basic-info` | lesson_id；响应 set-auth 可刷新 JWT | read，Y10 |
| live.answer | POST `/api/v3/lesson/problem/answer` | `{problemId,problemType,dt,result}`；dt=epoch ms | write，Y10 |

本表的历史 exam 下载尚未逐行核对所有网络方法；已确认该模块存在、使用独立 examination SSO、cloud headers，并分开读取题目与结果。实现者须从固定仓库获取对应函数和测试生成证据清单；没有源码访问/fixture 时该 operation 状态保持 source-observed，不允许从相似 API 猜测。该取证任务将由后续 plan 明确拆分，不能将猜测写成 protocol-v1。

### Headers 不得统一误用

mooc 常规读接口必须带 xtbz:ykt；hasKg 必须额外带 university-id，不能仅有 query uv_id。homework POST 身份头来自 YktSession，包括 classroom-id、university-id、uv-id、Xt-Agent、X-CSRFToken。heartbeat 的专属组为 classroom-id 与 x-requested-with（x-csrftoken 已于 2026-09-29 真机移除），不能由全部业务头模板简单复制。[Y03、Y08、Y09]

### 树结构和 key

standard 的 section_leaf_list 是异构：直接单元与 leaf_list 小节混排。KG 每个节点可以同时有 leaf_list 和 children；根上直接挂的期末考试不得丢弃。空 folder 不应变成 id=0 的资源，缺必需 leafId 直接拒绝该项并报告 protocol error。

原始 chapter_id、所在树 node ID、可读 section_path 分字段保留。目录路径保留全部中间层；新增稳定 key 后缀，修复相同章内同名/同 order 文件并发覆盖问题。[Y04、Y08]

### 心跳与权威进度

源代码 build_heartbeats 是纯函数，时间/随机页标识由调用者给定；新 TS 继续保持。i=5、ts 为字符串、lob=ykt、cp 不超过 duration；pg 和 sq 在一个运行会话内稳定/递增。禁止把学堂所需 ratechange 等事件未经证据复制进雨课堂。

progress.read 查询 cid=courseId，snapshot=1（数字）、no_loading="true"（字符串）；可能 data[videoId] 或顶层[videoId]。未观看视频没有行（data 为空对象），duration 优先取 video_length，回落 leaf_info content_info.media.duration（已观看视频两者相等）；playurl 不含 duration。仍未知不能发 fabricated 进度。[Y08]

视频完成、图文 finish、内嵌题 solved/continued-with-wrong/stuck/unknown 分开统计。新默认 questionMode=pause，不迁移穷举猜答案或自动第一项；显式已批准答案可通过平台允许次数执行。需要由反馈重试的模式须单独计次和批准，不能让泛用 retry 中间件处理业务答案。

### 字体和课件

作业 `data.font` 与加密 span marker 已有实现；内嵌题 font 位于 payload 顶层在源码注释中仍是**未证实假设**。新解析器必须给 decodeState，不把找不到字体地址当明文。[Y05、Y08]

历史课件 API 路可以脱离旧 CLI 浏览器登录包装；特殊页面 fallback 保持独立。实时 slides 获取会 checkin，因此 live.join 必须先获批准，resources.slides 不自动开始签到。[Y06、Y07]

## P03. 学堂在线 provider

### 不与雨课堂共用协议客户端

base host `www.xuetangx.com`。课程 locator 含 classroomId、courseSign、skuId；题目使用 Type 字符串分类，不复制雨课堂的题型数字表。主站 xtbz=xt / app-name=xtzx，考试子系统 xtbz=cloud。[X03、X04、X06]

### Endpoint 映射

operationId 用 `xuetang.<动作>.v1`。

| 动作 | 方法 / 路径 | 核心结构 | effect / 证据 |
|---|---|---|---|
| auth.seed | GET `/` | 建立 CSRF Cookie | session，X02 |
| auth.qr | WSS `/wsapp/` | requestlogin → ticket/expire_seconds → loginsuccess | session，X02 |
| auth.exchange | POST `/api/v1/u/login/wx/` | `{s_s: token}`，根据 is_new 分支取字段；不是省略 api/v1 的路径 | session，X02 |
| auth.probe | GET `/api/v1/u/login/check_is_l/` | success + data.is_login；仅布尔值不证明platformUserId，网络故障不算登出 | read，X11 |
| catalog.list | GET `/api/v1/lms/user/user-courses/` | status=1，page；data.product_list；旧实现只取 page=1 | read，X03 |
| catalog.outline | GET `/api/v1/lms/kg/kg_learn_chapter/` | cid=classroomId，sign；course_chapter 根节点 | read，X04 |
| resource.leaf | GET `/api/v1/lms/learn/leaf_info/{cid}/{leafId}/` | sign query | read，X04 |
| resource.media | GET `/api/v1/lms/service/playurl/{ccid}/` | appid=10000；sources.quality20/quality10，duration | read，X04 |
| resource.transcript | GET `/c27/online_courseware/leaf_lecture_note/{leafId}/` | classroom_id；formalParagraphText，startTime/endTime 毫秒 | read，X04 |
| homework.read | GET `/api/v1/lms/exercise/get_exercise_list/{exerciseId}/{skuId}/` | **两个路径段**；不是 ykt 的 classroom query | read，X04 |
| homework.submit | POST `/api/v1/lms/exercise/problem_apply/` | leaf_id、classroom_id、exercise_id、problem_id、sign、answers、answer | write，X09 |
| study.heartbeat | POST `/video-log/heartbeat/` | heart_data 批次；lob=xt；生命周期事件与 speed 规则 | write，X05 |
| exam.cover | GET `/api/v1/lms/exam/cover` | exam_id；**data.data** 双层 | read，X06 |
| exam.token | POST `/api/v1/lms/exam/gen_token` | exam_id 为字符串、classroom_id、is_teacher=0；data.data.crypt/token、exam_host | session，X06 |
| exam.login | GET `{approvedExamHost}/login` | exam_id/user_id/crypt/next/language；跨域种 x_access_token | session，X06 |
| exam.readPaper | GET `{host}/exam_room/show_paper` | exam_id；顶层 errcode，data.problems | read（已授权子会话），X06 |
| exam.readResult | GET `{host}/exam_room/problem_results` | 按 problem_id 与 paper join，不按数组位置 | read（已授权子会话），X06 |
| exam.start | POST `{host}/exam_room/start_paper` | `{exam_id}`；可能开始计时 | irreversible，X07 |
| exam.save | POST `{host}/exam_room/answer_problem` | `{results, exam_id, record:[]}`；record 形态独立 fixture | write，X07 |
| exam.finalize | POST `{host}/exam_room/submit_paper` | `{results, exam_id}`；整卷终态 | irreversible，X07 |
| discussion.thread | GET `/api/v1/lms/forum/unit/discussion/` | product_sign/leaf_id/classroom_id/topic_type=0/channel=xt；响应线程在**顶层** | read，X10 |
| discussion.comments | GET `/api/v1/lms/forum/comment/list/{topicId}/` | offset/limit/cid/lid；data | read，X10 |
| discussion.post | POST `/api/v1/lms/forum/comment/` | query classroom_id/leaf_id；body topic_id,to_user,content{text,upload_images:[]} | write，X10 |

上游返回 exam_host 必须与允许的 examination host 精确匹配；默认 `https://examination.xuetangx.com`。未知域报告错误，不能因它来自“可信接口”就跳过 SSRF 检查。

### WS QR 状态与头

request frame 固定字段为 op=requestlogin、role=web、version="1.4"、purpose=login、xtbz=xt、x-client=web。二维码响应可能含图片 URL，嵌入 follow URL 的解码是可选显示优化；不能失败后生成不正确二维码。图片 fallback 由受控服务器获取。[X02]

收到 loginsuccess 后 code 只交换一次；先从新/旧分支取 s_s/token，使用主站 headers + 当前 CSRF。每次 QR 过期刷新 generation 和连接，10 分钟总预算独立于单 QR 常见 60 秒寿命。旧连接迟到成功不得覆盖新一轮。

### 大纲、进度、分页

树 node.id 与 leaf.chapter_id 是不同 ID 空间；新模型保留两者，展示归属用包含它的 nodeKey。root 自身的资源不能因 root 被视为外壳而丢弃。[X04]

主站课程返回第一页不代表全集。实现者必须读取真实返回的总页/总数/hasNext 或以已验证“空页终止”策略分页；没有证据时 completeness=unknown 并保留继续读取接口，不编造 total 字段。

视频 source duration 为 0 时，按已有路径使用 playurl duration 补全；仍未知即拒绝运行。源 heartbeat codec 与 ykt 不同：lob=xt，必须 heart_data 批次；ratechange 激活非 1x；源码记录 speed 在 1..5 范围。TS 入参超范围直接错误，不悄悄降速后仍在 UI 显示原值。[X05]

确认进度的具体 schedule read 接口由本库 run 调用链固定，不能替换成雨课堂 get_video_watch_progress。提交后统计可能延迟，执行器转 waiting 再核对，不能把 flush callback 的本地进度当完成。

### 作业与考试：不同模型映射

| 标准 Answer | 作业 wire | 考试 wire |
|---|---|---|
| single-choice / multi-choice | answer 为选项 key 数组，answers={} | result 为 key 数组 |
| judgement | provider 的规范 true/false key 数组 | result 为 true/false key 数组 |
| fill-blank | answer=""，answers 为 1-based 空位字符串 map | **没有已确认写形态，拒绝** |
| short-answer | answer 是含 time/content/oSubject 的对象；answers={} | **没有已确认写形态，拒绝** |
| unset | 跳过，不请求 | 跳过，不请求 |

不能把 DTO 的 short-answer text 直接塞进一个泛用 answer 数组。time / oSubject 等原生字段应以 X09 和对应 answers.py fixture 为唯一映射依据；值不明确时暂停该题型，不让模型猜。[X08、X09]

考试 reads 与 writes 共享 profile 串行队列临界区，覆盖 gen_token → login → 操作 → 必要回读整个序列。旧 establish() 只在 SSO 内拿锁，离开后释放，这不足以保护多任务应用；新版不能照搬窄锁。[X06]

### 文档冲突与最终交卷闸门

CLAUDE.md 说 SUBMIT_LIVE 应保持 False，但当前 cli/submit_exam.py 是 True。代码注释明确记录的是 answer_problem 缓存写入验证；不能因此宣称最终交卷及所有题型均经过验证。[X01、X07、X08]

新 SDK 设计包括三种考试 mutation，不删除功能。默认不启用 exam.finalize；启用时需满足：operation/题型 fixture、经授权的独立验证记录、明确 starts-timer / final-submission 两种确认、正确试卷状态、账号级互斥和不确定结果核对。未知填空/主观形态即使开关启用仍拒绝。

## P04. 智慧树 provider

### 共用账号，分开 share/hike

client.py 目前把 profile、httpx、Cookie、加密、认证写在一个类里。新实现放在同一 SDK 内的登录、CookieJar、share、hike 和两套任务处理模块；保持账号 scope 一致，不把两个 courseId 命名成一个不明含义的 ID。[Z02]

### 登录流程

默认 OAuth 微信 QR：

1. 受控 GET `open.weixin.qq.com/connect/qrconnect`，参数沿源 `wx_qr_start`。
2. HTML 中提取 QR uuid，下载 `/connect/qrcode/{uuid}` 图片；禁止执行页面脚本。
3. 长轮询 `lp.open.weixin.qq.com/connect/l/qrconnect`；解析 wx_errcode / wx_code 的有限语法，禁止 eval。
4. 408 waiting、404 scanned、405 + code confirmed、403 canceled；其他状态按明确 expired/unknown 处理，不能一律成功。
5. 由固定的 `user.zhihuishu.com/zhsuser/oauth/weixin/wxLogin` 与 onlineservice 的 gologin 重定向链交换 Cookie。
6. CASLOGC 本地解析可提供 uuid，但必须在线验证访问与账号身份后才提交 SessionView。

平台原生 QR 与密码登录在源 client 有实现，作为次级 capability；默认 variant=default 使用微信流程。验证码/短信/额外认证返回 interaction-required；不能自动尝试密码或无限刷新。[Z02]

### 协议族与 wire 编码

| 协议族 | 主要访问 | 外层编码 | 状态 envelope |
|---|---|---|---|
| home | onlineservice-api `/gateway/...` | GET：secretStr(AES HOME JSON) + date 毫秒 | code=0/200，result |
| study/share | studyservice-api `/gateway/t/v1/...` | POST form 为主；secretStr(AES VIDEO JSON) + dateFormate；少数已知 GET | code=0/200，data |
| hike | hikeservice / studyresources / hike-teaching | GET 明文为主；按 endpoint 加 timestamp/MD5 | status=200，result 或 rt |

study 的 dateFormate 取 `floor(epochMs / 1000) * 1000`，存在内外两处；home 的 date 不使用该秒级截断。JSON 字段顺序、字符串/数字形态、是否插入时间戳都由对应 endpoint codec 决定，不能为了“统一风格”重排后声称密文应相同。[Z02、Z03]

AES 为 AES-128-CBC + PKCS#7 + Base64，固定 IV 与协议 key 来自固定源 `src/crypto.py`。这些是前端协议常量，不是用户账号密钥；不搬历史 AI/QA/EXAM 常量就自动启用那些子系统。新 DTO 的凭据加密不得复用这些常量。

### Share endpoint 与 native identity

operationId 用 `zhs.share.<动作>.v1`。

| 动作 | 已有路径 / 函数 | 必须保留 |
|---|---|---|
| list | home `/t/v1/student/course/share/queryShareCourseInfo` | status、pageNo、pageSize=5；result.courseOpenDtos + totalCount |
| establish | studyservice `/login/gologin` | fromurl 指向 studyvideoh5/stuStudy 的 recruitAndCourseId；session 副作用 |
| course | study `/learning/queryCourse` | recruitId，courseInfo.courseId |
| outline | study `/learning/videolist` | videolist.courseId 为 ccCourseId，不能当 courseInfo.courseId |
| progress | study `/learning/queryStuyInfo` | lessonIds / lessonVideoIds / recruitId；lv 与 lesson 两种 lookup |
| prepareStudy | study `/learning/prelearningNote` | ccCourseId / chapterId / lessonId / lessonVideoId / recruitId / videoId；返回 noteId |
| popupPoints | study `/popupAnswer/loadVideoPointerInfo` | 该端点的 courseId 取 ccCourseId，不是另一个 courseId |
| popupRead | study `/popupAnswer/lessonPopupExam` | questionIds / lessonId / lessonVideoId |
| popupAnswer | study `/popupAnswer/saveLessonPopupExamSaveAnswer` | 此处 courseId 取 courseInfo.courseId；answer 为原生 ID 串 |
| save | study `/learning/saveDatabaseIntervalTimeV2` | ewssw / sdsew / zwsds + courseId，字段语义来自 source codec |
| coursewareProbe | study `/course/threeDimensionalCourseWare` | 可选附属请求，不得把失败当主流程成功 |
| mediaProbe | newbase `/video/initVideo` | 有限 JSONP 语法解析；只是流探测，不代表完整下载功能 |
| restrictionRead | study `/cheat/exceptionActionDetail` | lock / punishType / popWindow 命中则停止并提示官方人工处理 |

ShareCourseRef 使用 recruitAndCourseId；加载得到的 recruitId、courseId、ccCourseId 单独保存。ShareVideo occurrence 使用 chapterId + lessonId + smallLessonId + videoId；单视频小节缺少 videoSmallLessons 时 smallLessonId=字符串"0"，这是**已知协议哨兵**，不是缺失 ID 的泛用回退。

视频同一 mediaId 可在多处出现；源代码的 videos[videoId] map 不能作为新模型唯一索引。进度 lookup 用 smallLessonId 非零时对应 lv，否则 lessonId 对应 lesson；任意缺失关键 ID 都不能以 0 继续上报。[Z04]

### Share reducer 与旧行为修正

watchPoint 保留初始化 [0,1]、2 秒采样及重复值语义；不能 Set 去重。XOR ev 编码不是 UTF-8 字节 XOR；按源算法和回归向量实现，对字段限定的字符集做输入校验。测试另覆盖 Unicode code point 与 JS UTF-16 差异，避免仅 ASCII 时看似等价。[Z03、Z07]

默认 SDK speed=1.0；source 中共享课默认1.5与校内课1.25不是全平台统一限制，允许范围按来源/验证登记。初始迁移允许 share 1.0..1.5、hike 1.0..1.25；超过范围报 INVALID_INPUT，不私自推断更高速被接受。

旧 share Runner 没有正确答案时选择第一个选项，新版必须返回 needs-input。用户明确批准的完整答案可执行，提交结构仍验证该题实际选项。验证码/账户限制立即暂停账号，不把限制当“单个视频失败后继续刷下一个”。[Z05]

每次完成要回读 queryStuyInfo / watchState；save 返回成功只算 acknowledged，不算 done。目标 fraction 与正式完成分开，目标达到但 watchState 未完成为 target-reached/pending，Job 用 warning 和 Progress 表达，不能写 serverCompleted=true。

### Hike endpoint 与 reducer

operationId 用 `zhs.hike.<动作>.v1`。

| 动作 | 路径 | 输入/语义 |
|---|---|---|
| list | `hikeservice.zhihuishu.com/student/course/aided/getMyCourseList` | uuid + UTC ISO date；result.**startInngcourseList** 原拼写 |
| outline | `studyresources.zhihuishu.com/studyResources/stuResouce/queryResourceMenuTree` | courseId；rt[]，childList 递归 |
| view | 同主机 `/studyResources/stuResouce/stuViewFile` | courseId + fileId；可能标记访问/学习，effect=write |
| save | `hike-teaching.zhihuishu.com/stuStudy/saveStuStudyRecord` | GET 明文 + signature，返回 rt 为权威学习秒数 |

MD5 的连接顺序固定：协议盐 + uuid + courseId + fileId + studyTotalTime + startDate + endDate + endWatchTime + startWatchTime + uuid。不是按字典键排序，也不是 JSON.stringify。所有数字转字符串形式需与原前端/源码一致。[Z03、Z06]

dataType=3 为本库视频；null/未知类型返回 unknown，不当成文档自动打开。已知非视频文档仍只有“打开/访问”的旧能力，不等同可下载或可靠读完。

循环以服务器返回时间更新 confirmed；连续三次未推进为 stalled。达到目标后退出，不能因旧 `while played <= end` 边界在终点继续发零增量请求直至触发 stall。clock/deadline 检查必须深入单个视频步骤，不只在课程之间检查。[Z06]

## P05. 共享内容与答案的保真要求

### 文本规范化

HTML 先用 parser 生成 contracts 中的 RichText；提取 data-formula/数学来源时保留 LaTeX，图片保留 assetRef，不将数学表达式丢成空串。语义 fingerprint 包括版本、题型、题干标准化、选项内容映射与 assessment kind；仅用于关联，不构成外部授权。

精确匹配允许规范化空白、Unicode NFC、等价 HTML 实体；不允许删除负号、标点造成数值变化，不能把 10 和 1.0、x² 和 x 等同。排序选项只用于建立内容映射，答题仍编码目标平台的实际 option key。

### 反馈来源与跨课程匹配

本库旧 fill-answers 从 download raw.json 中提取平台反馈；学堂 exam 与 homework 形态不同。新的 assessments.importFeedback 先标记平台/assessment kind/source fingerprint，再生成来源条目。没有公开反馈的内容不补造官方答案；用户作答与官方反馈分开。

默认只在同一用户主动选择的来源集合内匹配，不建立全站共享题库。跨课堂同题只能依题干/选项/题型匹配，不能信任 problem_id；跨 exam/homework kind 自动匹配禁止。相似度只产生建议，不负责批准写入。

## P06. 遗留差异清单与确定处置

| 发现 | 新规范的确定处置 |
|---|---|
| 历史 Cloudflare 评估依赖“全部功能都需要 Chrome”的旧前提 | 不作为当前设计依据；API hot path 依现有源码分类 |
| 学堂 CLAUDE 与 SUBMIT_LIVE 源码不一致 | 记录代码已开、证据分项、新版本默认不启用，不混淆 |
| ykt / xtx helper 把 Cookie 降成 name→value | 保留完整 jar，不迁移有损转换 |
| zhs logged_in 只看本地 uuid | 在线 probe 三态，不当成可靠 whoami |
| xtx 课程只读第一页 / ykt lessons 固定 offset | 显式 completeness + 分页 gate |
| zhs share 无答案选第一项 | needs-input，0 次写请求 |
| zhs share 仅 ACK 就计 done | 回读确认，不知道就报告 pending |
| zhs hike 终点等号/单视频时限问题 | 目标边界与取消/预算测试必须覆盖 |
| 课件 live helper 隐式 checkin | 作为独立授权写动作 |
| ykt article / zhs hike save 是 GET 写入 | effect 判定，禁止 read retry 自动重放 |
| 学堂考试 SSO 改写共享 Cookie | 账号级整段锁，不是函数内临时锁 |
| 内嵌题 font 位置未被抓证 | 明确 decode unavailable，禁止自动语义写入 |
| 字幕失败被吞成 [] | warning 与 absent 区分 |
| 网络错误被当登出 | indeterminate，不清会话 |
| source 缺失字段回退 0 | 必需标识符拒绝，不生成伪资源 |

上述变化属于目标行为修正，不能因为 Python 对照不同就回退。差分测试应明确允许这些差异，并把新行为作为目标，而不是要求与旧 bug 逐字一致。
