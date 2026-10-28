# Learning 本地 Web 仪表盘

React 19 + CQU Moe Design 1.1.0。浏览器通过同源 API 使用共享 SDK，平台协议继续由 SDK 实现。运行环境沿用仓库固定的 **Node 24.11.1 / pnpm 11.19.0**。

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm web
```

打开 <http://127.0.0.1:4311>。默认共用 `~/.learning`，可通过 `LEARNING_HOME` 指定其他目录。端口可用 `LEARNING_WEB_PORT` 或 `pnpm --filter @learning/web start --port 4313` 指定。服务只监听回环地址。

## 使用

1. 在「平台账号」添加账号，再主动获取二维码并在手机上登录。已有本机账号会自动显示。
2. 在「我的课程」选择账号、刷新课程；需要时继续加载下一页。搜索和平台筛选使用本机缓存。
3. 点击课程，在「新建任务」选择资源和参数，查看预览，再确认开始。支持学习、视频导出、普通作业导出；雨课堂还可选课件与课堂任务。
4. 在「任务中心」暂停、恢复、核对结果和下载文件。恢复保留原任务和进度；课堂恢复会再次签到，需要明确确认。任务执行沿用 SDK 与本机写锁，同一目录一次运行一个任务。保持本地服务运行，浏览器可关闭。

概览不自动读取平台；运行中的任务每 5 秒读取本机状态，页面隐藏时暂停刷新。平台会话记录存在不等于在线有效。结果不确定时保留核对提示，不自动重交。

当前包括账号添加/扫码、课程列表/目录、任务预览/发起/执行/恢复/暂停/取消/核对与文件下载。作业编辑/提交、讨论发布、站点部署与原生壳未纳入 U02。当前 UI 与 Agent CLI 的改造独立，界面不导入 CLI 代码。

## 开发

先构建 SDK，再在两个终端分别运行：

```sh
pnpm --filter @learning/sdk build
LEARNING_WEB_ALLOW_VITE=1 pnpm --filter @learning/web start
```

```sh
pnpm --filter @learning/web dev
```

浏览器访问 <http://127.0.0.1:5174>。Vite 将 `/api` 转发给 4311；开发 Origin 只在显式启用时放行。后端源码改变后重启 Node 服务。

## 检查

```sh
pnpm --filter @learning/web test
pnpm --filter @learning/web build
pnpm check:design
node scripts/check-boundaries.mjs
```

独立浏览器验收可运行 `node apps/web/tests/browser-server.ts`，打开 <http://127.0.0.1:4312>。它使用临时 SQLite 与合成账号、课程、任务，只返回登记的严格合成平台响应，未登记请求一律拒绝，完全不访问真实平台；不读真实数据目录，退出时清理临时数据。测试 fixture 不参与产品启动。

依赖使用本目录 `.design/*.tgz`，根 workspace 合并 theme override 和锁文件。没有 registry 上的 CQU Design 包依赖，也不引用设计仓库的个人绝对路径。复用 ThemeProvider、Toaster、AppShell 和公开基础组件；字体、颜色、间距、浮层与主题遵循包内规范。

实际命令、浏览器截图和未验范围见 [PROGRESS](../../docs/PROGRESS.md)。本地合成 fixture 通过不等于真实平台登录或写入验收。
