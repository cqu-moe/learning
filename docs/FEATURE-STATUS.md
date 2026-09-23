# learning 功能状态

版本 1.1 的范围仅为共享 SDK 与本地 CLI。以下“fixture 通过”指严格离线合成响应，不代表真实账号已验收。

| 能力 | 当前状态 | 证据与缺口 |
|---|---|---|
| 三平台 QR、课程树与资料读取 | partial | SDK fixture；CLI 已接登录、课程、大纲。智慧树 QR 后在线身份核验尚缺。 |
| 本机 profile、密钥、锁、doctor | partial | CLI 进程测试；`runtime.wake` 与完整并发恢复矩阵未闭合。 |
| 雨课堂作业单题提交 | fixture 通过 | SDK/CLI 进程测试；内嵌题与真实写入未验收。 |
| 学堂讨论草稿与发帖 | fixture 通过 | SDK/CLI 进程测试；真实发帖未授权。学堂作业提交仍未接线。 |
| 学堂考试 | partial | 只读导出与独立开卷 fixture；save/finalize 未接线，最终交卷 E05 闸门未满足。 |
| 雨课堂、学堂视频学习 | partial | 前台 job、权威进度、心跳/统计 fixture；图文、弹题继续、长任务延迟统计与真实学习未验收。 |
| 智慧树 share/hike 学习 | partial | 两类进度只读与纯函数 fixture；保存任务、在线身份核验及 E06 真机回读仍缺。 |
| 历史课件与本地 PDF | partial | 历史课件图片/PDF 进程 fixture；字体 Canvas 与受控旧页面浏览器未实现，E07 黄金样本缺失。 |
| MP4/HLS 下载 | partial | 流式本机文件与摘要的进程 fixture；Range/validator 恢复、多 GiB、字幕部分失败未验收。 |
| 答案匹配 | fixture 通过 | 只把精确匹配写到新的草稿，绝不自动提交。 |
| 任务持久化与不确定写入 | partial | 跨进程 JobRunner/ActionStore fixture；所有 job kind 的恢复与核对矩阵未完成。 |
| 雨课堂直播 | partial | mailbox/gap 纯函数；checkin、WS/job/CLI 未接线。 |
| CLI 安装打包验收 | partial | SDK 182、CLI 35、进程 E2E 4 项通过；正式 pnpm 门禁与干净消费者安装未完成。 |
| Web 与 Cloudflare | deferred | [WEB.md](deferred/WEB.md)；不计本期范围。 |

真实平台的登录、学习、答题、发帖、开卷、交卷均未在本轮执行。详见 [PROGRESS.md](PROGRESS.md) 的实际命令、退出码和下一任务。
