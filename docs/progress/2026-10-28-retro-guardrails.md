# 2026-10-28 · 源码校验门禁与 Agent 文档整理

## 改动

- CI 移除源码校验后的 `|| true`；通过 `--allow-missing-references` 仅跳过缺失的私有参考 checkout。清单损坏、版本不匹配及已有 checkout 错误仍失败，默认本机核验仍严格。
- 新增在真实临时 Git checkout 上运行的脚本回归，并接入 CI；不执行旧参考 CLI，也不需要私有仓库权限。
- 原 PROGRESS 完整保存为同目录的 `2026-10-27-history.md`；当前入口改为短索引，后续证据按任务保存。
- AGENTS、README 与阶段文档明确区分稳定契约、原 1.1 阶段和新用户任务。开发文档收拢检查与交付入口。

## 验证

- 修改前脚本回归按预期失败：原脚本无法选择跳过缺失参考库，损坏清单出现未处理异常。
- Node 24.11.1：`node --test scripts/test-source-lock.mjs`，11 项通过，exit 0。
- Node 24.11.1：`node scripts/check-source-lock.mjs --allow-missing-references`，exit 0；明确报告 3 个参考库 SKIP、0 个 checkout 已核验，不作为源码证据通过。

- Node 24.11.1：根 `pnpm lint`、改动脚本 ESLint 与 `node scripts/check-boundaries.mjs` 通过，exit 0；`git diff --check` 无错误。
- 原历史归档与基线 `HEAD:docs/PROGRESS.md` 逐字节一致，新的入口 Markdown 链接均可定位。

## 边界与状态

仅修改检查和 Agent 文档；未改产品运行逻辑或发行版本。未进行真实平台、付费模型或生产遥测验收。私有参考源码仍未在本工作区核验；本次回归使用真实本地 Git fixture 验证失败行为。
