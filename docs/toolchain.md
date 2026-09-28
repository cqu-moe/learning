# learning — 工具链固定记录（T01）

日期：2026-09-23。以下版本在 T01 实际安装验证后冻结（save-exact，见 pnpm-lock.yaml）；后续任务不擅自升级。新增依赖只在所属任务安装时加入本表。

## 运行时

| 组件 | 固定版本 | 说明 |
|---|---|---|
| Node | v24.11.1（nvm：~/.nvm/versions/node/v24.11.1/bin） | SPEC 既定 Node 24 系列；本机默认 node 为 v22.22.3，所有 install/build/test 命令均显式前置 v24.11.1 PATH 后执行 |
| pnpm | 11.19.0 | packageManager 字段固定；不随提示升级到 12.x |

## 直接依赖（精确版本）

| 包 | 版本 | 引入包 | 用途 |
|---|---|---|---|
| typescript | 5.9.3 | root / sdk / cli devDeps | strict 编译、ESM+.d.ts 产物。typescript-eslint 8.70.1 peer 范围为 >=4.8.4 <6.1.0，因此不取 7.x |
| zod | 4.6.5 | sdk dependencies | DTO/schema（T02 起使用） |
| vitest | 5.0.1 | sdk / cli devDeps | 单元与 CLI 测试 |
| @types/node | 24.13.6 | sdk / cli devDeps | 匹配 Node 24 系列（不取 26.x 跟踪线） |
| eslint | 10.11.0 | root devDeps | 根 lint |
| @eslint/js | 10.0.1 | root devDeps | recommended 基线 |
| typescript-eslint | 8.70.1 | root devDeps | TS 规则；eslint peer ^8.57 || ^9 || ^10 |

## 已验证命令（T01，Node v24.11.1）

- pnpm install（生成 pnpm-lock.yaml）→ exit 0
- pnpm install --frozen-lockfile（二次）→ exit 0（A011）
- node scripts/check-boundaries.mjs → exit 0（A012，含 Node 泄漏负例自检）
- pnpm typecheck → exit 0；pnpm build → exit 0；pnpm lint → exit 0
- node apps/cli/dist/index.js --version → exit 0，输出 learning 0.1.0 …

## 边界说明

- 当前 SDK exports 仅 "." 与 "./public"；"./node" 在 T03 有真实 Node 实现后加入，"./render-node" 在 T24 加入。
- 未安装 React/Vite/Hono/Wrangler/Cloudflare 插件、Docker 工具链或云数据库客户端；无 test:worker/dev:web/deploy:web 脚本。
- 包内 test 脚本暂带 --passWithNoTests（T01 尚无测试文件）；T02 起 SDK 测试为真实 vitest 用例，该开关不再影响结果。

## CLI 体验改造新增依赖

- CLI 直接依赖 zod 4.6.5，与 SDK 同版。
- @clack/prompts 1.8.1（engines >=20.12.0）；Node24.11.1 下 text/autocomplete/confirm 与 stderr 输出已通过真实 PTY 验证。
- cli-table3 0.6.5，Node24.11.1 下 ESM 导入及 32/80/120 列中文布局测试通过。
