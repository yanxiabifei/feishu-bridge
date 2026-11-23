# 飞书双向 AI 终端桥（feishu-bridge）设计规格

- 日期：2026-11-23
- 状态：待评审
- 目标平台：Windows 11（本机），手机端只用飞书 App

---

## 0. 一句话

在你电脑上常驻一个小服务，把**本地 Claude Code / Codex 会话**同时接到「电脑上的独立窗口」和「飞书里的一个群」两个视图上。任一端说的话进同一个进程，进程说的都同时出现在两端。不经过任何境外服务器。

---

## 1. 目标与非目标

### 必须做到

| # | 要求 |
|---|---|
| G1 | 手机飞书 ↔ 电脑窗口是**同一个会话**，双向实时同步，不是接力、不是转述 |
| G2 | Claude Code 和 Codex CLI 两种壳都要支持 |
| G3 | 电脑桌面图标**可以重复点、开多个窗口**，每个窗口做不同的任务，互不干扰 |
| G4 | 手机拉群 @机器人 = 电脑开一个新窗口；电脑开新窗口 = 手机自动收到一个新群 |
| G5 | 任一端结束（手机解散群 / 电脑关窗口）另一端同步结束 |
| G6 | 只依赖飞书开放平台，不使用境外中转 |
| G7 | 两端都用自然语言，**不需要记任何命令** |
| G8 | 全自动权限：一切操作直接执行，不弹审批 |

### 明确不做

- 不接管你现有 Windows Terminal 里跑的 claude 会话（两条路并行，互不干扰）
- 不用 WSL
- 不做多人协作 / 团队共享 / 云端托管
- 不做移动端原生 App
- 不做模型选择 UI（沿用你 `~/.claude/settings.json` 的现有配置）

---

## 2. 已确认的前提与硬约束

| 约束 | 后果 |
|---|---|
| Windows Terminal / conhost **无法附加到别人创建的 ConPTY** | 电脑端的镜像窗口必须是自建程序，不能是你现在的终端窗口 |
| 飞书长连接**一个应用只能有一个连接**（多进程会随机丢事件） | 必须有且只有一个常驻 daemon 独占飞书 WS，窗口程序只是它的客户端 |
| 一个会话只能有一个壳，Claude 会话不能被 Codex 续接 | 会话记录里绑定 `agent` 字段，不可中途切换 |
| 终端 PTY 输出是 TUI 重绘流（ANSI、光标移动、截断、spinner） | 飞书正文**不能**直接抓屏幕，必须另有干净来源 |
| Claude 会话状态由 UI 独占，OS 没提供「第二扇门」 | 只有一种架构成立：**daemon 持有 PTY，两端都是查看器** |

**用户已接受的三个前提**：daemon 常驻后台（无窗口、无托盘图标）；电脑必须开着；一个会话对应一个项目目录。

---

## 3. 总体架构

### 3.1 两个进程

```
┌─────────────────────────────── 电脑 ───────────────────────────────┐
│                                                                    │
│   ┌──────────────────── daemon（单例，无窗口，开机自启）──────────┐   │
│   │                                                              │   │
│   │   FeishuWS  ←长连接→  飞书开放平台                            │   │
│   │      │                                                       │   │
│   │   SessionTable ──┬── PTY #1 (claude, D:\★CardGame\demo44)     │   │
│   │   (内存+磁盘)     ├── PTY #2 (codex,  D:\tmp\scratch)          │   │
│   │                  └── PTY #3 (claude, D:\feishu-bridge)        │   │
│   │      │                                                       │   │
│   │   本地 WS (127.0.0.1:随机端口 + 令牌)                          │   │
│   └──────┼───────────────────────────────────────────────────────┘   │
│          │                                                          │
│   ┌──────┴─────── Electron 进程（一个进程，多个窗口）───────────┐      │
│   │  窗口A ── xterm.js ── PTY#1 画面                           │      │
│   │  窗口B ── xterm.js ── PTY#2 画面                           │      │
│   │  窗口C ── 项目选择器（点图标先出这个）                       │      │
│   └────────────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ 飞书消息 / 卡片
                        ┌─────┴─────┐
                        │  你的手机  │
                        └───────────┘
```

- **daemon**：唯一一个。独占飞书 WS、持有所有 PTY、维护会话表、提供本地 IPC。
- **Electron**：可多开窗口，但**只有一个 Electron 进程**（`requestSingleInstanceLock` + `second-instance` 事件，第二次双击就在同进程里再开一个 `BrowserWindow`）。所有窗口都是 daemon 的客户端。

