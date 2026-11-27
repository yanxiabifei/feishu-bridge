# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-27

第一个可用版本。

### 新增

- 手机飞书群 ↔ 本机 Claude Code / Codex 的双向桥接，走飞书长连接，不需要公网 IP。
- 多项目并行：一个群绑定一个目录，群里用别名指代。
- 私聊总控：查看会话列表、结束会话、改别名。
- 回复卡片原地更新，先「处理中」再出结果，不刷屏。
- 通过 `@xterm/headless` 解析终端画面，等输入框就绪再写入，避免把字打进 shell 或菜单。
- `npm run setup` 向导：填 App ID / Secret，顺带把长连接、建群、发消息、发卡片、解散群全部自检一遍。
- App Secret 用 Windows DPAPI 加密存放；状态文件 ACL 收紧到当前用户。
- 日志脱敏 + `npm run check:logs` 扫描。
- 计划任务开机自启（`npm run autostart`）。
- 手机建群后一次性无头接待：自动决定目录、改群名、执行首条指令。

### 安全

- Claude 以 `--permission-mode bypassPermissions`、Codex 以 `--dangerously-bypass-approvals-and-sandbox` 启动。这是产品设计：**能给机器人发消息的人就能在这台电脑上执行命令**，只应部署在自己的群里。详见 [SECURITY.md](SECURITY.md)。

### 已知限制

- 仅 Windows（依赖 ConPTY、DPAPI、PowerShell）。
- 电脑必须开着。
- 不能接管已在终端里运行的会话。
- 桌面端镜像窗口（Plan B）未实现。
