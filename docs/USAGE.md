# learning 使用说明

```bash
learning --help
learning init [--home <dir>]
learning doctor
learning jobs list
learning jobs reconcile <jobId>
learning exam submit <draft> --yes --final
learning run --dry-run
learning download --dry-run
```

- 所有命令本机运行；stdout 为结构化数据，日志/错误走 stderr；无 daemon、无监听端口。
- 写类操作（作业/考试/讨论/学习）先 preview 后执行；`exam submit` 必须 `--yes --final`；`--dry-run` 不发写。
- 扫码登录与真实平台操作需要用户逐项授权后开放；未授权能力显示 unverified/not-run，不伪造结果。
- 浏览器（受控课件）与参考字体为可选本地资源：doctor 报告缺失，不自动安装；字体样本不足时保持 unresolved。