### 3.2 G3 多窗口的具体实现（用户最后一问）

| 动作 | 发生什么 |
|---|---|
| 双击桌面图标第 1 次 | 若 Electron 没在跑 → 起进程 → 弹出「选项目」面板 → 选定后开窗口 A，同时 daemon 新建 PTY#1 + 飞书建群 |
| 双击第 2 次 | Electron 已在跑 → `second-instance` 触发 → 再弹一个「选项目」面板 → 开窗口 B，daemon 新建 PTY#2 + 再建一个飞书群 |
| 双击第 N 次 | 同上，**没有数量限制**（受内存约束，实测几十个没问题） |
| 窗口 A 里的 claude 在跑任务，同时窗口 B 里的 codex 在跑别的 | 两条 PTY 完全独立，两个飞书群也独立 |
| 关掉窗口 B | 弹两选（语义见 §8）：选「结束会话」才 kill PTY#2 并结束对应的群；选「只关窗口」则会话留在后台，A/C 不受影响 |
| 关掉「选项目」面板 | 什么都不创建，干净退出 |

**结论：满足「重复点、开多个、各做各的」的要求，且不需要任何额外设计——这是「daemon 持有会话、窗口只是视图」这个架构的直接结果。**

---

## 4. 会话模型

### 4.1 会话记录

一个会话 = 一条记录，落盘为 `D:\feishu-bridge\state\sessions.json`（原子写：先写 `.tmp` 再 `rename`）。

```json
{
  "id": "s_20261123_214012_a3f9",
  "agent": "claude",
  "cwd": "D:\\★CardGame\\demo44",
  "alias": "卡牌",
  "chatId": "oc_xxxxxxxx",
  "chatName": "卡牌 · 11-23 21:40",
  "claudeSessionId": "2e7b1fc8-...",
  "transcriptPath": "C:\\Users\\<用户名>\\.claude\\projects\\...\\2e7b1fc8-....jsonl",
  "ptyPid": 12345,
  "status": "idle",
  "createdAt": "2026-11-23T21:40:12+08:00",
  "lastActiveAt": "2026-11-23T21:43:05+08:00",
  "inputSeq": 7,
  "lastInput": { "seq": 7, "origin": "phone", "text": "现在几点", "at": "2026-11-23T21:43:00+08:00" }
}
```

- **主键 `chatId`**：飞书群 ID。一个群只能对应一个会话；一个会话只能有一个群。
- `inputSeq`：会话内输入序号，每往 PTY 提交一次 +1（**不论来源**）。用途只有两个：① 会话内输入排序；② 把 Stop hook 推回来的回复与「触发它的那条输入」配成一对（见 §6.2 双向推送）。**不用于 transcript 去重**——输出路径已经不走 transcript 读了，去重需求不存在。
- `lastInput`：最近一次提交给 PTY 的内容与来源（`phone` / `pc`）。判断来源靠 daemon 自己记录，不靠反解析 transcript：daemon 是 PTY 的唯一写入方，谁写的一清二楚。
- `transcriptPath` 由 Stop hook 回调直接给出（精确）；拿不到时按 `encodeCwd(cwd)` 规则扫目录兜底。

### 4.2 状态机

```
starting ──> idle ──> running ──> idle
   │           │          │
   │           │          └──> error（进程崩溃，可 /resume 重来）
   │           └──> closing ──> closed     （关窗口 / 解散群）
   └──> error（起不来：目录不存在、CLI 未登录）
```

- `running`：已向 PTY 写入、尚未收到该轮 Stop 回调。
- `closing`：已经发出 kill，等 PTY 退出（超时 5s 强制 kill）。
- `interrupted`：daemon 重启或 Electron 崩溃后发现的残留会话（见 §8）。

### 4.3 存储布局

```
D:\feishu-bridge\
├─ state\
│  ├─ config.json        应用凭据 + 全局偏好（App Secret 单独文件，不在这里）
│  ├─ secret.bin         App Secret（DPAPI 加密）
│  ├─ projects.json      项目别名表
│  ├─ sessions.json      会话表（原子写）
│  ├─ ipc.json           daemon 的端口 + 令牌（每次启动重写）
│  ├─ hooks\             每会话一个 <sessionId>.hook.json（会话关闭即删）
│  └─ media\<chatId>\    手机发来的图片/文件下载缓存
└─ logs\
   └─ 2026-11-23.jsonl   结构化日志（脱敏）
```

