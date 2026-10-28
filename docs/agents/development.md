# 开发与验证

## 现有检查

Node、pnpm 和 Bun 版本从 `package.json`、`.bun-version` 与 `docs/toolchain.md` 读取。先运行改动所属的最小回归，再完成当前 `.github/workflows/ci.yml` 要求的适用检查。

- SDK/CLI 改动沿用根 scripts 的 lint、typecheck、test、build，以及 `test:e2e` 的 CLI 进程测试；导入/导出边界用 `scripts/check-boundaries.mjs`。
- 源码证据检查的回归入口为 `node --test scripts/test-source-lock.mjs`。`node scripts/check-source-lock.mjs` 默认要求三个私有参考 checkout 存在、版本匹配且处于 detached HEAD。
- 无参考仓库的 CI 使用 `node scripts/check-source-lock.mjs --allow-missing-references`。仅缺失目录可明确报告 `SKIP`；JSON/清单损坏、缺项、重复项、错误 ref、已存在但损坏的 checkout、版本不匹配和非 detached 状态仍导致失败。跳过参考源码不构成协议核验通过。
- fixture 核验请求方法、地址、参数、headers、body 和错误 envelope；默认未登记请求失败。新回归应先在旧实现上因目标行为失败，再验证修复。

## CI 等待与交付

使用本地 `gh run watch RUN_ID --repo cqu-moe/learning --interval 60 --exit-status` 或 PR checks 的 watch 模式，异步等待并将日志写入任务目录；设置最长等待时间，完成或失败后才读取摘要。不要在模型回合中持续查询相同运行状态。合并前核对检查属于当前提交。

发行任务按 [CLI-DISTRIBUTION](../CLI-DISTRIBUTION.md) 验证版本、五目标原生程序、校验文件、许可证和安装入口。CLI package.json 版本变化合入 main 后会触发发布；普通文档或检查修复不修改发行版本。

报告区分本地、CI、合并、发行物和真实平台验收。已有授权的 PR/合并/发布步骤持续完成；真实平台账号、付费模型和外部写入遵守用户本次授权，不用离线通过推断线上成功。

## 状态与历史

`docs/PROGRESS.md` 是当前状态索引；每个任务的详细证据放在 `docs/progress/`。保留历史记录，不将其中旧测试总数、旧发行版本或停止条件作为当前事实。`SPEC`、`PLAN`、`HANDOFF` 的 1.1 阶段规则只在与当前任务相符时使用。
