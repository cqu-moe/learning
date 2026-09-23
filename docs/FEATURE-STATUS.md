# learning 功能状态

版本 1.1 的范围仅为共享 SDK 与本地 CLI。以下“fixture 通过”指严格离线合成响应，不代表真实账号已验收。

| 能力 | 当前状态 | 证据与缺口 |
|---|---|---|
| 三平台 QR、课程树与资料读取 | fixture 通过 | 默认智慧树微信 QR、原生 QR 与在线 UUID probe 均有合成 fixture；真实账号仍待核验。 |
| 本机 profile、密钥、锁、doctor | fixture 通过 | CLI 进程测试；数据目录 0700，密钥/SQLite 0600，wake 可唤醒前台任务。 |
| 雨课堂作业与视频内嵌题单题提交 | fixture 通过 | 独立作业和内嵌题各用对应端点与头；错题仅报告未答对，SDK/CLI 进程 fixture 通过；真实写入未授权。 |
| 学堂作业单题提交与讨论发帖 | fixture 通过 | 作业读取、草稿、CSRF 单题写入及讨论草稿/发帖均有 SDK/CLI 进程 fixture；真实写入未授权。 |
| 学堂考试 | partial | 只读导出、编辑草稿、独立开卷与选择/判断缓存 fixture；最终交卷被 E05 闸门阻断。 |
| 雨课堂、学堂视频及图文学习 | partial | 雨课堂图文/内嵌题继续与学堂 180 秒权威统计轮询、响应后读回失败核对均有 fixture；真实学习未授权。 |
| 智慧树 share/hike 学习 | partial | 两类加密/签名保存、弹题暂停、服务端进度回读 fixture；E04/E06 真机核验仍缺。 |
| 历史课件与本地 PDF | partial | 历史课件图片/PDF 进程 fixture；字体 Canvas 与受控旧页面浏览器未实现，E07 黄金样本缺失。 |
| MP4/HLS 下载 | partial | MP4 Range/validator 与 HLS 完整分段检查点均有双进程恢复 fixture；字幕失败保主文件；多 GiB 持续流与动态 HLS 未验收。 |
| 答案匹配 | fixture 通过 | 只把精确匹配写到新的草稿，绝不自动提交。 |
| 可选模型建议 | fixture 通过 | Node HTTPS 兼容 API 适配器与 `discuss draft --ai` 的离线模型 fixture 通过；未解码题干不发送，缺 key 不影响手工流程；付费模型未调用。 |
| 任务持久化与不确定写入 | partial | AES-GCM 操作正文、跨进程 JobRunner/ActionStore、分页与核对 fixture；全部 job kind 的崩溃矩阵未闭合。 |
| 雨课堂直播 | partial | checkin、WS 题目、当前题人工确认、重连 gap 与同 jobId 恢复 fixture；题面不可用时须在官方客户端查看，真实直播未授权。 |
| CLI 安装打包验收 | partial | SDK/CLI tgz 在隔离消费者内验证 bin、exports、QR/课程/导出/Range 恢复；依赖使用工作区已冻结版本链接，离线独立安装缺 pdf-lib tarball；最终 A312 矩阵未完成。 |
| Web 与 Cloudflare | deferred | [WEB.md](deferred/WEB.md)；不计本期范围。 |

真实平台的登录、学习、答题、发帖、开卷、交卷均未在本轮执行。详见 [PROGRESS.md](PROGRESS.md) 的实际命令、退出码和下一任务。