日志与 `state` 目录在 C 盘之外，符合「大文件不落 C 盘」的既有约定。

---

## 5. 唤起：两条入口

### 5.1 手机 → 电脑

```
1. 手机飞书里新建一个群（只有你自己 + 机器人）
2. @机器人 说第一句话，例如「卡牌 帮我看看地形系统的乱流判定」
3. 飞书事件 → daemon：未登记的 chatId
4. 解析首句：
   ├─ 首词命中别名表「卡牌」 → cwd = D:\★CardGame\demo44
   ├─ 首词是盘符路径（如 D:\foo） → cwd = 该路径（不存在则报错并回一条卡片）
   └─ 都没有 → cwd = 默认目录 D:\feishu-workspace（不存在则自动创建）
5. daemon 起 PTY：claude（或 codex）在 cwd 下、bypassPermissions
6. Electron 收到 `session.created` → 新窗口弹出，标题「卡牌 · 11-23 21:40」
7. 群里回一条卡片：「已开工 · 卡牌（D:\★CardGame\demo44）」+ 消息已进队
```

- 机器人自动把**建群的人**拉进来（若不是你，忽略该群，见 §10）。
- 电脑没开机 / daemon 没跑 → 消息发出去没有回应，这是已知限制（飞书侧无法感知），在手机端表现为「机器人不发话」。

### 5.2 电脑 → 手机

```
1. 双击桌面图标
2. Electron 弹出「选项目」面板：
   [ 最近使用 ]
     卡牌        D:\★CardGame\demo44      刚刚
     临时草稿     D:\feishu-workspace      昨天
   [ 其他目录… ]  [ 选择 claude / codex ]
3. 选定 → daemon：
   ├─ im.chat.create 建群，名字「<别名> · MM-DD HH:mm」
   ├─ 把你自己邀请进群
   ├─ 起 PTY
   └─ 群里发「会话已创建，可以从手机说话了」
4. 窗口标题显示群名，底部状态栏显示「已同步 · 卡牌 · 11-23 21:40」
```

- 完全不记命令；面板本身可以用键盘方向键 + 回车。
- 窗口 A 已经开着时再双击图标，出的是同一个面板，选中就是新窗口（见 §3.2）。

---

## 6. 消息同步

### 6.1 输入方向（两端 → 同一个 PTY）

| 来源 | 处理 |
|---|---|
| 飞书群消息 | 去掉 @机器人 的前缀 → 写入 PTY |
| 电脑窗口里敲键盘 | xterm.js `onData` → 逐键写 PTY（原生，无转换）；daemon 在收到 `\r` 时从 headless buffer 的 `❯` 行取出这一行，记为 `lastInput{origin:"pc"}` |

- 写入用 bracketed paste 包裹多行：`\x1b[200~<text>\x1b[201~` 再补 `\r`，避免多行在 Claude Code 里被拆成多次提交。
- **发送前校验**：daemon 维护一个 headless xterm（`@xterm/headless`），把 PTY 输出喂进去，随时能拿到「当前可见画面」。注入前先判断是否处于输入框状态（底部出现提示符、且没有菜单/弹窗特征）。
  - 在输入框 → 直接写。
  - 不在（例如 `/help` 卡片、`/login` 提示、进程已退出）→ **不盲写**，改为往群里推一张「当前画面」卡片，附「仍然发送」按钮，点了才写。
  - 这条是 v1 就做的，不是后续优化——它是手机端盲写唯一的护栏。
