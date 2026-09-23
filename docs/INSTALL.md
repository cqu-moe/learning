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

首次 init 生成 `master.key`（0600 权限）与 SQLite 状态库。密钥与数据库同机存储，不抵御整机失陷；可用 LEARNING_HOME 隔离多套数据。

## 备份/升级/回滚

- 备份：复制 LEARNING_HOME 目录（含 master.key 与 state.db）。
- 升级：`git pull && pnpm install --frozen-lockfile && pnpm build`。
- 回滚：`git checkout <旧tag> && pnpm install --frozen-lockfile && pnpm build`。

## 解锁与恢复

- 多进程写冲突：CLI 会拒绝并提示占用 PID。确认原进程已退出后运行 `node apps/cli/dist/index.js --home <dir> profile unlock`；活跃 PID 不会被抢锁。
- 已保存的导出及雨课堂/学堂视频任务可用 `jobs show/resume/cancel` 管理；带 pending heartbeat 的雨课堂/学堂任务须先 `jobs reconcile <job-id>` 只读核对，仍为 uncertain 时不会重交。其他 job kind 和动作的恢复尚未完成，见 [FEATURE-STATUS.md](FEATURE-STATUS.md)。
