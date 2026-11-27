# feishu-bridge · 飞书双向 AI 终端桥

把手机上的飞书群和电脑上的 **Claude Code / Codex** 会话接成同一个通道：手机发一句话，电脑上真的开一个终端会话干活，回答再回到飞书。

不经过任何境外服务器，不需要公网 IP，不需要内网穿透——只依赖飞书开放平台的**长连接**。

> 状态：Plan A 已完成并在手机上端到端跑通（发消息 → 会话执行 → 回答回群 → 会话管理）。
> 电脑端镜像窗口（设计里的 Plan B，Electron 多窗口 + xterm.js）**尚未实现**。

## 它是怎么工作的

```
手机飞书群 ──长连接──▶ 守护进程（单例） ──ConPTY──▶ claude / codex 进程
     ▲                    │
     └────── 卡片消息 ─────┘
```

- 守护进程持有所有 PTY，飞书长连接和本机 IPC 都挂在它身上；本机其他程序（以后的桌面窗口）通过 `127.0.0.1:47831` + token 接入。
- 每个会话是一个真实 PTY，屏幕状态用 `@xterm/headless` 解析，判断「输入框是否就绪」再写消息，避免把字打进 shell 或菜单里。
- 每个会话装一个 Stop hook，进程答完一轮后回填 Claude 的会话号和 transcript 路径，用来续接和统计工具调用。
- 群 ↔ 会话按 `chat_id` 绑定：一个群一个会话，目录在群里用别名指代，不用记绝对路径。

## 功能

- **手机 ↔ 终端**：群里 `@机器人 <别名> 要做什么`，落到别名对应的目录
- **多会话并行**：不同项目各开一个群，互不串话
- **私聊总控面板**：发「列表」查看所有会话；「结束 <别名>」关闭；「改名 <旧> <新>」改项目别名（也可以点卡片按钮）
- **回复卡片原地更新**：先出「处理中」，答完在同一张卡片上更新，不刷屏
- **全自动权限**：Claude 用 `--permission-mode bypassPermissions`，Codex 用 `--dangerously-bypass-approvals-and-sandbox`——手机发一句就能在本机执行命令，见下方安全提示
- **单例守护进程**：重复启动会自己退出；凭据用 Windows DPAPI 加密存放

## 平台

Windows 10 / 11。依赖 ConPTY、DPAPI、PowerShell，macOS / Linux 未验证。

## 快速开始

要求 Node.js ≥ 20（开发与实测用 Node 24）。

1. 在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**，开启机器人能力，并配置：

   | 类型 | 内容 |
   |---|---|
   | 权限 | `im:message`、`im:message:send_as_bot`、`im:chat`、`im:chat:delete`、`cardkit:card` |
   | 事件 | `im.message.receive_v1`（连接方式选**长连接**） |

   然后发布版本，并确认自己在此应用的可用范围内。

2. 安装并初始化：

   ```bash
   npm install
   npm run setup   # 依次填 App ID、App Secret，并做自检
   npm start       # 启动守护进程
   ```

3. 私聊机器人发「列表」试一下；建一个群、把机器人拉进去，`@机器人 要做什么` 即可开工。

可选：`npm run autostart` 查看自启计划任务状态，`npm run autostart -- install --dry-run` 预览，去掉 `--dry-run` 才真正安装；`npm run check:logs` 检查日志里有没有泄漏凭据。

## 配置

运行时状态都在 `state/`（已被 git 忽略）：

| 文件 | 内容 |
|---|---|
| `state/config.json` | `claudeExe` / `codexEntry` / `defaultCwd` / 参数 / 端口等 |
| `state/projects.json` | 项目别名 → 目录 |
| `state/secret.bin` | App Secret，DPAPI 加密，只有当前 Windows 用户能解 |

默认从 `PATH` 找 `claude`。如果 `claude.exe` 不在 `PATH`（比如装在某个独立目录），在 `state/config.json` 里把 `claudeExe` 改成完整路径后重启。

## 已知限制

1. 电脑必须开着，手机端无法唤醒关机的机器。
2. 一个会话一个目录；中途换目录等于开新会话。
3. Codex 的回复是终端画面文本，格式不如 Claude 干净。
4. 不能接管你已经在 Windows Terminal 里跑的 claude 会话——两条路并行，互不干扰。
5. 群解散事件可能延迟或丢失，有 30 秒轮询兜底，最坏延迟约 30 秒。
6. 电脑端镜像窗口（Plan B）未实现，目前只能从手机侧使用。

## 安全提示

全自动权限意味着**任何能给机器人发消息的人，都能在你电脑上执行命令**。只把机器人拉进自己的群，不要分享 App Secret。日志会对 App Secret 和 `ANTHROPIC_AUTH_TOKEN` 做脱敏。

## 文档

- 设计规格：`docs/superpowers/specs/2026-11-23-feishu-agent-bridge-design.md`
- 实现计划：`docs/superpowers/plans/2026-11-23-feishu-agent-bridge.md`
- 验收清单：`docs/acceptance.md`

## 许可

MIT