- 飞书发来的图片/文件（`im:resource` 下载到 `D:\feishu-bridge\state\media\<chatId>\`）→ 写入一行本地绝对路径 + 用户文字，让 CLI 自己读。

**飞书长连接的 3 秒硬时限（必须显式设计）**：官方要求事件回调在 3 秒内返回且不抛异常，否则触发重推。所以 daemon 收到 `im.message.receive_v1` 后**只做「入队 + 立即 ack」**——文本解析、屏幕状态判断、PTY 写入、卡片发送全部丢进异步队列，回调本身立刻返回。重推用 `event_id` 去重（内存里保留最近 1 小时的 id）。建群、写 `sessions.json`、调飞书 API 这些慢操作一律不在回调里做。

**队列规则（按会话串行、PTY 未就绪先缓存）**：

- 每个会话一条 **FIFO** 队列。手机连发三条，就是队列里的三条，**永远按到达顺序注入**，不并发写 PTY（并发写会把两句话粘成一句，或让 bracketed paste 的起止标记交错）。
- 每个会话同时只有一条「在途」：注入后等该轮 Stop 回调（或超时）再放行下一条。**不并发，也不合并**——合并会改变用户原话。
- **PTY 未就绪**（正在 spawn、正在处理信任对话框、首屏还没出来）时，消息只入队不写盘不丢弃；`idle` 后自动按序排空。这与「先校验输入框状态」不冲突：未就绪期间连校验都做不了，所以是纯缓存。
- 队列上限 20 条/会话。超过则**不再入队**，在群里回一句「积压了 20 条还没处理完，稍后再发」，避免用户以为消息进去了。
- 会话被结束（kill PTY）时，队列里剩余消息全部丢弃，群里提示「N 条未处理的消息已丢弃」。

### 6.2 输出方向：Claude（助手回复 + 用户输入，双向推送）

**助手回复的来源是 Stop hook，不是屏幕也不是读 transcript。**

```
daemon 起 claude 时带 --settings D:\feishu-bridge\state\hooks\<sessionId>.hook.json
  该文件只包含一个 Stop hook：
    { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
        "command": "node \"D:\\feishu-bridge\\bin\\hook-stop.js\"" } ] } ] } }
claude 每轮结束 → hook 收到 stdin JSON → 取 last_assistant_message
              → POST 到 daemon 的本地端口 → daemon 配上一轮的用户输入 → 推送到飞书
