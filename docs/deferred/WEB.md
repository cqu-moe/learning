# 2026-10-28 范围更新

本地 React Web 仪表盘已获用户授权，范围和验收见 [WEB-UI](../WEB-UI.md)。本文保留原云端设想；独立部署、多用户、云端运行时与原生封装继续延期，不作为本地 UI 的依赖。

# learning — Web 与云端部署延期说明

版本 1.1，2026-09-23。**本文件不属于本期可执行 PLAN，也不构成创建空包或安装依赖的授权。** 只有用户另行要求启动 Web 后才制定/更新具体实施计划。

## 保留方向

项目继续是一个 `cqu-moe/learning` 仓库。未来添加 apps/web 与必要时的 apps/executor，不另开第二套平台 SDK。Web 服务端调用现有 `@learning/sdk`；浏览器只消费安全 DTO。只增加真实需要的运行时适配，不改成 CLI 通过远端 SDK 服务才能工作。

云端仍优先 Cloudflare 原生，允许 Containers。既定候选为 Workers + Static Assets、一个业务 UserDO 类型、R2；重型能力需要时复用 `/render-node` 并部署 Containers。进入该阶段再验证运行时兼容、出站 WS、资源限制和故障恢复，不能把本期 Node 测试当作云兼容证据。

不默认恢复 Access、D1、KV、Queues、Workflows、Browser Run、Tunnel 或多套调度/审批系统。未来站点身份验证保留最少必要保护，但本期不实现登录页面、站点访问密钥或用户表。

## 原任务编号与延期内容

| 旧编号 | 延期内容 | 当前状态 |
|---|---|---|
| T27 | Web 最小站点登录与 UserDO | deferred，不在当前 tasks.json |
| T28 | Web API、DO 调度、R2、Cloudflare Runtime | deferred；包括从原 T05/T23 拆出的云传输/存储适配 |
| T29 | Web 页面、浏览器交互和 Web E2E | deferred |
| T30 | Cloudflare Containers、云端 executor、传输、部署验证 | deferred |

旧 T31 中 workerd/Web/Containers/云部署验收也随 Web 延期；**当前 T31 已重新定义为 SDK + CLI 本机集成验收**。T31 结束后自动选择“下一任务”必须停止，不能跳回本文件执行 T27。

## 本期需要保留的最小复用边界

平台协议/公共业务不 import CLI、Node 磁盘或 Cloudflare；环境 I/O 经过已有 Runtime 接口。本机存储、任务驱动与可选渲染可替换；SDK public DTO 不泄漏平台秘密。保留这些边界即足够，不提前实现云端 adapter、Dockerfile、wrangler 配置、网站 API、部署脚本或 CI。

本文件只是保存延期决定，不冻结之后的全部实现细节，也不把未来工作算成当前未完成项。
