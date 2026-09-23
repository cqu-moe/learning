# learning 安装指南

本仓库为私有项目 cqu-moe/learning 的 SDK+CLI 阶段。Web 与云端部署已延期。

## 前置条件

- Node.js 24.11.1（nvm：`nvm install 24.11.1`；`node -v` 必须 ≥24.11.1 且 <25）
- pnpm 11.19.0（`corepack enable && corepack prepare pnpm@11.19.0 --activate`）
- 仓库读权限（cqu-moe/learning；.reference 参考仓需要 cqu-moe/ykt-cli、cqu-moe/xuetang-cli、cqu-moe/zhs-cli 的读权限）

## 安装

```bash
git clone https://github.com/cqu-moe/learning.git
cd learning
pnpm install --frozen-lockfile
pnpm build
```

## 初始化

```bash
node apps/cli/dist/index.js init --home ~/.learning
```

首次 init 生成 `master.key` 与 SQLite 状态库；目录权限 0700，密钥和数据库 0600。已有目录打开时也会收紧这些权限。操作草稿正文使用 AES-GCM 保存；旧明文操作记录首次读取时原地迁移，保留不确定写入状态。密钥与数据库同机存储，不抵御整机失陷；可用 LEARNING_HOME 隔离多套数据。

## 可选模型建议

手工草稿不需要模型。需要 `discuss draft <resource> --ai` 时，在本机进程环境中设置 `LEARNING_MODEL_BASE_URL`（HTTPS 兼容 API 的 `/v1` 根路径）、`LEARNING_MODEL_NAME` 和 `LEARNING_MODEL_API_KEY`；仅明确使用 `--ai` 时发送选定题目或讨论主题，建议仍需编辑并另行确认发布。密钥不写入仓库、CLI 输出或 profile 状态。本地适配器使用 [OpenAI Docs 的 Chat Completions 请求格式](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/create)；具体服务端是否兼容仍须用用户自己的配置验证。本轮没有调用付费模型。

## 备份/升级/回滚

- 备份：复制 LEARNING_HOME 目录（含 master.key 与 state.db）。
- 升级：`git pull && pnpm install --frozen-lockfile && pnpm build`。
- 回滚：`git checkout <旧tag> && pnpm install --frozen-lockfile && pnpm build`。

## 解锁与恢复

- 多进程写冲突：CLI 会拒绝并提示占用 PID。确认原进程已退出后运行 `node apps/cli/dist/index.js --home <dir> profile unlock`；活跃 PID 不会被抢锁。
- 已保存的导出及三平台视频任务可用 `jobs show/resume/cancel` 管理；带 pending heartbeat/save 的任务须先 `jobs reconcile <job-id>` 只读核对，仍为 uncertain 时不会重交。独立作业/考试/讨论动作以错误里的 operationId 使用 `operations reconcile <operation-id>`；若平台无权威核对接口，仍保持 uncertain。
- 直播任务重启后 `jobs resume <job-id> --yes` 会重新签到同一课时、重握 WS，并报告期间无法恢复的事件缺口；未明确确认时不重新签到。更多能力限制见 [FEATURE-STATUS.md](FEATURE-STATUS.md)。