```

**每一轮推送什么（已定：问答一起推）**。G1 要求「双向实时同步」，§12 第 3 条的验收写的是「电脑窗口里敲「现在几点」→ 手机群里收到这条**问答**」。所以每轮 Stop 推的是一对：

| 部分 | 来源 | 标注 |
|---|---|---|
| 用户输入 | daemon 自己记的 `lastInput`（手机来源=飞书原文；电脑来源=按 `\r` 时从 headless buffer 取出的 `❯` 行） | 电脑敲的加一个 `🖥` 前缀，手机上发的不加 |
| 助手回复 | Stop hook 的 `last_assistant_message` | 正文 |

- 手机发的消息，飞书客户端本来就会显示你自己发的那条，所以卡片里**不再重复用户输入**，只推回复；电脑敲的输入，手机端看不到，所以**必须推**。这是唯一需要区分来源的地方，也是 `lastInput.origin` 存在的理由。
- 输入为空（只按了回车）不推。斜杠命令（`/clear`、`/compact`）按普通输入推，群里能看到「🖥 /compact → 已压缩」。
- 用户按 Esc 打断时 Stop hook 是否照样触发、`last_assistant_message` 里是什么，**尚未实测**。v1 先按「headless buffer 里出现 `Interrupted` 字样」判定，命中就推「（已打断）」；实测后再改成 Hook 字段判断。

**实测证据（2026-11-23，交互式 TUI，不是 `-p`）**：在纯 Node 进程里用 `node-pty` 起 `claude --settings <只含 Stop hook 的文件>`，跑两轮对话，第一轮带工具调用（`列出当前目录的文件` → 触发搜索），第二轮纯文本（`只回复两个字：好的`）。结果：

```json
{"hook_event_name":"Stop","session_id":"4b5e8d7b…","last_assistant_message":"当前目录下的文件：\n\n- `a.txt`\n- `b.txt`\n- `c.txt`\n\n共 3 个文件，没有子目录。"}
{"hook_event_name":"Stop","session_id":"4b5e8d7b…","last_assistant_message":"好的"}
```

四条结论：
1. **交互式 TUI 下 Stop hook 每轮都触发**，两次轮次 → 两个 hook 调用，`session_id` 相同（不是只在进程退出时触发一次）。
2. **`last_assistant_message` 是干净的最终文字**，工具调用的中间过程（搜索、Bash 输出）不在里面。
3. **`--settings` 在交互式模式下同样深合并**，全局 DeepSeek 端点保留（模型仍为 `deepseek-flash`）。
4. 该字段在 `-p` 模式（早前实测）与 TUI 模式下行为一致。

`transcript_path` 在 stdin 里也有，只作兜底（hook 丢包或该字段为空时再去读文件），不进主路径。

- 用 `--settings` 是为了**不碰你的全局 `settings.json`**。降级开关仍保留：若未来某个版本变成整体覆盖（症状是启动即报鉴权失败），改用「全局 `settings.json` 追加 hook + `session_id` 白名单过滤」，白名单外的直接退出，零副作用。5 行的逃生门，不预先实现。
- **为什么不用屏幕**：Claude Code 的 TUI 会截断（`… +23 lines`）、换行、刷色、滚出缓冲区，而且「屏幕不动了」不等于「这轮结束了」（spinner 和 `Thinking… 12s` 计时器一直在动）。Stop hook 给出精确的轮次边界，`last_assistant_message` 给出精确的正文。

### 6.3 输出方向：Codex

v1 用**终端画面序列化**：`@xterm/headless` 拿可见区文本 → 去掉 ANSI → 作为纯文本推送，附一个「查看完整画面」按钮（返回最近 200 行）。

事实分两层，不能混：

- **已知**：Codex CLI 的会话记录惯例路径是 `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl`，JSONL 格式。
- **本机实测（2026-11-23）**：`C:\Users\<用户名>\.codex\` 存在，但**没有 `sessions\` 目录**。里面有 `config.toml`、`logs_2.sqlite`(4.3MB)、`goals_1.sqlite`、`.codex-global-state.json`、`computer-use\`、`.sandbox\`。也就是说这台机器上的 Codex 还没产出 rollout 文件，而且它的本地存储看起来是 sqlite 而非纯 JSONL 目录——版本可能与公开文档不一致。

所以结论不变但理由换了：**不是「路径不存在」，而是「本机实际布局与公开文档不符，且无样本可验证 record 结构」**，因此不能写进 v1 关键路径。v1 用画面序列化兜底；第一次跑通 Codex 后立刻实测其落盘位置与结构（`codex exec` 已确认支持 `resume`），能升级就升级成和 Claude 同一套。

### 6.4 手机端长什么样

- 一轮结束 → 一张卡片：正文 markdown + 一行工具摘要（`🔧 改了 3 个文件 · Bash×2`）。
- 若这条回复是**电脑窗口里敲的**触发的，卡片顶部多一行 `🖥 你刚在电脑上问：现在几点`（手机发的消息飞书自己会显示，不重复）。
- 期间 → 卡片先出「正在处理…」，Stop 时原地定稿（`cardkit:card:write`）。
- 正文超过 8000 字 → 截断 + 「完整内容发文件」。

---

## 7. 工作目录与项目别名

`state/projects.json`：

```json
{
  "aliases": {
    "卡牌": "D:\\★CardGame\\demo44",
    "桥":   "D:\\feishu-bridge",
    "草稿": "D:\\feishu-workspace"
  },
  "default": "D:\\feishu-workspace",
  "recent": [{ "path": "D:\\★CardGame\\demo44", "at": "2026-11-23T21:40:12+08:00" }]
}
```

- 首次启动扫描 `~/.claude/projects/` 的近期目录，自动生成 `recent`（只列路径，不猜别名）。
- 新增别名：电脑端「选项目」面板里有「记成别名…」；手机端可以在群里直接说「把这个目录记成 X」——但这属于**自然语言配置**，交给主模型执行太绕，v1 做法是**手机端也能通过一张设置卡片改**（列出全部别名，点一行改名）。不做对话式配置。

### 7.1 首句解析规则（唯一一种理解）

按顺序试，命中即停：

1. 取消息文本，去掉开头的 `@机器人` 提及，`trim`。
2. 若前 1~6 个字符**完全等于**某个别名 → 该别名，剩余文本作为提示词。
3. 否则若第一个 token 匹配 `^[A-Za-z]:[\\/].+` 且路径存在 → 该路径，剩余文本作为提示词。
4. 否则 → 默认目录，**整条文本**作为提示词。

不做模糊匹配、不做大小写归一以外的猜测。别名只在**建会话的第一条消息**里生效；后续消息一律当作提示词，不重新解析目录。

---

## 8. 生命周期与异常

| 场景 | 行为 |
|---|---|
| 手机解散群 | `im.chat.disbanded_v1` 事件 → kill PTY → 窗口显示「会话已结束」并 3s 后自动关 |
| 手机解散群（事件丢了） | daemon 每 30s 抽检非 idle 会话的 `im.chat.get`，返回不存在即按上一条处理 |
| 电脑关窗口 | 弹两选：**结束会话**（默认）/ 只关窗口。结束 → kill PTY + 群里发「会话已结束」；只关窗口 → 会话留在后台，群里提示「电脑窗口已关，手机照常可发」。`running` 时默认按钮改成「取消」，防误触 |
| 机器人被移出群 | 等同解散 |
| PTY 进程崩溃 | 状态转 `error`，群里发「进程异常退出（code）」，窗口保留并给「重来」按钮（`--resume`） |
| Electron 进程被杀 | daemon 检测到 IPC 断开 → 会话转 `interrupted`，PTY 保留 10 分钟；期间再点图标可「接回」；超时则 kill + 群里提示 |
| daemon 重启（开机/崩溃自恢复） | 读 `sessions.json`：PTY 已不在 → 全部转 `interrupted`，群里逐条提示「电脑重启了，回一条消息我就接上」；收到该群消息时用 `--resume <claudeSessionId>` 重建，重建的四个动作见下 |
| PTY 空闲超时 | v1 不启用（你选了全自动，超时杀进程属于多余的限制） |

**`--resume` 重建会话必须做的四件事**（新进程不会继承任何旧进程的状态）：

1. **重新校验 `cwd`**：`fs.existsSync(cwd)` 且是目录。目录被移动/删除 → 不 resume，群里回「原目录 `X` 已不存在，无法恢复这个会话；要不要换个目录重开？」并给两个按钮。**不允许静默失败**。
2. **重新注入 `--settings` 和 hook 文件**：`--resume` 起的是新进程，旧的 `--settings` 参数已随进程消失。必须重新写 `state\hooks\<sessionId>.hook.json`（文件在重启后可能已不存在）并把路径重新传进命令行，否则恢复后的会话**照常干活但一条都不推回飞书**——这是最隐蔽的失效模式。
3. **重新预写信任标记**：新机器状态或目录权限变化可能让信任对话框重现，resume 前重新确认 `~/.claude.json` 里 `projects[cwd].hasTrustDialogAccepted === true`（见 §12 第 0 条）。
4. **校验 `claudeSessionId` 可用**：`--resume <id>` 的会话若已被清理（transcript 被删、`/clear` 后 id 变了），claude 会以非零码退出。捕获后回群里提示「上次的对话记录不在了，改用新会话重建」，然后不带 `--resume` 重开，并更新 `sessions.json` 里的 `claudeSessionId`。

**Electron 与 daemon 的生命周期是分开的两件事**：走了「只关窗口」这条路的会话，窗口没了但 PTY 还活着；所有窗口都没了 Electron 进程自己退出，daemon 照常活着——手机还能发消息。下次双击图标时，Electron 从 `state/ipc.json` 连回 daemon，拉出存活会话列表，问你「接回已有的 N 个会话，还是开一个新的？」。任务栏图标只代表 Electron 在不在，**不代表会话在不在**。会话结束只有两个入口：关窗口时选「结束会话」，或手机解散群。

**autoDisband（机器人主动解散群）**：默认关闭。飞书解散他人建的群需要 `im:chat` 写权限且行为不可逆，误杀代价高。默认只发「会话已结束」，群留给你手动删。

---

## 9. 飞书应用配置

自建应用，**长连接（WebSocket）模式**，不需要公网 IP、不需要端口映射。

### 权限（scope）

| scope | 用途 |
|---|---|
| `im:message` | 收发消息 |
| `im:message:send_as_bot` | 以机器人身份发 |
| `im:message.group_at_msg:readonly` | 接收群里 @机器人 的消息 |
| `im:message.p2p_msg:readonly` | 接收单聊（做总控面板） |
| `im:chat` | 建群、查群、邀请人、解散 |
| `im:resource` | 下载图片/文件 |
| `cardkit:card:write` | 流式卡片（原地更新） |

### 事件订阅

| 事件 | 用途 |
|---|---|
| `im.message.receive_v1` | 必需 |
| `im.chat.disbanded_v1` | 解散同步 |
| `im.chat.member.bot.added_v1` | 被拉进群时可以主动自我介绍 |

### 建应用步骤（需要你做的事）

1. 飞书开放平台 → 创建企业自建应用
2. 加「机器人」能力
3. 权限按上表开通 → 创建版本 → 发布（自己能审批自己）
4. 事件订阅选「长连接」→ 添加上述事件
5. 把 App ID / App Secret 给我（写进 `state/config.json` 与 `secret.bin`）

**账号问题**：用你现在手机上的飞书个人账号即可，个人也能创建企业（一个只有你自己的企业），不需要付费。之前那两个账号（豆包关联的、手机号的）用**日常用的那个**就行。

---

## 10. 安全

### 10.1 谁能用

- 只认 **owner open_id（你自己）**。其他人的消息一律静默丢弃，连「无权限」都不回（避免暴露机器人存在）。
- 只处理「owner 在场的群」和「daemon 自己建的群」。别人拉机器人进群 → 忽略。
- 单聊 = 总控面板（看会话列表、结束某个会话、改别名）。

### 10.2 凭据

- App Secret 用 Windows DPAPI（`CryptProtectData`，绑当前用户）加密存 `state/secret.bin`，明文只在内存里。
  - **依赖方式：不引原生模块。** 纯 Node 调 DPAPI 需要 FFI 或 `node-dpapi` 这类带原生编译的包，等于在加密存储上再踩一遍 node-pty 那类坑。改用系统自带的 PowerShell 走一遍：
    ```
    powershell -NoProfile -NonInteractive -Command
      "Add-Type -AssemblyName System.Security;
       $b=[Convert]::FromBase64String('<输入>');
       $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');
       [Convert]::ToBase64String($e)"
    ```
    解密同理用 `Unprotect`。输入输出一律 base64，避开控制台代码页把中文/二进制弄花。
  - **已实测（2026-11-23）**：roundtrip 正确，单次调用约 1.1 秒（含 powershell 启动）。只在 daemon 启动时调一次，不构成性能问题。
  - **兜底**：若 DPAPI 调用失败（PowerShell 被策略禁用等），不自己造加密——改为明文件 + `icacls` 把 `secret.bin` 的读权限限制到当前用户，并在启动日志里打一条「已降级」警告。安全边界是 Windows 账户本身，这比"用同一目录里的密钥加密"诚实。
- **永不写日志**。日志里出现 `app_secret` / `ANTHROPIC_AUTH_TOKEN` / `pushplus` 一律替换为 `***`。
- 本地 IPC 令牌：daemon 每次启动随机生成，写 `state/ipc.json`（ACL 只允许当前用户读），Electron 读取后带上才连得上。

### 10.3 全自动的边界

你明确选了 **B. 全自动**（`bypassPermissions`），意味着模型在群里说「删掉 D 盘」它就真删。这是你的决定，本设计**不添加任何审批环节**去违背它。本设计只做两件不冲突的事：

1. **手机盲写护栏**（§6.1）：不是在审批，只是保证消息不会写进一个错误的 UI 位置。
2. **审计日志**：每条注入的文本、每次 PTY 启动（含 cwd）、每次删除操作，都记一行到 `logs/`，事后可查。不做拦截。

---

## 11. 技术选型与依赖

| 用途 | 选型 | 理由 |
|---|---|---|
| PTY | `node-pty` | Windows 走 ConPTY；Win11 已实测可用（见 §12 第 0 条） |
| 屏幕快照/状态判断 | `@xterm/headless` + `xterm-addon-serialize` | 纯内存，无需渲染 |
| 电脑窗口 | **Electron** | Node 已装，不需要 Rust 工具链 |
| 终端渲染 | `xterm.js` + `xterm-addon-fit` | 事实标准 |
| 飞书 SDK | `@larksuiteoapi/node-sdk` | 官方，支持 WS 长连接 |
| 本地 IPC | `ws`（127.0.0.1 随机端口 + 令牌） | 简单，跨进程无坑 |
| 进程守护 | Windows 任务计划程序 `FeishuBridge.Daemon` | 登录自启、隐藏、崩溃 60s 重启 |

**Electron 安装风险**：从 GitHub 直连下载 Electron 二进制大概率超时。安装时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。若仍失败，兜底方案是「本地 HTTP 服务 + `msedge --app=http://127.0.0.1:port`」——外观接近独立窗口，但不如 Electron 干净，作为应急。

