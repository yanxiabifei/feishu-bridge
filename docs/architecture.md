# 架构与实现

> 面向要改这个项目的人，不是面向上手的人。上手看根目录 `README.md`。

## 进程模型

单个 Node 守护进程（`bin/daemon.js`）持有全部状态：

```
手机飞书群 ──长连接──▶ 守护进程（单例） ──ConPTY──▶ claude / codex 进程
     ▲                    │
     └────── 卡片消息 ─────┘
```

- 守护进程通过飞书 SDK 的长连接接收 `im.message.receive_v1`，出站走 Open API。
- 所有 PTY 都由守护进程持有；本机其他前端（Electron 桌面窗口，见 `app/`）通过 `127.0.0.1:<ipcPort>` 上的 HTTP + WebSocket 接入，`ipcPort` 默认 `47831`。
- 单例：重复 `npm start` 会检测到已在运行的实例并退出。

## 数据流

1. 群消息经长连接进入 `src/feishu/ws.js`（带 TTL 去重，避免重复投递）。
2. `src/session/router.js` 解析首句：先认项目别名，再看是否明确指名 agent（「用 codex」「codex：」这类），正文里顺口提到 codex 不算。
3. `src/session/manager.js` 按 `chat_id` 找到/创建会话，落到别名对应的目录。
4. `src/session/ptySession.js` 在 ConPTY 里起进程；`src/screen.js` 用 `@xterm/headless` 解析屏幕，判定「输入框是否就绪」后再写消息，避免把字打进 shell 或菜单里。
5. 写入走 `src/session/queue.js` 的队列（有上限、有溢出回调），保证连发不粘连、不丢。
6. 每轮结束由 Stop hook（`bin/hook-stop.js` → `src/ipc.js`）回填 Claude 会话号与 transcript 路径，用于续接和统计工具调用。
7. `src/feishu/cards.js` 原地更新同一张卡片：先「处理中」，答完更新结果。

## 屏幕状态机

`src/screen.js` 是整个项目最脆的一层，改之前先看它的测试：

- 提示符锚定行首：Claude Code 用 `❯`(U+276F)，Codex 用 `›`(U+203A)。
- 页脚/状态栏形状允许出现在提示符行下方——判断「输入框就绪」时要一并考虑。
- 括号粘贴序列（`\x1b[200~` / `\x1b[201~`）用于整段写入。
- 对应测试：`test/screen.test.js`、`test/screen-real.test.js`。

## 桌面窗口（Electron）

`npm run window` 起一个 Electron 进程，它和 Stop hook 一样只是 daemon 的普通客户端：

- 整个进程只开一条 WebSocket（`app/lib/client.js`），按 `sessionId` 把 `data`/`replay` 分给对应窗口；每个窗口自带一份 `sessionFeed`（`app/lib/sessionFeed.js`）做归约，窗口之间互不打扰。
- 选择器（`app/renderer/picker.html`）负责新建会话或接回正在跑的会话；会话窗口（`session.html`）用 xterm 渲染，`input`/`resize` 原样转给 daemon。
- 错误回包本身不带窗口身份，主进程用 `app/lib/errorRoute.js` 按 `sessionId` + `replyTo` 认领到具体窗口，认不出才广播给所有窗口。
- 渲染进程 `contextIsolation: true`、`sandbox: true`，只能通过 `app/preload.js` 的窄接口和主进程说话；页面 CSP 是 `default-src 'self'`。
- 关窗口弹二选一：结束会话（发 `close`，解散群）或只关窗口（发 `detach`，群里告知「电脑窗口已关，手机照常可发」）。

## 会话

- 一个 `chat_id` ↔ 一个会话 ↔ 一个目录。中途换目录等于开新会话。
- 别名（`state/projects.json`）最长 20 个字符（`router.js` 的 `ALIAS_MAX`，改名校验同源），群里用别名指代目录。
- 私聊是总控面板（`src/control.js`），只读状态、发消息，不建会话、不碰 PTY。
- 群解散事件可能延迟或丢失：长连接正常时事件即时到达，巡检只是保险（30 秒一查）；长连接断开时事件收不到，巡检就是唯一手段（5 秒一查）。

## 配置与状态

运行时状态都在 `state/`（`.gitignore` 已排除）：

| 文件 | 内容 |
|---|---|
| `state/config.json` | `claudeExe` / `codexEntry` / `defaultCwd` / `ipcPort` 等 |
| `state/projects.json` | 项目别名 → 目录 |
| `state/secret.bin` | App Secret，DPAPI 加密，只有当前 Windows 用户能解 |

默认值见 `src/config.js`：

- `claudeExe`: `claude`（从 `PATH` 找；不在 `PATH` 就改成完整路径）
- `defaultCwd`: `~/feishu-workspace`
- `ipcPort`: `47831`

## 权限与安全边界

- Claude 以 `--permission-mode bypassPermissions` 启动；Codex 以 `--dangerously-bypass-approvals-and-sandbox` 启动。这是产品设计，不是疏漏。
- IPC 只监听回环地址，并且有 token 校验；`src/secrets.js` 的 `restrictAcl` 会把状态文件 ACL 收紧到当前用户。
- 日志脱敏（`src/log.js`）：按 key 名匹配 `secret|token|passwd|password|authorization|api_key` 等，同时把已知明文凭据加入字面量黑名单。`npm run check:logs` 扫描历史日志里是否出现泄漏。
- 守护进程从 Claude Code 终端里被拉起时会继承 `CLAUDE_CODE_CHILD_SESSION` 一类环境变量，导致子会话页脚异常；`src/session/ptySession.js` 的 `childEnv()` 负责剔除。

## 目录

```
bin/        daemon / setup / stop hook 三个入口
app/        Electron 主进程、预加载与渲染页（选择器 / 会话窗口）
src/
  agent/    launcher（信任目录、启动参数）、tools（工具调用摘要）
  feishu/   ws（长连接+去重）、events、cards、api
  session/  manager、ptySession、queue、router
  screen.js ipc.js control.js config.js store.js projects.js paths.js secrets.js log.js
test/       31 个文件，含 pty 泄漏、屏幕真实解析、e2e
scripts/    autostart（计划任务）、check-logs
```

## 开发

```bash
npm test            # 547 个用例，离线，约 9 秒
npm run test:e2e    # 离线端到端（假 agent，不需要真 claude）
```

CI 在 `.github/workflows/test.yml`，`windows-latest` × Node 22/24。

## 已知限制

1. 电脑必须开着。
2. 一个会话一个目录。
3. Codex 的回复是终端画面文本，格式不如 Claude 干净。
4. 不能接管已在 Windows Terminal 里运行的 claude 会话。
5. 群解散事件丢失时最坏约 30 秒才收尾（长连接断开时巡检自动提速到 5 秒）。
6. macOS / Linux 未验证：依赖 ConPTY、DPAPI、PowerShell。
