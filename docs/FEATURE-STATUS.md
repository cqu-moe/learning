# learning 功能状态

版本 1.1 的范围仅为共享 SDK 与本地 CLI。以下“fixture 通过”指严格离线合成响应，不代表真实账号已验收。

| 能力 | 当前状态 | 证据与缺口 |
|---|---|---|
| 三平台 QR、课程树与资料读取 | partial | QR 流程有合成 fixture；本机旧会话导入后，三平台 `whoami`、课程列表与选定大纲已真机只读通过。全新 QR 扫码未验收。 |
| 本机 profile、密钥、锁、doctor | fixture 通过 | CLI 进程测试；数据目录 0700，密钥/SQLite 0600，wake 可唤醒前台任务。 |
| 雨课堂作业与视频内嵌题单题提交 | partial | 两类写入 fixture 通过；真机普通作业只读生成 5 题草稿。没有人工核实答案，未做真机提交。 |
| 学堂作业单题提交与讨论发帖 | partial | 作业/讨论写入 fixture 通过；真机普通作业只读生成 13 题草稿。没有人工核实答案/发帖文本，未做真机提交。 |
| 学堂考试 | partial | 分步动作和最终请求形态仅有 fixture；公开交卷 E05 闸门关闭。用户明确排除所有真机试卷操作。 |
| 雨课堂、学堂视频及图文学习 | partial | 雨课堂图文/视频真机只读均已完成，未重复写；学堂单视频 1×/2% 真机写入并独立读回 0.0217，整节未完成。 |
| 智慧树 share/hike 学习 | partial | share/hike fixture；共享课单视频 1×/1% 真机写入，独立读回 6/581 秒。唯一 hike 课程是考试，未操作。 |
| 历史课件与本地 PDF | partial | 历史课件图片/PDF 进程 fixture；字体 Canvas 与受控旧页面浏览器未实现，E07 黄金样本缺失。 |
| MP4/HLS 下载 | partial | MP4 Range/validator 与 HLS 完整分段检查点均有双进程恢复 fixture；字幕失败保主文件；多 GiB 持续流与动态 HLS 未验收。 |
| 答案匹配 | fixture 通过 | 只把精确匹配写到新的草稿，绝不自动提交。 |
| 可选模型建议 | fixture 通过 | Node HTTPS 兼容 API 适配器与 `discuss draft --ai` 的离线模型 fixture 通过；未解码题干不发送，缺 key 不影响手工流程；付费模型未调用。 |
| 任务持久化与不确定写入 | partial | AES-GCM 操作正文、跨进程 JobRunner/ActionStore、分页与核对 fixture；全部 job kind 的崩溃矩阵未闭合。 |
| 雨课堂直播 | partial | checkin、WS 题目、当前题人工确认、重连 gap 与同 jobId 恢复 fixture；题面不可用时须在官方客户端查看，真实直播未授权。 |
| CLI 安装打包验收 | partial | 28 条命令 help、23 组错误输入、tgz 隔离消费者及三平台已授权的选定真机读写通过；全新离线依赖安装缺 pdf-lib tarball，E07 字体样本缺失。 |
| Web 与 Cloudflare | deferred | [WEB.md](deferred/WEB.md)；不计本期范围。 |

真实平台仅对两门非考试课程做了局部学习写入及权威读回；没有真实答题、发帖、直播或试卷操作。详见 [PROGRESS.md](PROGRESS.md) 的实际命令、退出码与证据边界。