运行时依赖只有 Node（v24.17.0 已确认）。

**一个顺带的好处**：因为 PTY 由 daemon（纯 Node 进程）持有，Electron 侧**完全不加载 node-pty**，所以不需要 `electron-rebuild`、也不会遇到「Electron 里 ConPTY runtime 文件缺失」这类问题。窗口进程只依赖 `ws` 和 `xterm.js`，没有任何原生模块。这是拆两个进程的额外收益。

---

## 12. 验收标准

**第 0 条是前置门槛，不过就不写同步逻辑**：

0. **ConPTY 最小验证**（✅ 2026-11-23 已实测通过，Node v24.17.0 / Win11 / `node-pty` + `@xterm/headless` 6.0.0）：
   - ① 能进入交互界面 —— 通过，TUI 正常渲染，`deepseek-flash` 端点生效。
   - ② 能写入并提交一条输入 —— 通过，键盘输入逐字回显在 `❯` 提示行，`\r` 提交，15 秒内看到 `● 好的`。
   - ③ 输出喂进 `@xterm/headless` 能拿到干净的可见区文本 —— 通过，buffer 逐行 `translateToString(true)` 得到无转义序列的纯文本。
   - ④ 窗口 resize 生效 —— 通过，`term.resize(40,15)` + `pty.resize(40,15)` 后 buffer 行宽变为 40、claude 自动重绘。
   - **实测新增的两个坑，实现时必须处理**：
     - **信任对话框（主方案：提前写信任标记；对话框处理只做兜底）**：claude 首次在未信任目录启动会弹 `Do you want to trust this folder?`，默认高亮是 **`No, exit`**，此时回一个 `\r` 会直接退出（实测退出码 1）。
       - **主方案已实测有效（2026-11-23）**：在 `~/.claude.json` 的 `projects` 下写 `"D:/tmp/hook2/proj": { "hasTrustDialogAccepted": true, ... }`（路径用正斜杠，与 claude 自己的键格式一致）后启动，首屏 **2.5 秒就绪、完全没有信任对话框**。这是配置层面操作，不依赖 TUI 布局，Claude Code 换版本也不会失效。
       - 写法要求：读全量 JSON → 改 `projects[cwd]` → 写 `.tmp` → `rename` 覆盖（原子写，避免和正在运行的其他 claude 互相踩）。启动前做，不等对话框出现。
       - **兜底**：若仍有对话框（例如 claude 改了字段名），再扫首屏命中关键字后发 `\x1b[B` + `\r`。这条依赖 UI 布局，只当保险。
     - **路径分隔符**：`node-pty` 的 `cwd` 不能让反斜杠穿过 JSON/模板被转义（`D:\tmp` 里的 `\t` 会变成制表符，报 `error code 267`）。所有传给 `pty.spawn` 的路径一律用正斜杠或 `path.resolve()` 的结果。

