# Plan B 电脑端镜像窗口 · 设计

> 上游规格：`docs/superpowers/specs/2026-11-23-feishu-agent-bridge-design.md` 的 §3.1 / §3.2 / §5.2 / §8 / §11。
> 本文只写窗口这一层怎么落地，不重复守护进程已有的设计。

## 目标

双击图标 → 选目录和 agent → 弹出一个贴着群名的终端窗口，和手机群共享同一个 Claude Code / Codex 会话。关窗口不等于结束会话，结束会话要先确认。

验收对应 `docs/acceptance.md` 第 1–8、10 条中标 🅑 的部分。

## 进程模型

```
手机飞书群 ──长连接──▶ 守护进程（单例，持有全部 PTY）◀──ws://127.0.0.1── Electron 主进程
                              ▲                                          │
                              └────────── IPC（input/resize/…）───────────┘
                                                                         │ IPC(preload)
                                                                   每个窗口的渲染进程
```

- **守护进程不动**：窗口只是多一个 IPC 客户端，协议只加两条消息（见下）。
- **Electron 单进程多窗口**：`app.requestSingleInstanceLock()`；第二个实例启动时由第一个实例再开一个选择器窗口（`second-instance`）。这样才能做到「双击三次 = 三个窗口 / 三个群」。
- **主进程只持有一个 WebSocket 客户端**（`app/lib/client.js`），收到的消息按 `sessionId` 分发给对应窗口的 `sessionFeed`。每个窗口一个 feed，保证 replay 顺序与「别的会话输出不进这个窗口」。
- **不加载 node-pty**：窗口侧只有 `ws` + `@xterm/xterm` + `@xterm/addon-fit`，不需要 electron-rebuild。这是上游规格 §11 的硬要求。
- 所有窗口关完 → Electron 退出；守护进程继续跑，会话照旧。

## 启动与目录解析

打包后的 exe 不在仓库目录里，`src/paths.js` 那套「`__dirname/..`」算不出 `state/ipc.json`。窗口侧用 `app/lib/endpointFile.js` 按顺序找：

1. 环境变量 `FEISHU_BRIDGE_IPC`（显式指定，测试和高级用户用）；
2. 当前工作目录下的 `state/ipc.json`；
3. 从 `process.execPath` 所在目录向上最多 4 层，每层找 `state/ipc.json`；
4. 从 `app.getAppPath()` 向上最多 4 层，同上。

第一个存在的文件胜出；都不存在时返回第一个候选，让 `readEndpoint()` 报出可读的「先运行 npm start」。

## 选择器窗口（也是「接回已有会话」面板）

一个窗口两段：

```
[最近使用]
  📁 卡牌        D:\★CardGame\demo44      claude  11-23 21:40
  📁 blog        D:\blog                 codex   11-22 18:02
[接回正在跑的会话]        ← 只列 status 不在 closed/closing 的记录
  ● 卡牌 · 11-23 21:40  运行中
[其他目录…]  [claude] [codex]
```

- 最近目录复用 `app/lib/pickerModel.js` 的 `buildPicker()`；新增 `resumable` 列表（按 `lastActiveAt || createdAt` 倒序，标记状态）。
- 选中「最近目录」或「其他目录」+ agent → 发 `create {cwd, agent}`；守护进程建群、起 PTY、返回 `session`，主进程按返回的 id 开窗口。
- 选中「接回」项 → 直接 `openSessionWindow(id)`，不发 create。
- 键盘：`↑`/`↓` 在同一分组内移动高亮，`Enter` 激活，`Esc` 关选择器（不建任何东西）。
- 没有最近目录时只显示「其他目录…」。

## 会话窗口

- 标题 = `formatTitle(session)`（别名 · MM-DD HH:mm）。
- xterm.js 渲染；`term.onData → bridge.input`，`FitAddon` 尺寸变化 → `bridge.resize`。
- 底部状态栏 = `formatSyncLine({session, state})`；transport 状态来自客户端事件（已同步 / 重连中 / 已断开 / 连接中）。
- 打开流程：`feed.select(id)` → 发 `attach`；收到 `replay` 先 `reset` 再整屏写入，之后实时 `data` 追加。
- 手机新建的会话：主进程收到未知 sessionId 的广播 `session`（且状态不是 closed）时自动开窗并 attach，满足「手机建群后电脑自动弹窗」。

