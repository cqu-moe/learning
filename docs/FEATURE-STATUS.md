# learning 功能状态

版本 1.1 的范围仅为共享 SDK 与本地 CLI。以下“fixture 通过”指严格离线合成响应，不代表真实账号已验收。

| 能力 | 当前状态 | 证据与缺口 |
|---|---|---|
| Agent CLI 契约与 Skill | 本机离线通过 | 默认 JSON/可选 JSONL、schema 发现、明确参数、TTY 无人工提示；CLI 204 项与打包消费者 7 项通过。Skill 校验通过；代码在独立工作树，尚未发布或替换已安装程序。 |
| 三平台 QR、课程树与资料读取 | partial | QR 流程有合成 fixture；本机旧会话导入后，三平台 `whoami`、课程列表与选定大纲已真机只读通过。全新 QR 扫码未验收。 |
| 本机 profile、密钥、锁、doctor | fixture 通过 | CLI 进程测试；数据目录 0700，密钥/SQLite 0600，wake 可唤醒前台任务。 |
| 雨课堂作业与视频内嵌题单题提交 | partial | 两类写入 fixture 通过；真机普通作业只读生成 5 题草稿。没有人工核实答案，未做真机提交。 |
| 雨课堂普通作业资料与批量流程 | 离线通过 | Markdown/本地图片/简洁 YAML、重复下载保留草稿、题目变更分版本、批量全选、按题隔离和提交前复核通过 CLI 进程回归；三份旧字体样本在 Node 解码通过，一份在固定 Bun 解码通过。自动参考字库下载/校验/缓存已验证；本轮未做平台真机验收。 |
| 学堂作业单题提交与讨论发帖 | partial | 作业/讨论写入 fixture 通过；真机普通作业只读生成 13 题草稿。没有人工核实答案/发帖文本，未做真机提交。 |
| 学堂考试 | partial | 分步动作和最终请求形态仅有 fixture；公开交卷 E05 闸门关闭。用户明确排除所有真机试卷操作。 |
| 雨课堂、学堂视频及图文学习 | partial | 雨课堂图文/视频真机只读均已完成，未重复写；学堂单视频 1×/2% 真机写入并独立读回 0.0217，整节未完成。 |
| 智慧树 share/hike 学习 | partial | share/hike fixture；共享课单视频 1×/1% 真机写入，独立读回 6/581 秒。唯一 hike 课程是考试，未操作。 |
| 历史课件与本地 PDF | partial | 历史课件图片/PDF 进程 fixture；普通作业字体现使用纯 JS 解码，受控旧页面浏览器未实现，全量字体准确率仍缺人工黄金样本。 |
| MP4/HLS 下载 | partial | MP4 Range/validator 与 HLS 分段双进程恢复；合成 4 GiB 流按 8 MiB 块拒绝超额且无发布；真实多 GiB 磁盘压力与动态 HLS 未验收。 |
| 答案匹配 | fixture 通过 | 只把精确匹配写到新的草稿，绝不自动提交。 |
| 可选模型建议 | fixture 通过 | Node HTTPS 兼容 API 适配器与 `discuss draft --ai` 的离线模型 fixture 通过；未解码题干不发送，缺 key 不影响手工流程；付费模型未调用。 |
| 任务持久化与不确定写入 | partial | AES-GCM 操作正文、跨进程恢复、智慧树多资源题闸及读回失败保留 pending fixture；20 秒硬切片和全部 job kind 崩溃矩阵未闭合。 |
| 雨课堂直播 | partial | checkin、WS 题目、重连 gap 与同 jobId 恢复 fixture；Agent CLI 仅显式签到和监听事件，人工答题 UI 已移除，未增加答题提交入口；真实直播未授权。 |
| CLI 安装打包验收 | partial | Node 打包消费者、固定 Bun/macOS arm64 独立程序/PTY/错误栈及课程、作业导出、写入保护 loopback 通过；其他四目标未重新验收，未发布新版本。历史三平台真机证据见 PROGRESS，不代表本轮真机验收。 |
| Web 与 Cloudflare | deferred | [WEB.md](deferred/WEB.md)；不计本期范围。 |

真实平台仅对两门非考试课程做了局部学习写入及权威读回；没有真实答题、发帖、直播或试卷操作。详见 [PROGRESS.md](PROGRESS.md) 的实际命令、退出码与证据边界。
