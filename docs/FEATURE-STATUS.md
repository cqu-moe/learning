# learning 特性状态矩阵（T31）

状态含义：implemented（代码+fixture 测试）/ unverified（实现但无真机证据）/ not-run（需用户授权）/ deferred（延期）。分母只含本期 28 项。

| 能力 | 状态 | 证据 |
|---|---|---|
| ykt 扫码登录/课程/双大纲 | implemented | tests/ykt-catalog.test.ts 7/7（synthetic fixtures, source-locked refs） |
| ykt 媒体/字幕/课件/考试读 | implemented | tests/ykt-resources.test.ts 6/6 |
| ykt 作业/内嵌题写入 | implemented（fixture） | tests/ykt-write.test.ts 4/4；真实写入 not-run（未授权） |
| ykt 学习心跳/watch progress | implemented（纯函数） | tests/ykt-study.test.ts 3/3；真实心跳 not-run |
| ykt 实时 mailbox/gap | implemented | tests/live.test.ts 2/2；真实 WS join not-run |
| xtx WS 登录/课程/大纲 | implemented | tests/xuetang-catalog.test.ts 6/6 |
| xtx 媒体/讲稿/考试读 | implemented | tests/xuetang-resources.test.ts 4/4 |
| xtx 作业/讨论写 | implemented（fixture） | tests/xuetang-write.test.ts 4/4；真实写 not-run |
| xtx 考试三动作 | implemented（fixture） | tests/xuetang-exam-write.test.ts 3/3；真实交卷 not-run（E05） |
| xtx 学习心跳/schedule 回读 | implemented（纯函数） | tests/xuetang-study.test.ts 2/2 |
| zhs 加密向量/QR 登录 | implemented | tests/zhs-auth-crypto.test.ts 7/7（官方向量+修正记录） |
| zhs share/hike 课程树 | implemented | tests/zhs-catalog.test.ts 5/5；进度读 not-run（证据缺口） |
| zhs 学习 ev/watchPoint/hike 停滞 | implemented（纯函数） | tests/zhs-study.test.ts 3/3；真实 save not-run |
| 富文本/Markdown/答案规范化 | implemented | tests/content.test.ts 7/7 |
| 草稿导入/反馈匹配/模型建议 | implemented | tests/drafts.test.ts 6/6 |
| 操作预览/幂等/uncertain | implemented | tests/actions.test.ts 6/6 |
| 任务模型/事件/恢复 | implemented | tests/jobs.test.ts 5/5 |
| 下载决策/文件名/manifest | implemented | tests/download.test.ts 3/3 |
| PDF/字形匹配/HeavyRenderer | implemented（合成样本） | tests/render.test.ts 4/4；E07 黄金样本缺失阻塞质量验收 |
| CLI init/doctor/lock/命令组 | implemented | apps/cli tests 8/8 + e2e 4/4 |
| 三平台真实登录/学习/写入 | not-run | 需用户逐项授权；无授权不触发 |
| Web/Cloudflare | deferred | docs/deferred/WEB.md；不计本期分母 |
