# learning — SDK + CLI 本期实施状态

版本1.1。此文档包只完成规范修改，没有产品实现。以下是**新项目初始模板**；如果已有真实PROGRESS与代码，按任务编号合并，绝不覆盖完成记录或把已完成任务重置。当前分母为28项，T27–T30延期。

| 任务 | 内容 | 状态 | 实际测试命令/退出码 | 阻塞 |
|---|---|---|---|---|
| T00 | 固定源码与证据目录 | not-started | 未运行 | — |
| T01 | 两包工作区与本地构建入口 | not-started | 未运行 | — |
| T02 | DTO、稳定标识与测试内存存储 | not-started | 未运行 | — |
| T03 | 本地StateStore和加密会话记录 | not-started | 未运行 | — |
| T04 | HTTP、Cookie、重定向与协议fixture工具 | not-started | 未运行 | — |
| T05 | 统一登录生命周期、WS和SDK工厂 | not-started | 未运行 | — |
| T06 | 雨课堂登录、课程与两类大纲 | not-started | 未运行 | — |
| T07 | 雨课堂资源、课件及考试只读 | not-started | 未运行 | — |
| T08 | 学堂WS登录、课程与大纲 | not-started | 未运行 | — |
| T09 | 学堂资源、作业和考试结果读取 | not-started | 未运行 | — |
| T10 | 智慧树编码与登录 | not-started | 未运行 | — |
| T11 | 智慧树两类课程树和权威进度 | not-started | 未运行 | — |
| T12 | 富文本、Markdown与格式导出 | not-started | 未运行 | — |
| T13 | 草稿导入、反馈匹配与可选模型建议 | not-started | 未运行 | — |
| T14 | 操作预览、幂等与不确定写入 | not-started | 未运行 | — |
| T15 | 雨课堂作业与内嵌题写入 | not-started | 未运行 | — |
| T16 | 学堂作业与讨论发布 | not-started | 未运行 | — |
| T17 | 学堂考试的三个独立动作 | not-started | 未运行 | — |
| T18 | 固定任务模型、暂停恢复与事件 | not-started | 未运行 | — |
| T19 | 雨课堂学习任务 | not-started | 未运行 | — |
| T20 | 学堂学习任务 | not-started | 未运行 | — |
| T21 | 智慧树share/hike学习任务 | not-started | 未运行 | — |
| T22 | 雨课堂实时会话与事件缺口 | not-started | 未运行 | — |
| T23 | 流式下载、持久产物与断点恢复 | not-started | 未运行 | — |
| T24 | 本地PDF与字体重型实现 | not-started | 未运行 | — |
| T25 | CLI基础命令与本地运行装配 | not-started | 未运行 | — |
| T26 | CLI完整功能入口与恢复操作 | not-started | 未运行 | — |
| T31 | SDK与CLI集成验收、安装说明与本机证据 | not-started | 未运行 | — |

## 延期（不计本期分母，不是下一任务）

T27 Web登录/UserDO、T28 API/DO/R2/Cloudflare Runtime、T29页面/Web E2E、T30云端Containers，以及旧T31云部署验收，全部deferred。当前T31仅SDK/CLI本机验收。完成当前T31后停止。

## 每次实际记录

按任务编号与日期追加：实际改动文件、命令/环境/退出码、通过与未运行层级、source/fixture变化、具体blocker和影响、下一个当前任务编号。done需要真实证据；partial/blocked不能写完成。延期不是blocked。

## 用户授权的真实验证

初始无。未授权不触发平台操作；没有实际执行不得写入虚构结果。
