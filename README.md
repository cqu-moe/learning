# learning — SDK + CLI 本期交接包

**项目/私有仓库：learning / cqu-moe/learning。版本1.1，2026-09-23。**

这是修改后的设计、任务和交接文档，不是已运行的产品。**本期开发SDK与CLI；Web和Cloudflare部署延期。** 当前只建@learning/sdk与@learning/cli两包。本版替代最终版1.0及此前v0.1/v0.2。

## 当前文件

| 文件 | 用途 |
|---|---|
| [SPEC](docs/SPEC.md) | 本期范围、两包结构、技术栈、明确不做的内容 |
| [SDK](docs/SDK.md) / [contracts](docs/contracts.d.ts) | SDK行为与接口声明，不是实现 |
| [PLATFORMS](docs/PLATFORMS.md) | 固定三平台协议与功能差异，范围没有随Web缩水 |
| [APPS](docs/APPS.md) | 当前CLI命令、本地任务与渲染、安装交付 |
| [PLAN](docs/PLAN.md) / [tasks.json](docs/tasks.json) | 当前28项：T00–T26与T31 |
| [ACCEPTANCE](docs/ACCEPTANCE.md) | 当前56组验收要求，不是已通过测试 |
| [HANDOFF](docs/HANDOFF.md) | 首次、继续、迁移、纠偏和复核提示词 |
| [PROGRESS](docs/PROGRESS.md) | 实际进度模板；已有记录时合并而非覆盖 |
| [SOURCES](docs/SOURCES.md) | 固定来源和本期E01–E08，未重查网页/平台 |
| [Web延期说明](docs/deferred/WEB.md) | 仅保留未来同仓/Cloudflare原生方向，不是可执行待办 |
| [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) | 本轮文档检查，不冒充产品测试 |
| [AGENTS](AGENTS.md) | 防止模型提前开发Web或过度设计的根约束 |

## 使用

将ZIP内learning/的内容放到cqu-moe/learning根目录。新仓库按HANDOFF首次提示开始；已有1.0代码/进度时按“已有项目切换范围”提示合并，不能直接覆盖PROGRESS或删除已写文件。旧文档移出模型活动上下文。

先完成T00–T26，再执行本机验收T31，之后停止。T27–T30已延期，不建空包、不安装Web/Cloudflare依赖，不要求云账号或Docker。CLI需要的本地PDF、字体和浏览器仍在T24/T26内。

三个参考仓库需私有读取权限或只读checkout。离线工程工作不需要真实平台Cookie、模型Key或云密钥。真机和付费调用另行授权；编写代码不等于授权真实提交。