以下按顺序逐条实测，全过才算完成：

1. 手机拉群 @机器人 说「卡牌 你好」→ 分两段计时：① **窗口弹出 ≤ 3 秒**（从发出消息到 Electron 窗口出现）；② **首屏可见 ≤ 8 秒**（claude TUI 渲染完成、`❯` 提示符出现）。→ 群里收到回复卡片。拆开计时的理由：claude 自身启动 + 首屏渲染实测在 2.5 秒量级（无信任对话框时），叠上窗口创建不能用一个「1 秒」去卡整条链路。
2. 手机再发「列出这个目录的文件」→ 电脑窗口里同步出现同一句话和 claude 的回答。**紧接着连发两条短的**（间隔 1 秒，第一条还没跑完）→ 两条按顺序执行、不粘连、不丢失。
3. 在**电脑窗口**里敲「现在几点」→ 手机群里收到这条问答。
4. 双击图标 3 次 → 3 个窗口 + 3 个飞书群，分别是不同目录，同时各跑一个任务不串话。
5. 关掉其中一个窗口 → 该群收到「会话已结束」，另外两个不受影响。
6. 解散一个群 → 对应窗口自己关掉。
7. 群消息里第一句写「草稿 帮我查一下 xxx」→ 自动落在默认目录，窗口标题是「草稿 · …」。
8. 把 claude 进程杀掉 → 群里收到异常提示，窗口给「重来」按钮，点了能继续。
9. 重启电脑 → daemon 自动起来 → 旧群发消息 → 自动 `--resume` 接回之前的对话。
10. Codex 会话跑通：手机建群说「临时草稿 用 codex 写个快排」→ 窗口里是 codex TUI，群里有输出。
11. 全程日志里 grep 不到 App Secret / ANTHROPIC_AUTH_TOKEN / pushplus token。

---

## 13. 已知限制（写出来是为了不事后惊讶）

1. **电脑必须开着**，手机端无法唤醒一台关机的机器。
2. **一个会话一个目录**，中途换目录等于开新会话（只能靠群里说「换个目录」触发重建，v1 不做）。
3. **Codex 的飞书正文是终端画面**，格式不如 Claude 干净，需等其 transcript 格式核实后升级。
4. **手机发消息时如果电脑端停在一个菜单里**，会走「先看画面再决定」的护栏，多一次点击，这是有意的。
5. **不能接管你已有的 Windows Terminal 会话**——那条路继续照常工作，只是不同步到手机。
6. **飞书群解散事件可能延迟或丢失**，所以有 30s 抽检兜底；极端情况下最坏延迟 30s。
7. 网络断开时飞书 WS 会重连，期间手机发的消息由飞书侧缓存，重连后补投；电脑端不受影响。
