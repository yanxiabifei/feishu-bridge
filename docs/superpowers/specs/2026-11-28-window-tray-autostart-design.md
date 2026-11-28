# 窗口常驻：托盘 / 开机自启 / 手机建群弹窗

**目标**：把桌面窗口从「按需启动、关窗即退」改成「开机常驻、关窗收进托盘、手机建群能接上」。判据是**不容易被误关、开机就在、手机建群能接上、死了能被发现**，而不是**关不掉、杀不死**。

**不做**：

- 杀不死 / 防任务管理器。不现实，也会被当成流氓软件。
- 硬扛用户取消开机自启。托盘勾掉就是勾掉，重启后不再自启。
- 两套代码路径。常驻和按需是同一个进程，行为按「窗口在线 / 离线」切换。

## 一、在线判据：不新做心跳

`src/ipc.js` 已有 `clients` 集合 + 30 秒 ping/pong（漏回 pong 直接 `terminate`），窗口断电/休眠后连接会被筛掉。本次只把它暴露出来：

```js
resolve({ port, broadcast, send, clientCount() { return clients.size; }, close })
```

同时补上 `onClientClose(ws)` 回调（daemon 目前只注册了 `onHookStop` / `onClientMessage`），用于记一条结构化日志，排查「窗口什么时候断的」。

## 二、关窗语义

- `window-all-closed` 订阅成空操作。Electron 只在**没有订阅者**时默认退出，订阅了就不退。
- 托盘常驻，菜单：`打开选择器` / `开机启动`（checkbox）/ `退出`。
- 会话窗口的 close 仍然走二选一确认框（结束会话 / 只关窗口），不改。
- **托盘「退出」是唯一的真退出路径**：先置 `quitting = true`，`onSessionClose` 见到它就跳过确认框并 `destroy`，否则用户点了退出还会被一串「是否结束会话」的框挡住。
- 会话窗口点 × 不是「关窗就没了」——确认框照旧，选「只关窗口」窗口销毁，但进程留在托盘里。这是本次的行为变更：以前关掉最后一个窗口 = 退出。

## 三、开机自启

打包产物是免安装文件夹（`npm run pack` → `dist/<name>-win32-x64/`），没有安装器可挂「安装时注册」。所以：

- **打包版首次运行**（`app.isPackaged`）写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `FeishuBridge.Window`，内容是 `"<exe>" --hidden`。
- **开发模式（`npm run window`）一律不碰注册表**，托盘里的勾选框显示为未勾选且禁用。
- 托盘勾选框 = 注册表项的增删，`reg add` / `reg delete`，写失败只在托盘上静默保持原状并记一条 warn。
- daemon 的计划任务（`scripts/autostart.js`）是另一套机制，互不影响。

## 四、手机建群弹窗

已有一半：`src/session/manager.js` 每次落盘事件都广播 `{type:'session', session}`，`app/main.js onSessionMessage` 收到 **新的 ACTIVE 会话**就 `openSessionWindow`。本次补的是「常驻进程」和「抢前台」：

- 进程常驻（第二节），才谈得上「弹」。
- `raiseWindow(win)`：`restore()` → `show()` → `setAlwaysOnTop(true)` → `focus()` → `setAlwaysOnTop(false)`。Windows 上光 `focus()` 不会把窗口从别的窗口后面拔到最前，`setAlwaysOnTop` 一开一关才稳。
- 会话窗口已经开着（用户最小化了）时，同上，只是不重建。

## 五、离线兜底（**偏离原规格**）

原规格：daemon 发系统通知「手机建了新会话，点此接入」，点击拉起窗口。

**改为：daemon 直接拉起窗口并带上 `--session <id>`。**

理由：

1. Windows 原生 toast 需要 AUMID + 开始菜单快捷方式 + 协议注册（`feishu-bridge://`），或者引 `node-notifier`（还要处理 asar unpack），都是新依赖和一串边角。
2. 结果等价且少一步：用户的目标是「手机上建了群，电脑上就接着那个会话」，而不是「收到一个通知」。通知点一下才到的地方，直接到更好。
3. 零新依赖：`spawn(exe, ['--session', id], { detached: true, stdio: 'ignore' }).unref()`。

细节：

- `clientCount() > 0` → 什么都不做（在线的窗口已经会自己弹）。
- 离线 → 拉起。窗口进程已经在跑但连接断了 → 单实例锁会让它变成 `second-instance` 事件，`--session` 参数同样被处理，等于「顺手把它叫醒并接进该会话」。
- 30 秒冷却，避免拉起失败时每建一个会话都刷一次 spawn。
- 找不到窗口 exe（没打包、也没装 electron）→ 记一条 `window.launch_skipped`，手机侧照常可用（会话本身不受影响）。
- 开关：`config.windowAutoLaunch`（默认 `true`），写成 `false` 就退回「纯按需」。

## 六、窗口 exe 怎么找

daemon 需要知道窗口进程在哪：

1. 打包版启动时把 `process.execPath` 写进 `state/config.json` 的 `windowExe`（只在打包版写，dev 不覆盖）。
2. daemon 读 `config.windowExe`；空着且 `node_modules/electron/dist/electron.exe` 存在，就用它 + 仓库根目录（dev 兜底）。
3. 都没有 → 跳过。

写 config 的路径解析和 `state/ipc.json` 同一套：新增 `locateStateDir()`，复用 `endpointFile` 的候选顺序，取第一个**存在**的 `state` 目录。

## 七、启动时序竞态（读代码时发现的现存 bug）

开机自启时窗口进程可能比 daemon 先起来。现在 `createClient()` 读不到 `state/ipc.json` 就 `return null`，之后没有任何重试路径，界面永远停在「连接断开」，除非用户手动点「重连」。

改法：**永远构造 daemon 客户端**。`client.js` 的 `url()` 每次（重）连都会重新读端点，端点不存在时它自己会 `scheduleReconnect()`。`endpointError` 降级为「提示文案」，不再代表「没有客户端」。

## 八、参数

- `--hidden`：开机自启时不弹选择器，只留托盘（避免开机就被窗口糊一脸）。
- `--session <id>`：起来后直接打开该会话窗口。
- `second-instance` 里同样解析，因为第二次启动只会把 argv 交给第一个实例。

参数解析放在 `app/lib/launchArgs.js`，纯函数，可单测。

## 九、测试

- `app/lib/launchArgs.js`：`--hidden` / `--session id` / `--session=id` / 脏参数。
- `app/lib/startup.js`：注册表命令拼装（注入 exec，不真的写注册表）。
- `src/windowLaunch.js`：何时拉起、何时跳过（在线 / 冷却 / 无 exe）、命令拼装。
- `src/ipc.js`：`clientCount()` 随连接增减；`onClientClose` 被调用。
- `src/session/manager.js`：`onSessionCreated` 在手机建群和电脑新建后各触发一次，回调抛错不影响建会话。