## 关闭与生命周期

关闭窗口时拦截 `close` 事件，按会话状态给不同默认项（`app/lib/closePrompt.js`，纯函数）：

| 会话状态 | 按钮（从左到右） | 默认 | 取消 |
|---|---|---|---|
| `starting` / `running`（正忙） | 取消 / 只关窗口 / 结束会话 | 取消 | 取消 |
| 其他 | 结束会话 / 只关窗口 / 取消 | 结束会话 | 取消 |

- 「只关窗口」：窗口销毁，会话不动；发 `detach {sessionId}`，守护进程往群里补一句「电脑窗口已关，手机照常可发」（只在会话还活着时发）。
- 「结束会话」：发 `close {sessionId}` → 现有 `closeSession(..., {reason:'窗口关闭', notify:true})`，群发「会话已结束」。
- 群解散 / 手机结束：广播的 `session.status` 变成 `closed` → 窗口盖一层「会话已结束」，3 秒后自动关闭。
- PTY 崩溃：`status === 'error'` → 盖一层「进程退出了」+「重来」按钮；点「重来」发 `restart {sessionId}`，成功后再 `attach` 一次。`interrupted`（电脑重启过）同样给「接回」按钮。
- 窗口里收到 `error` 消息：状态栏显示错误文本，不弹系统对话框（避免打断输入）。

## IPC 协议增量（只有两条）

守护进程 `handleClientMessage` 新增：

- `restart {sessionId}` → `manager.restartSession(id)`：
  - 记录不存在 → 回 `{type:'error', message:'会话不存在'}`；
  - 会话仍活着（`sessions.has(id)` 且状态不是 `error`/`interrupted`）→ 回 `{type:'restarted', sessionId, ok:true}`，不重复拉 PTY；
  - 否则 `revive(store.get(id))`，按返回值回 `{type:'restarted', sessionId, ok}`。
- `detach {sessionId}` → `manager.notifyDetached(id)`：会话活着时往群发「电脑窗口已关，手机照常可发」，回 `{type:'detached', sessionId}`；会话不存在/已结束就静默回 ok（窗口已经要关了，不值得报错）。

这两条是验收第 5、8 条要求的（只关窗口要告知群里、崩溃要能重来），上游「不需要改协议」指的是不需要新增数据通道，不是一条消息都不能加。协议版本仍兼容旧窗口：未知类型本来就回 `error`，新窗口对旧守护进程会收到未知类型错误，此时窗口降级为只关窗口、不弹「重来」。

## 会话恢复边界

窗口断开不触发任何会话状态变化（守护进程不跟踪窗口连接）。Electron 被强杀时 PTY 继续跑，重开窗口 `attach` 即可接回——这正是「镜像窗口」的语义。上游 §8 的「窗口断开 10 分钟后收掉孤儿 PTY」不在本次验收里：它需要一个跨窗口的连接计数与定时器，且误杀风险高。本次不做，记入已知限制。

## 安全

渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，preload 只暴露：

```js
window.bridge = {
  input(data), resize(cols, rows), restart(), detach(), closeSession(),
  pickerAction(item), chooseDir(), onEffect(cb), onMeta(cb),
}
```

页面加 CSP（`default-src 'self'`，脚本只允许本地文件），不加载远程内容。窗口侧只连 `127.0.0.1`，token 从 `state/ipc.json` 读，和 hook 一致。

窗口不上报任何东西到网络；xterm 的 `allowProposedApi` 保持默认关闭。

## 打包

- 开发期：`npm run window`（`electron .`，根 `package.json` 的 `main` 指向 `app/main.js`；`npm start` 显式跑 `node bin/daemon.js`，不受影响）。
- 交付：`npm run pack` 用 `@electron/packager` 打 `dist/feishu-bridge-window-win32-x64/`，图标沿用仓库现有资源（若无可先用 Electron 默认图标，README 由另一个 agent 负责，不动）。
- 打包只带 `app/` + `node_modules` 里的 `ws`、`@xterm/*`；`node-pty` 不参与窗口打包。

## 不做

- 窗口内的群管理（改名、结束别的会话）——回手机或现有总控面板。
- 多标签页——一个会话一个窗口，符合验收「三次双击三个窗口」。
- 断开窗口 10 分钟回收 PTY（见上）。
- 自动更新。
