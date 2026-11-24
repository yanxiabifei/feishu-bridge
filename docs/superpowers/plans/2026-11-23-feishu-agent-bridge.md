# 飞书双向 AI 终端桥 实现计划（Plan A：核心链路）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让手机飞书群与电脑上的 Claude Code / Codex 会话成为同一个进程的两个视图——手机发的话进 PTY，助手回复、电脑端敲的输入都推回手机群。

**架构：** 一个无窗口的常驻 daemon 独占飞书 WebSocket、持有全部 ConPTY、维护会话表；飞书事件先入队再异步处理（3 秒内 ack）；助手回复由 Claude 的 Stop hook 精确给出，不抓屏；屏幕只用于「手机盲写护栏」和 Codex 输出。

**技术栈：** Node v24.17.0（CommonJS）、node-pty 1.1.0（ConPTY）、@xterm/headless 6.0.0、@larksuiteoapi/node-sdk 1.77.0、ws 8.23.0、`node --test`。

---

## 0. 本计划的范围边界

规格全文见 `docs/superpowers/specs/2026-11-23-feishu-agent-bridge-design.md`。按 writing-plans 的范围检查，规格覆盖了两个可独立交付的子系统，因此拆成两份计划：

| 计划 | 覆盖 | 交付物 | 验收 |
|---|---|---|---|
| **Plan A（本文件）** | daemon、飞书收发、PTY、Claude/Codex 两种壳、双向同步、生命周期与 `--resume` 恢复、自启动 | 一个能跑的程序：**手机上就能完整使用**，只是电脑端没有图形窗口（daemon 在后台） | 规格 §12 第 1、2、3、6、7、8、9、10、11 条（第 3 条用本地 WS 客户端代入「电脑端敲键盘」） |
| **Plan B（A 通过后另写）** | Electron 单进程多窗口、项目选择面板、xterm.js 渲染、接回已有会话、关窗口两选 | `.exe` 图标，双击开窗 | 规格 §3.2、§5.2、§12 第 4、5 条 |

Plan A 先把**协议与语义**跑通（消息长什么样、一轮怎么算结束、群怎么建怎么散），Plan B 只加一层视图。Plan A 的 daemon 已经暴露完整本地 IPC，Plan B 的窗口不需要改 daemon 的协议。

**已完成的前置工作（不要重做）：**

- `package.json` 与 `node_modules` 已安装（`@larksuiteoapi/node-sdk@1.77.0`、`@xterm/headless@6.0.0`、`node-pty@1.1.0`、`ws@8.23.0`）。
- 规格 §12 第 0 条的四项 ConPTY 实测已通过，`node-pty` 在本机可编译/加载。
- 两个实测结论已写进规格：交互式 TUI 下 Stop hook 每轮触发且 `last_assistant_message` 干净；预写 `hasTrustDialogAccepted` 可完全免掉信任对话框。

---

## 1. 文件结构（先锁定分解，再写任务）

```
D:\feishu-bridge\
├─ package.json                     依赖与脚本（已存在）
├─ bin\
│  ├─ daemon.js                     进程入口：装配所有模块、信号处理、单实例
│  ├─ setup.js                      配置向导命令行入口（npm run setup）
│  └─ hook-stop.js                  Claude Stop hook 客户端（被 claude 以子进程调用）
├─ src\
│  ├─ paths.js                      全部路径常量 + ensureDirs()
│  ├─ log.js                        JSONL 审计日志 + 脱敏
│  ├─ secrets.js                    App Secret 存取（DPAPI，失败降级为明文+ACL）
│  ├─ config.js                     config.json 读写与默认值
│  ├─ store.js                      sessions.json 原子读写
│  ├─ projects.js                   projects.json：别名表 + 默认目录（缺失/损坏给默认值）、改名
│  ├─ control.js                    私聊总控面板：会话列表 / 结束会话 / 改别名（不碰 PTY）
│  ├─ screen.js                     @xterm/headless 封装：可见区文本 / 输入行 / 是否可写
│  ├─ ipc.js                        本地 HTTP(hook) + WebSocket(窗口) 服务 + ipc.json
│  ├─ setup.js                      配置向导：校验凭据、测发消息/建群/长连接、写 config 与密钥
│  ├─ feishu\
│  │  ├─ api.js                     飞书 HTTP：token 缓存、发消息、建群、查群、下载、CardKit
│  │  ├─ cards.js                   卡片 JSON 构造（处理中 / 定稿回复 / 画面 / 提示）
│  │  ├─ events.js                  飞书事件载荷解析：文字/富文本/图片/文件、卡片回调、群事件
│  │  └─ ws.js                      长连接适配 + 3 秒快速 ack + 事件去重
│  ├─ agent\
│  │  ├─ launcher.js                claude/codex 启动参数、hook 文件、信任预写
│  │  └─ tools.js                  从 transcript 末尾统计本轮工具调用（摘要行用）
│  └─ session\
│     ├─ queue.js                   每会话 FIFO，一条在途
│     ├─ router.js                  首句解析（别名 / 盘符路径 / 默认目录）
│     ├─ ptySession.js              一个会话的运行态：pty + screen + queue + 状态机
│     └─ manager.js                 编排：建会话、注入、推送、关闭、恢复
└─ test\
   ├─ log.test.js  config.test.js  secrets.test.js  store.test.js  queue.test.js
   ├─ screen.test.js  router.test.js  feishu-api.test.js  feishu-cards.test.js
   ├─ feishu-ws.test.js  feishu-events.test.js  launcher.test.js  hook-stop.test.js
   ├─ projects.test.js  ptySession.test.js  manager.test.js  ipc.test.js
   ├─ setup.test.js  daemon.test.js  control.test.js
   └─ tools.test.js
```

**为什么这样分：** `ptySession.js` 把「一个会话」的全部可变状态（PTY、屏幕镜像、队列、状态、lastInput）关在一个对象里，manager 只做跨会话编排。这样 90% 的逻辑可以用假 PTY 和假飞书做单测，真正需要真机的只有 `node-pty` 适配和端到端验收两处。

---

## 2. 模块契约（后续任务必须与这里一致）

```js
// src/log.js
createRedactor() -> { add(str), scrub(str) }
redact(value, redactor?) -> value
createLogger({ dir, redactor?, now? }) -> { info(event, fields), warn, error, redactor }

// src/secrets.js
createSecretStore({ file, runner?, acl?, log? }) -> { save(plain) -> 'dpapi'|'plain', load() -> string|null }

// src/config.js
DEFAULTS
loadConfig(file) -> config        // 文件不存在返回 DEFAULTS 的副本
saveConfig(file, config) -> void

// src/store.js
writeJsonAtomic(file, obj) -> void
createStore({ file, log? }) -> { load, all, get(id), getByChat(chatId), upsert(s), remove(id), save }

// src/screen.js
createScreen({ cols, rows, scrollback, quietMs, now?, terminalFactory? }) -> {
  write(data) -> Promise,          // 等 headless 终端消费完再 resolve
  bracketedPasteMode,              // 布尔属性，读 term.modes.bracketedPasteMode
  bracketedPaste(text) -> string,  // 终端支持时包 \x1b[200~…\x1b[201~，否则原样返回
  isReady(),                       // 有输出且静默够久（默认 400ms）
  snapshot({ lines = 40 }) -> string,   // 当前画面末尾 lines 行，拼接 isWrapped
  inputLine() -> string,           // 最近一行 ❯ 提示符后面的内容（电脑端回车时记 lastInput 用）
  inInputBox() -> boolean,         // 画面处于输入框状态（有 ❯ 且不是菜单光标）→ 可安全盲写
  resize(cols, rows), dispose(), lastDataAt
}

// src/session/queue.js
createQueue({ limit, canWrite, write, onOverflow, onError }) -> { push(item), release(), pending(), inFlight(), size(), drain() }

// src/session/router.js
parseFirstMessage(text, { aliases, defaultCwd, exists }) -> { cwd, alias, prompt, source, agent }
// agent: 'codex'（首条消息里提了 codex）或 null（按 config.defaultAgent 走）

// src/feishu/api.js
createApi({ appId, appSecret, fetchImpl?, baseUrl?, now? }) -> {
  token(), sendText(chatId, text), sendCard(chatId, card),
  createCardEntity(card), updateCardEntity(cardId, card, seq), sendCardEntity(chatId, cardId),
  createGroup(name, openIds), getChat(chatId), disbandChat(chatId),
  downloadResource(messageId, fileKey, type), getBotInfo()
}
// getChat 在群已解散时返回 null（错误码 230002）

// src/feishu/cards.js
card({ title, template?, elements }) -> card JSON
truncate(text, limit?) -> { text, truncated }
processingCard({ agent, prompt }) / replyCard({ text, agent, cwd })
screenCard({ text, reason }) / noticeCard({ title, text, template? }) / errorCard({ title, text })
screenOutputCard({ lead?, text, agent, cwd })   // Codex 画面推送：可选引导行 + 代码块 +「查看完整画面」按钮 {act:'full-screen', lines:200}
fullScreenCard({ text, lines })                 // 点「查看完整画面」后回的大段画面

// src/feishu/ws.js
createDedup({ ttl?, max?, now? }) -> { isDuplicate(eventId) -> boolean, size() }
createFeishuWs({ appId, appSecret, sdk?, handlers, log?, dedup?, domain? }) -> { start(), close() }
// handlers: { onMessage(evt), onDisbanded(evt), onBotRemoved(evt), onBotAdded(evt), onCardAction(evt) }
// 事件载荷是扁平的：evt.event_id / evt.message.chat_id / evt.sender.sender_id.open_id

// src/feishu/events.js
parseMessage(evt) -> { chatId, chatType, messageId, openId, senderType, text, media, mentioned, unsupported } | null
// 机器人/应用自己发的消息返回 null（防回环）；text 已去掉 @_user_N 占位符并 trim
// media: { messageId, fileKey, type: 'image'|'file', fileName }；不支持的类型把 message_type 放进 unsupported
parseCardAction(evt) -> { chatId, openId, action } | null   // chatId 取 context.open_chat_id；缺 chatId 或 action.act 返回 null
parseChatId(evt) -> string                                  // 群解散 / 机器人被移出：evt.chat_id 或 evt.chat.chat_id

// src/agent/launcher.js
trustKey(cwd) -> string
ensureTrusted({ claudeJsonPath, cwd }) -> boolean       // true = 本次写入过
writeHookFile({ hooksDir, sessionId, hookScript }) -> path
buildLaunch({ session, config, hooksDir, hookScript, claudeJsonPath }) -> { file, args, cwd }

// src/agent/tools.js
summarizeToolUse(jsonlText) -> string   // 如 '🔧 改了 3 个文件 · Bash×2'，无工具调用返回 ''

// src/session/ptySession.js
createPtySession({ session, launch, ptyFactory, screenFactory, queueFactory, log, onEvent, now, queueLimit })
  -> { start(), pollReady(), submitText(text, origin, { force? } = {}), onPcKeys(data), resize(cols, rows),
       snapshot(), kill(), get status(), get lastInput(), get screen(), needsConfirm(), releaseTurn(), session }
// snapshot() 返回可序列化的会话状态对象（IPC 用）；屏幕文本走 get screen().snapshot({ lines })
// 事件：spawned / ready / turn-start / turn-end / data / input / pc-input / overflow / exit
// turn-end 只有 codex 会话会发（没有 Stop hook，靠「画面静默稳定 + 回到输入框」判轮次结束）
// launch(session) -> { file, args, cwd }
// ptyFactory(file, args, opts) -> IPty
// screenFactory({ cols, rows }) -> screen（见 src/screen.js）
// queueFactory(opts) -> queue（见 src/session/queue.js）

// src/session/manager.js
createManager({ config, api, store, log, createPtySession, ipc?, now?, rand?, fsApi?, getProjects? }) -> {
  createFromPhone({ chatId, chatName, text, agent? }) -> Promise<record|null>,
  createFromPc({ cwd, agent, alias? }) -> Promise<record>,
  onPhoneMessage({ chatId, text, media?, senderOpenId? }) -> Promise<void>,
  onCardAction({ chatId, openId, action }) -> Promise<void>,   // action：{act:'force-send'} 或 {act:'full-screen', lines}
  onHookStop({ sessionId, payload }) -> Promise<void>,
  onPcKeys({ sessionId, data }),                                // 电脑端键盘透传，含 lastInput 记账
  onPcResize({ sessionId, cols, rows }),                        // 窗口改尺寸；非法尺寸忽略
  onDisbanded({ chatId }) -> Promise<void>,
  onBotRemoved({ chatId }) -> Promise<void>,
  closeSession(sessionId, { reason, notify }) -> Promise<void>,
  restoreAll() -> Promise<void>,
  shutdown() -> Promise<void>,                                  // 电脑退出：杀 PTY、标记 interrupted、不发通知不解散群
  tick() -> Promise<void>,                                      // 30 秒巡检由 bin/daemon.js 调用
  list() -> Array<record>                                       // IPC {type:'list'} 的应答：记录为准，活会话叠加快照
}
// createPtySession 是装配阶段绑定好的工厂，manager 只传 { session, onEvent, queueLimit, now }
// PTY 退出由 ptySession 自己 emit 'exit'，manager 在 onEvent 里统一处理（不设 onPtyExit 入口）

// src/projects.js
loadProjects({ file, defaultCwd }) -> { aliases, default }      // 文件缺失/损坏都退回默认值
renameAlias({ file, from, to }) -> { ok: true, aliases } | { ok: false, message }
// 只改 aliases 一项，文件里其他字段（default / recent）原样保留；原子写

// src/control.js
createControl({ api, listSessions, closeSession, getProjects, renameAlias, ownerOpenId, log? })
  -> { onMessage({ chatId, text, senderOpenId }), onCardAction({ chatId, openId, action }), onBotAdded({ chatId, openId }) }
parseControl(text) -> { act: 'list'|'end'|'rename'|'help', target?, from?, to? }
formatSessions(list) -> string
// 私聊 = 总控面板：会话列表 / 结束会话 / 改别名（规格 §7、§10.1）。不建会话、不碰 PTY。

// src/ipc.js
startIpc({ port, token, handlers, log, ipcFile? }) -> { port, close(), broadcast(obj), send(ws, obj) }
// handlers: { onHookStop({ sessionId, payload }), onClientMessage(msg, ws), onClientOpen(ws) }
```

**本地 IPC 协议（daemon ↔ hook ↔ 窗口，全计划统一）：**

| 通道 | 地址 | 鉴权 | 用途 |
|---|---|---|---|
| HTTP POST | `http://127.0.0.1:<port>/hook/stop?session=<sessionId>` | 请求头 `x-bridge-token: <token>` | Claude Stop hook 上报本轮结果 |
| HTTP GET | `http://127.0.0.1:<port>/health` | 无 | 存活探测、单实例判定 |
| WebSocket | `ws://127.0.0.1:<port>/?token=<token>` | query 的 `token` | 电脑端窗口（Plan B）与测试客户端 |

端口与 token 写在 `state/ipc.json`：`{ "port": 47831, "token": "<32 位随机>", "pid": 1234, "startedAt": "..." }`。hook 脚本每次调用时现读该文件，所以 daemon 重启后 hook 仍可用。

WebSocket 消息（JSON 文本帧）：

- 客户端 → daemon：`{type:'list'}`、`{type:'attach', sessionId}`、`{type:'input', sessionId, data}`、`{type:'resize', sessionId, cols, rows}`、`{type:'create', cwd, agent}`、`{type:'close', sessionId}`、`{type:'ping'}`
- daemon → 客户端：`{type:'sessions', list}`、`{type:'session', session}`、`{type:'data', sessionId, data}`、`{type:'exit', sessionId, code}`、`{type:'error', message}`、`{type:'pong'}`

**状态机口径（全计划统一）：** `starting → idle → running → idle`，异常分支 `error`、`closing → closed`、`interrupted`。只有 `idle` 才允许写 PTY；`starting` 期间消息纯缓存。

---

## 3. 任务

### 任务 1：工程骨架、路径与脱敏日志

**文件：**
- 创建：`src/paths.js`
- 创建：`src/log.js`
- 测试：`test/log.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/log.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redact, createRedactor, createLogger } = require('../src/log');

test('redact 按键名屏蔽敏感字段，非敏感字段原样保留', () => {
  const out = redact({
    app_secret: 'abc',
    appId: 'cli_1',
    nested: { ANTHROPIC_AUTH_TOKEN: 'sk-x' },
    chatId: 'oc_1',
  });
  assert.deepStrictEqual(out, {
    app_secret: '***',
    appId: 'cli_1',
    nested: { ANTHROPIC_AUTH_TOKEN: '***' },
    chatId: 'oc_1',
  });
});

test('createRedactor 在任意字符串里替换已登记的字面量', () => {
  const r = createRedactor();
  r.add('sk-abc-123456');
  assert.strictEqual(r.scrub('token=sk-abc-123456 ok'), 'token=*** ok');
  assert.strictEqual(r.scrub('nothing here'), 'nothing here');
});

test('createLogger 写 JSONL，一行一条，且不含密钥字面量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-log-'));
  const log = createLogger({ dir, now: () => new Date('2026-11-23T13:00:00Z') });
  log.redactor.add('SECRET-VALUE-1');
  log.info('boot', { appId: 'cli_1', note: 'key=SECRET-VALUE-1' });
  log.warn('slow', { ms: 30 });

  const file = path.join(dir, '2026-11-23.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].event, 'boot');
  assert.strictEqual(lines[0].note, 'key=***');
  assert.strictEqual(lines[1].level, 'warn');

  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/log.test.js`
预期：FAIL，报 `Cannot find module '../src/log'`

- [ ] **步骤 3：编写实现**

```js
// src/log.js
const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEY = /secret|token|passwd|password|pushplus|authorization|api[_-]?key/i;

function createRedactor() {
  const literals = new Set();
  return {
    add(v) {
      if (typeof v === 'string' && v.length >= 6) literals.add(v);
    },
    scrub(s) {
      let out = String(s);
      for (const lit of literals) out = out.split(lit).join('***');
      return out;
    },
  };
}

function redact(value, redactor = createRedactor(), depth = 0) {
  if (depth > 8) return '[deep]';
  if (typeof value === 'string') return redactor.scrub(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, redactor, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '***' : redact(v, redactor, depth + 1);
    }
    return out;
  }
  return value;
}

function createLogger({ dir, redactor = createRedactor(), now = () => new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (level, event, fields) => {
    const ts = now().toISOString();
    const rec = { ts, level, event, ...redact(fields || {}, redactor) };
    fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
    if (level !== 'info') process.stderr.write(`[${level}] ${event}\n`);
  };
  return {
    redactor,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

module.exports = { createLogger, createRedactor, redact };
```

```js
// src/paths.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');

module.exports = {
  ROOT,
  STATE,
  LOGS: path.join(ROOT, 'logs'),
  CONFIG: path.join(STATE, 'config.json'),
  SECRET: path.join(STATE, 'secret.bin'),
  PROJECTS: path.join(STATE, 'projects.json'),
  SESSIONS: path.join(STATE, 'sessions.json'),
  IPC: path.join(STATE, 'ipc.json'),
  HOOKS: path.join(STATE, 'hooks'),
  MEDIA: path.join(STATE, 'media'),
  HOOK_SCRIPT: path.join(ROOT, 'bin', 'hook-stop.js'),
  CLAUDE_JSON: path.join(os.homedir(), '.claude.json'),
  ensureDirs() {
    for (const d of [this.STATE, this.LOGS, this.HOOKS, this.MEDIA]) {
      fs.mkdirSync(d, { recursive: true });
    }
  },
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/log.test.js`
预期：`# pass 3`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add package.json package-lock.json src/paths.js src/log.js test/log.test.js
git commit -m "feat: 工程骨架与脱敏日志"
```

---

### 任务 2：配置与 App Secret（DPAPI + 降级）

**文件：**
- 创建：`src/config.js`
- 创建：`src/secrets.js`
- 测试：`test/config.test.js`
- 测试：`test/secrets.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/config.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, saveConfig, DEFAULTS } = require('../src/config');

test('文件不存在时返回默认值副本，且不等于同一个对象', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-')), 'config.json');
  const a = loadConfig(file);
  const b = loadConfig(file);
  assert.strictEqual(a.defaultAgent, 'claude');
  assert.notStrictEqual(a, b);
});

test('部分字段覆盖默认值，其余保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ appId: 'cli_1', queueLimit: 5 }));
  const c = loadConfig(file);
  assert.strictEqual(c.appId, 'cli_1');
  assert.strictEqual(c.queueLimit, 5);
  assert.deepStrictEqual(c.claudeArgs, DEFAULTS.claudeArgs);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveConfig 原子写，可被 loadConfig 读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-cfg-'));
  const file = path.join(dir, 'config.json');
  saveConfig(file, { appId: 'cli_2' });
  assert.strictEqual(loadConfig(file).appId, 'cli_2');
  assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

```js
// test/secrets.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore } = require('../src/secrets');

test('DPAPI 模式下 roundtrip 正常，文件里没有明文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  const fakeRunner = (script, inputB64) => inputB64; // 假装加密=原样
  const store = createSecretStore({ file, runner: fakeRunner, acl: () => {} });
  assert.strictEqual(store.save('ap-secret-123'), 'dpapi');
  assert.strictEqual(store.load(), 'ap-secret-123');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ap-secret-123'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('加密失败时降级为明文模式并调用 ACL 收紧，仍可读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
  const file = path.join(dir, 'secret.bin');
  let aclCalled = 0;
  const store = createSecretStore({
    file,
    runner: () => { throw new Error('powershell disabled'); },
    acl: () => { aclCalled += 1; },
    log: { warn() {} },
  });
  assert.strictEqual(store.save('ap-secret-456'), 'plain');
  assert.strictEqual(aclCalled, 1);
  assert.strictEqual(store.load(), 'ap-secret-456');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/config.test.js test/secrets.test.js`
预期：FAIL，两个 `Cannot find module`

- [ ] **步骤 3：编写实现**

```js
// src/config.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  appId: '',
  ownerOpenId: '',
  ownerChatId: '',
  defaultAgent: 'claude',
  autoDisband: false,
  claudeExe: 'D:/Claude Code/claude.exe',
  claudeArgs: ['--permission-mode', 'bypassPermissions'],
  codexEntry: path.join(
    os.homedir(),
    'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js',
  ),
  codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  defaultCwd: 'D:/feishu-workspace',
  queueLimit: 20,
  inFlightTimeoutMs: 900000,
  sweepIntervalMs: 30000,
  ipcPort: 47831,
};

function loadConfig(file) {
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...structuredClone(DEFAULTS), ...raw };
}

function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
```

```js
// src/secrets.js
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const PS_PROTECT = [
  'Add-Type -AssemblyName System.Security;',
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
  "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');",
  '[Console]::Out.Write([Convert]::ToBase64String($e))',
].join(' ');

const PS_UNPROTECT = PS_PROTECT.replace('Protect($b,$null', 'Unprotect($b,$null');

function runPowerShell(script, inputB64) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: inputB64,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  }).trim();
}

function restrictAcl(file) {
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:R`], {
    windowsHide: true,
  });
}

function createSecretStore({ file, runner = runPowerShell, acl = restrictAcl, log = { warn() {} } }) {
  return {
    save(plain) {
      const b64 = Buffer.from(plain, 'utf8').toString('base64');
      let record;
      try {
        record = { mode: 'dpapi', data: runner(PS_PROTECT, b64) };
      } catch (err) {
        log.warn('secret.dpapi_failed', { error: String((err && err.message) || err) });
        record = { mode: 'plain', data: b64 };
      }
      fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      if (record.mode === 'plain') acl(file);
      return record.mode;
    },
    load() {
      if (!fs.existsSync(file)) return null;
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const b64 = rec.mode === 'dpapi' ? runner(PS_UNPROTECT, rec.data) : rec.data;
      return Buffer.from(b64, 'base64').toString('utf8');
    },
  };
}

module.exports = { createSecretStore, runPowerShell, PS_PROTECT, PS_UNPROTECT };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/config.test.js test/secrets.test.js`
预期：`# pass 5`

- [ ] **步骤 5：真机验证 DPAPI 一次（不需要 App Secret，随便造一个值）**

运行：
```bash
cd /d/feishu-bridge && node -e "
const { createSecretStore, runPowerShell } = require('./src/secrets');
const s = createSecretStore({ file: 'D:/tmp/secret-probe.bin', log: console });
console.log('mode=', s.save('probe-value-123'));
console.log('read=', s.load());
"
```
预期：`mode= dpapi`、`read= probe-value-123`，耗时约 2 秒。若输出 `mode= plain`，说明 PowerShell 被策略禁用，按降级路径继续（日志里会有 `secret.dpapi_failed`）。随后删除探针文件：`rm -f /d/tmp/secret-probe.bin`

- [ ] **步骤 6：Commit**

```bash
cd /d/feishu-bridge
git add src/config.js src/secrets.js test/config.test.js test/secrets.test.js
git commit -m "feat: 配置加载与 DPAPI 凭据存储（含降级）"
```

---

### 任务 3：会话表持久化

**文件：**
- 创建：`src/store.js`
- 测试：`test/store.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/store.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, writeJsonAtomic } = require('../src/store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-store-')), 'sessions.json');
}

test('upsert 后可重新加载，按 id 与 chatId 都能查到', () => {
  const file = tmpFile();
  const s = createStore({ file }).load();
  s.upsert({ id: 's1', chatId: 'oc_1', status: 'idle' });
  const again = createStore({ file }).load();
  assert.strictEqual(again.get('s1').status, 'idle');
  assert.strictEqual(again.getByChat('oc_1').id, 's1');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('remove 会落盘', () => {
  const file = tmpFile();
  const s = createStore({ file }).load();
  s.upsert({ id: 's1', chatId: 'oc_1' });
  s.remove('s1');
  assert.strictEqual(createStore({ file }).load().get('s1'), null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('文件损坏时改名备份并从空表开始，不抛异常', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 这不是 JSON');
  const warnings = [];
  const s = createStore({ file, log: { warn: (e) => warnings.push(e) } }).load();
  assert.deepStrictEqual(s.all(), []);
  assert.strictEqual(warnings[0], 'store.corrupt');
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith('sessions.json.corrupt-')));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('writeJsonAtomic 不留 .tmp', () => {
  const file = tmpFile();
  writeJsonAtomic(file, { sessions: [] });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['sessions.json']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/store.test.js`
预期：FAIL，`Cannot find module '../src/store'`

- [ ] **步骤 3：编写实现**

```js
// src/store.js
const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function createStore({ file, log }) {
  let data = { sessions: [] };

  const save = () => writeJsonAtomic(file, data);

  return {
    load() {
      if (!fs.existsSync(file)) return this;
      const raw = fs.readFileSync(file, 'utf8');
      try {
        data = JSON.parse(raw);
      } catch {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, backup);
        if (log) log.warn('store.corrupt', { file, backup });
        data = { sessions: [] };
      }
      if (!Array.isArray(data.sessions)) data = { sessions: [] };
      return this;
    },
    all() {
      return data.sessions.slice();
    },
    get(id) {
      return data.sessions.find((s) => s.id === id) || null;
    },
    getByChat(chatId) {
      return data.sessions.find((s) => s.chatId === chatId) || null;
    },
    upsert(session) {
      const i = data.sessions.findIndex((s) => s.id === session.id);
      if (i >= 0) data.sessions[i] = session;
      else data.sessions.push(session);
      save();
      return session;
    },
    remove(id) {
      data.sessions = data.sessions.filter((s) => s.id !== id);
      save();
    },
    save,
  };
}

module.exports = { createStore, writeJsonAtomic };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/store.test.js`
预期：`# pass 4`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/store.js test/store.test.js
git commit -m "feat: 会话表原子持久化"
```

---

### 任务 4：每会话串行队列

**文件：**
- 创建：`src/session/queue.js`
- 测试：`test/queue.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/queue.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../src/session/queue');

test('按到达顺序注入，且同时只有一条在途', () => {
  const written = [];
  let ready = true;
  const q = createQueue({ canWrite: () => ready, write: (x) => written.push(x) });

  q.push('a');
  q.push('b');
  q.push('c');
  assert.deepStrictEqual(written, ['a']);
  assert.strictEqual(q.pending(), 2);

  q.release();
  assert.deepStrictEqual(written, ['a', 'b']);
  q.release();
  q.release();
  assert.deepStrictEqual(written, ['a', 'b', 'c']);
  assert.strictEqual(q.inFlight(), false);
});

test('不可写时只缓存，恢复可写后自动排空', () => {
  const written = [];
  let ready = false;
  const q = createQueue({ canWrite: () => ready, write: (x) => written.push(x) });
  q.push('a');
  q.push('b');
  assert.deepStrictEqual(written, []);
  ready = true;
  q.release();
  assert.deepStrictEqual(written, ['a']);
});

test('超过上限触发 onOverflow 且不丢已有队列', () => {
  const overflow = [];
  const q = createQueue({
    limit: 3,
    canWrite: () => false,
    write: () => {},
    onOverflow: (x) => overflow.push(x),
  });
  assert.strictEqual(q.push('a'), 'queued');
  assert.strictEqual(q.push('b'), 'queued');
  assert.strictEqual(q.push('c'), 'queued');
  assert.strictEqual(q.push('d'), 'full');
  assert.deepStrictEqual(overflow, ['d']);
  assert.strictEqual(q.pending(), 3);
});

test('drain 返回未处理的项并清空', () => {
  const q = createQueue({ canWrite: () => false, write: () => {} });
  q.push('a');
  q.push('b');
  assert.deepStrictEqual(q.drain(), ['a', 'b']);
  assert.strictEqual(q.pending(), 0);
  assert.strictEqual(q.inFlight(), false);
});

test('write 抛异常时不把队列卡死，交给 onError', () => {
  const errors = [];
  const q = createQueue({
    canWrite: () => true,
    write: () => { throw new Error('boom'); },
    onError: (e) => errors.push(e.message),
  });
  q.push('a');
  assert.deepStrictEqual(errors, ['boom']);
  assert.strictEqual(q.inFlight(), false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/queue.test.js`
预期：FAIL，`Cannot find module '../src/session/queue'`

- [ ] **步骤 3：编写实现**

```js
// src/session/queue.js
function createQueue({
  limit = 20,
  canWrite = () => true,
  write,
  onOverflow = () => {},
  onError = () => {},
}) {
  const items = [];
  let inFlight = false;

  function pump() {
    if (inFlight || items.length === 0 || !canWrite()) return;
    const item = items.shift();
    inFlight = true;
    try {
      write(item);
    } catch (err) {
      inFlight = false;
      onError(err);
    }
  }

  return {
    push(item) {
      if (items.length + (inFlight ? 1 : 0) >= limit) {
        onOverflow(item);
        return 'full';
      }
      items.push(item);
      pump();
      return 'queued';
    },
    release() {
      inFlight = false;
      pump();
    },
    pending() {
      return items.length;
    },
    inFlight() {
      return inFlight;
    },
    size() {
      return items.length + (inFlight ? 1 : 0);
    },
    drain() {
      const rest = items.splice(0);
      inFlight = false;
      return rest;
    },
  };
}

module.exports = { createQueue };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/queue.test.js`
预期：`# pass 5`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/queue.js test/queue.test.js
git commit -m "feat: 每会话串行 FIFO 队列"
```

---

### 任务 5：首句解析（别名 / 盘符路径 / 默认目录）

**文件：**
- 创建：`src/session/router.js`
- 测试：`test/router.test.js`

> **与规格 §7.1 的一处收紧：** 别名命中后，后续字符必须是空串或空白/标点，否则继续尝试更短的别名。理由：若别名是 `demo`，用户说 `demo44 帮我…` 会被错拆成 `demo` + `44 帮我…`，把消息送进错误目录——开错目录比退回默认目录更糟。扫描长度上限仍是 6。

- [ ] **步骤 1：编写失败的测试**

```js
// test/router.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseFirstMessage } = require('../src/session/router');

const base = { defaultCwd: 'D:/feishu-workspace', exists: () => false };

test('别名命中，剩余部分作为 prompt', () => {
  const r = parseFirstMessage('卡牌 帮我加个技能', {
    ...base,
    aliases: { 卡牌: 'D:/★CardGame/demo44' },
  });
  assert.deepStrictEqual(r, {
    cwd: 'D:/★CardGame/demo44',
    alias: '卡牌',
    prompt: '帮我加个技能',
    source: 'alias',
  });
});

test('只发别名，prompt 为空串', () => {
  const r = parseFirstMessage('卡牌', { ...base, aliases: { 卡牌: 'D:/★CardGame/demo44' } });
  assert.strictEqual(r.prompt, '');
  assert.strictEqual(r.source, 'alias');
});

test('别名后跟中文（无分隔）不命中，退回默认目录', () => {
  const r = parseFirstMessage('卡牌游戏 加个技能', {
    ...base,
    aliases: { 卡: 'D:/a', 卡牌: 'D:/b' },
  });
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.cwd, 'D:/feishu-workspace');
  assert.strictEqual(r.prompt, '卡牌游戏 加个技能');
});

test('全角冒号也能分隔别名与正文', () => {
  const r = parseFirstMessage('卡牌：加个技能', { ...base, aliases: { 卡牌: 'D:/b' } });
  assert.strictEqual(r.prompt, '加个技能');
});

test('盘符路径存在时用它，剩余句子作为 prompt', () => {
  const r = parseFirstMessage('D:/work/alpha 跑一下测试', {
    ...base,
    exists: (p) => p === 'D:/work/alpha',
  });
  assert.deepStrictEqual(r, {
    cwd: 'D:/work/alpha',
    alias: null,
    prompt: '跑一下测试',
    source: 'path',
  });
});

test('盘符路径不存在时明确报告，不静默退回默认目录', () => {
  const r = parseFirstMessage('D:/nope/alpha 跑一下测试', base);
  assert.strictEqual(r.source, 'path-missing');
  assert.strictEqual(r.cwd, null);
  assert.strictEqual(r.prompt, 'D:/nope/alpha 跑一下测试');
});

test('反斜杠路径同样识别', () => {
  const r = parseFirstMessage('D:\\work\\alpha 跑测试', {
    ...base,
    exists: (p) => p === 'D:\\work\\alpha',
  });
  assert.strictEqual(r.source, 'path');
  assert.strictEqual(r.prompt, '跑测试');
});

test('前导空白与 @ 提及残留不影响解析', () => {
  const r = parseFirstMessage('   卡牌  加个技能  ', { ...base, aliases: { 卡牌: 'D:/b' } });
  assert.strictEqual(r.prompt, '加个技能');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/router.test.js`
预期：FAIL，`Cannot find module '../src/session/router'`

- [ ] **步骤 3：编写实现**

```js
// src/session/router.js
const SEP = /^[\s,，:：、]+/;
const ALIAS_MAX = 6;

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 返回 { cwd, alias, prompt, source }
// source: 'alias' | 'path' | 'path-missing' | 'default'
function parseFirstMessage(text, { aliases = {}, defaultCwd, exists = () => false }) {
  const raw = String(text || '').replace(/\uFEFF/g, '').trim();

  for (let len = Math.min(ALIAS_MAX, raw.length); len >= 1; len -= 1) {
    const cand = raw.slice(0, len);
    if (!has(aliases, cand)) continue;
    const rest = raw.slice(len);
    if (rest !== '' && !SEP.test(rest)) continue; // 别名后必须跟分隔符，避免吃掉 "demo44"
    return { cwd: aliases[cand], alias: cand, prompt: rest.replace(SEP, '').trim(), source: 'alias' };
  }

  const m = raw.match(/^([A-Za-z]:[\\/][^\s]*)([\s\S]*)$/);
  if (m) {
    const cwd = m[1];
    const prompt = m[2].replace(SEP, '').trim();
    if (exists(cwd)) return { cwd, alias: null, prompt, source: 'path' };
    return { cwd: null, alias: null, prompt: raw, source: 'path-missing' };
  }

  return { cwd: defaultCwd, alias: null, prompt: raw, source: 'default' };
}

module.exports = { parseFirstMessage };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/router.test.js`
预期：`# pass 8`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/router.js test/router.test.js
git commit -m "feat: 首句解析（别名/盘符路径/默认目录）"
```

---

### 任务 6：启动器（信任预写 / hook 文件 / claude 与 codex 参数）

**文件：**
- 创建：`src/agent/launcher.js`
- 测试：`test/launcher.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/launcher.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  trustKey, ensureTrusted, writeHookFile, prepareClaude, buildLaunch,
} = require('../src/agent/launcher');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lnch-'));
}

test('trustKey 把反斜杠统一成正斜杠', () => {
  assert.strictEqual(trustKey('D:\\work\\alpha'), 'D:/work/alpha');
});

test('ensureTrusted 首次写入 true，再次调用 false，其他项目与顶层字段不受影响', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({
    projects: { 'D:/other': { hasTrustDialogAccepted: false, x: 1 } },
    numStartups: 7,
  }));
  assert.strictEqual(ensureTrusted({ claudeJsonPath: file, cwd: 'D:\\work\\alpha' }), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.projects['D:/work/alpha'].hasTrustDialogAccepted, true);
  assert.strictEqual(doc.projects['D:/other'].hasTrustDialogAccepted, false);
  assert.strictEqual(doc.numStartups, 7);
  assert.strictEqual(ensureTrusted({ claudeJsonPath: file, cwd: 'D:/work/alpha' }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureTrusted 在 .claude.json 不存在时创建最小结构', () => {
  const dir = tmpDir();
  const file = path.join(dir, '.claude.json');
  assert.strictEqual(ensureTrusted({ claudeJsonPath: file, cwd: 'D:/a' }), true);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.projects['D:/a'].hasTrustDialogAccepted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHookFile 生成 Stop 命令并带上 --session', () => {
  const dir = tmpDir();
  const file = writeHookFile({
    hooksDir: dir,
    sessionId: 's1',
    hookScript: 'D:\\feishu-bridge\\bin\\hook-stop.js',
  });
  assert.strictEqual(path.basename(file), 's1.hook.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const h = doc.hooks.Stop[0].hooks[0];
  assert.strictEqual(h.type, 'command');
  assert.ok(h.command.includes('hook-stop.js'));
  assert.ok(h.command.includes('--session s1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prepareClaude：无 claudeSessionId 不带 --resume，有则带', () => {
  const dir = tmpDir();
  const config = { claudeExe: 'D:/Claude Code/claude.exe', claudeArgs: ['--permission-mode', 'bypassPermissions'] };
  const common = {
    config,
    hooksDir: path.join(dir, 'hooks'),
    hookScript: path.join(dir, 'hook-stop.js'),
    claudeJsonPath: path.join(dir, '.claude.json'),
  };

  const fresh = prepareClaude({
    session: { id: 's1', agent: 'claude', cwd: 'D:/w', claudeSessionId: null },
    ...common,
  });
  assert.strictEqual(fresh.file, config.claudeExe);
  assert.ok(fresh.args.includes('--settings'));
  assert.ok(!fresh.args.includes('--resume'));
  assert.deepStrictEqual(fresh.args.slice(-2), ['--permission-mode', 'bypassPermissions']);

  const resumed = prepareClaude({
    session: { id: 's2', agent: 'claude', cwd: 'D:/w', claudeSessionId: 'abc-123' },
    ...common,
  });
  assert.deepStrictEqual(resumed.args.slice(-2), ['--resume', 'abc-123']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLaunch：codex 走 node + codex.js', () => {
  const config = {
    claudeExe: 'x',
    claudeArgs: [],
    codexEntry: 'C:/npm/codex.js',
    codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  };
  const l = buildLaunch({ session: { agent: 'codex', cwd: 'D:/w' }, config });
  assert.strictEqual(l.file, process.execPath);
  assert.deepStrictEqual(l.args, ['C:/npm/codex.js', '--dangerously-bypass-approvals-and-sandbox']);
  assert.strictEqual(l.cwd, 'D:/w');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/launcher.test.js`
预期：FAIL，`Cannot find module '../src/agent/launcher'`

- [ ] **步骤 3：编写实现**

```js
// src/agent/launcher.js
const fs = require('node:fs');
const path = require('node:path');

function trustKey(cwd) {
  return cwd.replace(/\\/g, '/');
}

// 返回 true 表示本次写入了信任标记（供日志用）
function ensureTrusted({ claudeJsonPath, cwd }) {
  let doc = {};
  if (fs.existsSync(claudeJsonPath)) {
    doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  }
  doc.projects = doc.projects || {};
  const key = trustKey(cwd);
  const cur = doc.projects[key] || {};
  if (cur.hasTrustDialogAccepted === true) return false;
  doc.projects[key] = { ...cur, hasTrustDialogAccepted: true };
  const tmp = `${claudeJsonPath}.fb-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, claudeJsonPath);
  return true;
}

function writeHookFile({ hooksDir, sessionId, hookScript }) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, `${sessionId}.hook.json`);
  const command = `"${process.execPath}" "${hookScript}" --session ${sessionId}`;
  const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

function prepareClaude({ session, config, hooksDir, hookScript, claudeJsonPath }) {
  ensureTrusted({ claudeJsonPath, cwd: session.cwd });
  const hookFile = writeHookFile({ hooksDir, sessionId: session.id, hookScript });
  const args = ['--settings', hookFile, ...config.claudeArgs];
  if (session.claudeSessionId) args.push('--resume', session.claudeSessionId);
  return { file: config.claudeExe, args, cwd: session.cwd };
}

function buildLaunch(opts) {
  if (opts.session.agent === 'codex') {
    return {
      file: process.execPath,
      args: [opts.config.codexEntry, ...opts.config.codexArgs],
      cwd: opts.session.cwd,
    };
  }
  return prepareClaude(opts);
}

module.exports = { trustKey, ensureTrusted, writeHookFile, prepareClaude, buildLaunch };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/launcher.test.js`
预期：`# pass 6`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/agent/launcher.js test/launcher.test.js
git commit -m "feat: claude/codex 启动参数、信任预写与 Stop hook 文件"
```

---

### 任务 7：Stop hook 客户端

**文件：**
- 创建：`bin/hook-stop.js`
- 测试：`test/hook-stop.test.js`

> hook 的硬约束：**绝不能挂住 claude，也绝不能让 claude 报错**。任何异常一律吞掉并 `exit 0`，总预算 2 秒。

- [ ] **步骤 1：编写失败的测试**

```js
// test/hook-stop.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'hook-stop.js');

function runHook(env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--session', 's1'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('exit', resolve);
    child.stdin.end(stdin);
  });
}

test('把 stdin 原样 POST 到 /hook/stop 并带 token，退出码 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, token: req.headers['x-bridge-token'], body });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ipc = path.join(dir, 'ipc.json');
  fs.writeFileSync(ipc, JSON.stringify({ port: server.address().port, token: 'tok-1', pid: 1 }));

  const payload = JSON.stringify({ session_id: 'abc', last_assistant_message: '好的' });
  const code = await runHook({ FEISHU_BRIDGE_IPC: ipc }, payload);
  server.close();

  assert.strictEqual(code, 0);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].url, '/hook/stop?session=s1');
  assert.strictEqual(received[0].token, 'tok-1');
  assert.deepStrictEqual(JSON.parse(received[0].body), JSON.parse(payload));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ipc.json 不存在时立即退出 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const code = await runHook({ FEISHU_BRIDGE_IPC: path.join(dir, 'missing.json') }, '{}');
  assert.strictEqual(code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('端口无人监听时也退出 0 且不超时太久', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const ipc = path.join(dir, 'ipc.json');
  fs.writeFileSync(ipc, JSON.stringify({ port: 1, token: 'x', pid: 1 }));
  const t0 = Date.now();
  const code = await runHook({ FEISHU_BRIDGE_IPC: ipc }, '{}');
  assert.strictEqual(code, 0);
  assert.ok(Date.now() - t0 < 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/hook-stop.test.js`
预期：FAIL（脚本不存在，子进程退出码非 0）

- [ ] **步骤 3：编写实现**

```js
#!/usr/bin/env node
// bin/hook-stop.js
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const BUDGET_MS = 2000;
const startedAt = Date.now();

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', finish);
    setTimeout(finish, 800);
  });
}

function post({ port, token, session, body }) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/hook/stop?session=${encodeURIComponent(session)}`,
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': token,
        'content-length': Buffer.byteLength(body),
      },
      timeout: Math.max(300, BUDGET_MS - (Date.now() - startedAt)),
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--session');
  const session = i >= 0 ? args[i + 1] : '';
  const ipcFile = process.env.FEISHU_BRIDGE_IPC
    || path.join(__dirname, '..', 'state', 'ipc.json');

  const body = await readStdin();
  if (!session || !fs.existsSync(ipcFile)) return;

  let ipc;
  try {
    ipc = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
  } catch {
    return;
  }
  await post({ port: ipc.port, token: ipc.token, session, body });
}

main().catch(() => {}).finally(() => process.exit(0));
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/hook-stop.test.js`
预期：`# pass 3`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add bin/hook-stop.js test/hook-stop.test.js
git commit -m "feat: Claude Stop hook 客户端（带超时兜底，永不阻塞）"
```

---

### 任务 8：本地 IPC 服务（HTTP + WebSocket）

**文件：**
- 创建：`src/ipc.js`
- 测试：`test/ipc.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
// test/ipc.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startIpc } = require('../src/ipc');

const log = { info() {}, warn() {}, error() {} };

async function boot() {
  const calls = { hook: [], client: [] };
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log,
    handlers: {
      onHookStop: (x) => calls.hook.push(x),
      onClientMessage: (m, ws) => calls.client.push(m),
    },
  });
  return { ipc, calls };
}

test('/health 返回 ok 与 pid', async () => {
  const { ipc } = await boot();
  const res = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.pid, 'number');
  await ipc.close();
});

test('token 错误的 hook 请求被拒绝且不触发回调', async () => {
  const { ipc, calls } = await boot();
  const res = await fetch(`http://127.0.0.1:${ipc.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'wrong' },
    body: '{}',
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(calls.hook.length, 0);
  await ipc.close();
});

test('token 正确的 hook 请求先回 200 再异步分发', async () => {
  const { ipc, calls } = await boot();
  const res = await fetch(`http://127.0.0.1:${ipc.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'tok-1', 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'abc', last_assistant_message: '好' }),
  });
  assert.strictEqual(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls.hook.length, 1);
  assert.strictEqual(calls.hook[0].sessionId, 's1');
  assert.strictEqual(calls.hook[0].payload.session_id, 'abc');
  await ipc.close();
});

test('WebSocket：token 错误被断开，正确可收发与广播', async () => {
  const { ipc, calls } = await boot();

  const bad = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=wrong`);
  const badClosed = await new Promise((resolve) => {
    bad.on('close', () => resolve(true));
    bad.on('error', () => resolve(true));
    bad.on('open', () => resolve(false));
  });
  assert.strictEqual(badClosed, true);

  const good = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  await new Promise((r) => good.on('open', r));
  good.send(JSON.stringify({ type: 'list' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(calls.client, [{ type: 'list' }]);

  const got = new Promise((r) => good.on('message', (d) => r(JSON.parse(d.toString()))));
  ipc.broadcast({ type: 'sessions', list: [] });
  assert.deepStrictEqual(await got, { type: 'sessions', list: [] });

  good.close();
  await ipc.close();
});

test('写了 ipc.json，close 后删除', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-'));
  const ipcFile = path.join(dir, 'ipc.json');
  const ipc = await startIpc({ port: 0, token: 'tok-1', log, ipcFile, handlers: {} });
  const doc = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
  assert.strictEqual(doc.token, 'tok-1');
  assert.strictEqual(doc.port, ipc.port);
  await ipc.close();
  assert.strictEqual(fs.existsSync(ipcFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/ipc.test.js`
预期：FAIL，`Cannot find module '../src/ipc'`

- [ ] **步骤 3：编写实现**

```js
// src/ipc.js
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');

function startIpc({ port = 0, token, handlers = {}, log, ipcFile }) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hook/stop') {
      if (req.headers['x-bridge-token'] !== token) {
        res.writeHead(401);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        let payload = {};
        try { payload = JSON.parse(body); } catch { /* 空 body 按空对象处理 */ }
        const sessionId = url.searchParams.get('session') || '';
        try {
          if (handlers.onHookStop) handlers.onHookStop({ sessionId, payload });
        } catch (err) {
          if (log) log.warn('ipc.hook_handler_error', { error: String((err && err.message) || err) });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) {
      ws.close(4001, 'unauthorized');
      return;
    }
    clients.add(ws);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (handlers.onClientMessage) handlers.onClientMessage(msg, ws);
      } catch (err) {
        if (log) log.warn('ipc.client_handler_error', { error: String((err && err.message) || err) });
      }
    });
    ws.on('close', () => clients.delete(ws));
    if (handlers.onClientOpen) handlers.onClientOpen(ws);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      if (ipcFile) {
        fs.mkdirSync(path.dirname(ipcFile), { recursive: true });
        fs.writeFileSync(ipcFile, JSON.stringify({
          port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString(),
        }, null, 2));
      }
      const send = (ws, obj) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      };
      resolve({
        port: actualPort,
        broadcast(obj) { for (const ws of clients) send(ws, obj); },
        send(ws, obj) { send(ws, obj); },
        close() {
          return new Promise((done) => {
            for (const ws of clients) ws.terminate();
            wss.close();
            server.close(() => {
              if (ipcFile && fs.existsSync(ipcFile)) fs.unlinkSync(ipcFile);
              done();
            });
          });
        },
      });
    });
  });
}

module.exports = { startIpc };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/ipc.test.js`
预期：`# pass 5`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/ipc.js test/ipc.test.js
git commit -m "feat: 本地 IPC（hook HTTP 端点 + 窗口 WebSocket）"
```

---

### 任务 9：单会话运行态（PTY + 屏幕 + 队列 + 状态机）

**文件：**
- 创建：`src/session/ptySession.js`
- 测试：`test/ptySession.test.js`

> 这是全项目状态最密集的文件。它不知道飞书存在，也不写磁盘——所有外部副作用都通过 `onEvent` 交给 manager。这样 100% 的分支可用假 PTY 测到。

- [ ] **步骤 1：编写失败的测试**

```js
// test/ptySession.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createPtySession } = require('../src/session/ptySession');
const { createQueue } = require('../src/session/queue');

function harness(overrides = {}) {
  const written = [];
  const events = [];
  let dataHandler = () => {};
  let exitHandler = () => {};
  let ready = true;

  const pty = {
    onData(fn) { dataHandler = fn; },
    onExit(fn) { exitHandler = fn; },
    write(s) { written.push(s); },
    kill() { exitHandler({ exitCode: 0 }); },
  };

  const screen = {
    write(d) { lastScreen += d; },
    isReady: () => ready,
    snapshot: () => 'screen-tail',
    inputLine: () => overrides.inputLine || '输入中的话',
    inInputBox: () => inBox,
    bracketedPaste: (t) => `\x1b[200~${t}\x1b[201~`,
    resize() {},
    dispose() {},
  };
  let lastScreen = '';
  let inBox = true;

  const session = {
    id: 's1', agent: 'claude', cwd: 'D:/w', status: 'idle', inputSeq: 0, lastInput: null,
  };

  const ps = createPtySession({
    session,
    launch: () => ({ file: 'node', args: ['x.js'], cwd: 'D:/w' }),
    ptyFactory: () => pty,
    screenFactory: () => screen,
    queueFactory: createQueue,
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => events.push(e),
    now: () => 1000,
  });

  return {
    ps, written, events, session,
    setReady(v) { ready = v; },
    setInBox(v) { inBox = v; },
    emitData(d) { dataHandler(d); },
    emitExit(code) { exitHandler({ exitCode: code }); },
  };
}

test('start 后 PTY 进入 starting，屏幕就绪后转 idle 并派发 ready', () => {
  const h = harness();
  h.ps.start();
  assert.strictEqual(h.ps.status, 'starting');
  h.ps._pollReady(); // 测试直接驱动一次就绪探测
  assert.strictEqual(h.ps.status, 'idle');
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'ready').length, 1);
});

test('idle 时提交：立即以括号粘贴+回车写入，状态转 running', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('你好', 'phone');
  assert.deepStrictEqual(h.written, ['\x1b[200~你好\x1b[201~\r']);
  assert.strictEqual(h.ps.status, 'running');
  assert.strictEqual(h.session.inputSeq, 1);
  assert.strictEqual(h.session.lastInput.origin, 'phone');
  assert.strictEqual(h.session.lastInput.text, '你好');
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-start').length, 1);
});

test('starting 期间提交只缓存，ready 后按顺序写出', () => {
  const h = harness();
  h.ps.start();
  h.ps.submitText('一', 'phone');
  h.ps.submitText('二', 'phone');
  assert.deepStrictEqual(h.written, []);
  h.ps._pollReady();
  assert.deepStrictEqual(h.written, ['\x1b[200~一\x1b[201~\r']);
  h.ps.releaseTurn();
  assert.deepStrictEqual(h.written, ['\x1b[200~一\x1b[201~\r', '\x1b[200~二\x1b[201~\r']);
});

test('队列满时派发 overflow 事件且不写入', () => {
  const h = harness();
  const ps = createPtySession({
    session: h.session,
    launch: () => ({ file: 'node', args: [], cwd: 'D:/w' }),
    ptyFactory: () => ({ onData() {}, onExit() {}, write() { h.written.push('X'); }, kill() {} }),
    screenFactory: () => ({ write() {}, isReady: () => false, snapshot: () => '', inputLine: () => '', inInputBox: () => true, bracketedPaste: (t) => t, resize() {}, dispose() {} }),
    queueFactory: (o) => createQueue({ ...o, limit: 2 }),
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => h.events.push(e),
  });
  ps.start();
  ps.submitText('一', 'phone');
  ps.submitText('二', 'phone');
  ps.submitText('三', 'phone');
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'overflow').length, 1);
  assert.deepStrictEqual(h.written, []);
});

test('needsConfirm：idle 但画面不在输入框（菜单/弹窗）时为 true', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.setInBox(false);
  assert.strictEqual(h.ps.needsConfirm(), true);
  h.setInBox(true);
  assert.strictEqual(h.ps.needsConfirm(), false);
});

test('画面回到输入框后，pollReady 自动补写积压', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('一', 'phone');   // 立即写出，status 转 running
  h.setInBox(false);
  h.ps.submitText('二', 'phone');   // 排队
  h.ps.releaseTurn();               // 画面不在输入框 → 不盲写
  assert.strictEqual(h.written.length, 1);
  h.setInBox(true);
  h.ps._pollReady();                // 回到输入框后自动补写
  assert.strictEqual(h.written.length, 2);
  assert.strictEqual(h.written[1], '\x1b[200~二\x1b[201~\r');
});

test('force 提交无视输入框判断，直接写入（「仍然发送」用）', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.setInBox(false);
  h.ps.submitText('照样发', 'phone', { force: true });
  assert.strictEqual(h.written.length, 1);
  assert.strictEqual(h.written[0], '\x1b[200~照样发\x1b[201~\r');
  assert.strictEqual(h.session.lastInput.text, '照样发');
});

test('电脑端敲回车时用屏幕输入行记录 lastInput(origin=pc)', () => {
  const h = harness({ inputLine: '电脑上打的' });
  h.ps.start(); h.ps._pollReady();
  h.ps.onPcKeys('\r');
  assert.strictEqual(h.written[0], '\r');
  assert.strictEqual(h.session.lastInput.origin, 'pc');
  assert.strictEqual(h.session.lastInput.text, '电脑上打的');
  assert.strictEqual(h.events.filter((e) => e.type === 'pc-input').length, 1);
});

test('kill 清空积压并派发 exit 事件', () => {
  const h = harness();
  h.ps.start();
  h.ps.submitText('一', 'phone');
  h.ps.kill();
  assert.strictEqual(h.ps.status, 'closed');
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'exit').map((e) => e.code), [0]);
  assert.strictEqual(h.ps._queue.pending(), 0);
});

test('snapshot 只暴露可序列化字段', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  const snap = h.ps.snapshot();
  assert.deepStrictEqual(
    Object.keys(snap).sort(),
    ['agent', 'alias', 'chatId', 'cwd', 'id', 'lastInput', 'pending', 'status'],
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/ptySession.test.js`
预期：FAIL，`Cannot find module '../src/session/ptySession'`

- [ ] **步骤 3：编写实现**

```js
// src/session/ptySession.js
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const READY_POLL_MS = 200;

function createPtySession({
  session,
  launch,
  ptyFactory,
  screenFactory,
  queueFactory,
  log,
  onEvent,
  now = () => Date.now(),
  queueLimit = 20,
}) {
  let status = session.status === 'idle' ? 'starting' : (session.status || 'starting');
  let pty = null;
  let readyTimer = null;
  let disposed = false;

  const screen = screenFactory({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });

  const emit = (e) => onEvent({ sessionId: session.id, ...e });

  const queue = queueFactory({
    limit: queueLimit,
    // 只有「空闲 + 画面静下来 + 确实在输入框」才写，避免盲写进菜单/弹窗
    canWrite: () => status === 'idle' && screen.isReady() && screen.inInputBox(),
    write(item) {
      status = 'running';
      session.status = 'running';
      pty.write(screen.bracketedPaste(item.text) + '\r');
      emit({ type: 'turn-start', seq: item.seq, origin: item.origin, text: item.text });
    },
    onOverflow(item) {
      emit({ type: 'overflow', text: item.text });
    },
    onError(err) {
      emit({ type: 'error', message: String((err && err.message) || err) });
    },
  });

  function pollReady() {
    if (disposed) return;
    if (status === 'starting' && screen.isReady()) {
      status = 'idle';
      session.status = 'idle';
      emit({ type: 'ready' });
      queue.release();
      return;
    }
    // 上一轮结束时画面可能还在弹窗里，积压留到回到输入框后再补写
    if (status === 'idle' && queue.pending() > 0 && queue.inFlight() === false) {
      queue.release();
    }
  }

  function start() {
    const l = launch(session);
    pty = ptyFactory(l.file, l.args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: l.cwd,
      env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' },
    });

    pty.onData((d) => {
      screen.write(d);
      emit({ type: 'data', data: d });
    });
    pty.onExit(({ exitCode }) => {
      status = 'closed';
      session.status = 'closed';
      queue.drain();
      if (readyTimer) clearInterval(readyTimer);
      emit({ type: 'exit', code: exitCode });
    });

    readyTimer = setInterval(pollReady, READY_POLL_MS);
    if (readyTimer.unref) readyTimer.unref();
    emit({ type: 'spawned', pid: pty.pid });
  }

  function submitText(text, origin, { force = false } = {}) {
    session.inputSeq += 1;
    session.lastInput = { seq: session.inputSeq, origin, text, at: now() };
    if (force) {
      // 用户点了「仍然发送」：无视输入框判断，直接写进终端
      if (pty) pty.write(screen.bracketedPaste(text) + '\r');
      emit({ type: 'input', input: session.lastInput, queued: false, forced: true });
      return 'queued';
    }
    const result = queue.push({ seq: session.inputSeq, text, origin });
    emit({ type: 'input', input: session.lastInput, queued: result === 'queued' });
    return result;
  }

  function onPcKeys(data) {
    if (!pty) return;
    pty.write(data);
    if (data.includes('\r') || data.includes('\n')) {
      session.inputSeq += 1;
      session.lastInput = {
        seq: session.inputSeq, origin: 'pc', text: screen.inputLine(), at: now(),
      };
      emit({ type: 'pc-input', input: session.lastInput });
    }
  }

  function releaseTurn() {
    if (status !== 'running') return;
    status = 'idle';
    session.status = 'idle';
    queue.release();
  }

  function kill() {
    if (disposed) return;
    disposed = true;
    queue.drain();
    if (readyTimer) clearInterval(readyTimer);
    if (pty) pty.kill();
    screen.dispose();
  }

  return {
    session,
    start,
    submitText,
    onPcKeys,
    releaseTurn,
    kill,
    pollReady,
    _pollReady: pollReady,
    _queue: queue,
    needsConfirm() {
      // 空闲却没停在输入框（菜单/确认弹窗/程序已退出）→ 手机消息不能盲写
      return status === 'idle' && !screen.inInputBox();
    },
    snapshot() {
      return {
        id: session.id,
        chatId: session.chatId,
        agent: session.agent,
        cwd: session.cwd,
        alias: session.alias || null,
        status,
        pending: queue.pending(),
        lastInput: session.lastInput,
      };
    },
    get status() { return status; },
    get lastInput() { return session.lastInput; },
    get screen() { return screen; },
  };
}

module.exports = { createPtySession };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/ptySession.test.js`
预期：`# pass 10`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/ptySession.js test/ptySession.test.js
git commit -m "feat: 单会话运行态（PTY + 屏幕 + 队列 + 状态机）"
```

---

### 任务 10：飞书 REST 层

**文件：**
- 创建：`src/feishu/api.js`
- 测试：`test/feishu-api.test.js`

> 只用 SDK 做长连接，REST 全部走 `fetch` 打开放平台端点。这样接口形状由我们自己锁定，能用假 `fetch` 全量测试，也不受 SDK 版本升级影响。

- [ ] **步骤 1：编写失败的测试**

```js
// test/feishu-api.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createApi, FeishuError } = require('../src/feishu/api');

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const out = handler({ url: String(url), method: opts.method || 'GET', body: opts.body });
    if (out && out.__raw !== undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => { throw new Error('not json'); },
        text: async () => '',
        arrayBuffer: async () => out.__raw,
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => out,
      text: async () => JSON.stringify(out),
      arrayBuffer: async () => Buffer.from(''),
    };
  };
  fn.calls = calls;
  return fn;
}

function apiWith(handler) {
  const fetchImpl = fakeFetch(handler);
  let clock = 1_000_000;
  const api = createApi({
    appId: 'cli_x',
    appSecret: 'sec',
    fetchImpl,
    now: () => clock,
    baseUrl: 'https://open.feishu.cn',
  });
  return {
    api,
    fetchImpl,
    advance: (ms) => { clock += ms; },
    calls: fetchImpl.calls,
  };
}

const tokenRoute = (url, body) => {
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    return { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200, __echo: body };
  }
  return null;
};

test('token 被缓存：两次调用只取一次 token', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  await api.sendText('oc_1', '你好');
  await api.sendText('oc_1', '第二句');
  const tokenCalls = calls.filter((c) => c.url.includes('tenant_access_token'));
  assert.strictEqual(tokenCalls.length, 1);
});

test('token 过期后自动刷新', async () => {
  const { api, calls, advance } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  await api.sendText('oc_1', 'a');
  advance(7200 * 1000 + 1000);
  await api.sendText('oc_1', 'b');
  assert.strictEqual(calls.filter((c) => c.url.includes('tenant_access_token')).length, 2);
});

test('sendText 的 body 形状正确（content 是 JSON 字符串）', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  const id = await api.sendText('oc_1', '你好');
  assert.strictEqual(id, 'om_1');
  const send = calls.find((c) => c.url.includes('/open-apis/im/v1/messages?'));
  assert.ok(send);
  const body = JSON.parse(send.opts.body);
  assert.strictEqual(body.receive_id, 'oc_1');
  assert.strictEqual(body.msg_type, 'text');
  assert.deepStrictEqual(JSON.parse(body.content), { text: '你好' });
});

test('业务错误码抛 FeishuError 并带 code', async () => {
  const { api } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 99991663, msg: 'no scope' }
  ));
  await assert.rejects(
    () => api.sendText('oc_1', 'x'),
    (err) => err instanceof FeishuError && err.code === 99991663 && err.message.includes('no scope'),
  );
});

test('createGroup 传 user_id_list 并返回 chat_id', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { chat_id: 'oc_new' } }
  ));
  const chatId = await api.createGroup('卡牌', ['ou_owner']);
  assert.strictEqual(chatId, 'oc_new');
  const call = calls.find((c) => c.url.includes('/open-apis/im/v1/chats?'));
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.name, '卡牌');
  assert.deepStrictEqual(body.user_id_list, ['ou_owner']);
  assert.strictEqual(body.chat_mode, 'group');
});

test('getChat 遇到 230002（群不存在）返回 null，其他错误照抛', async () => {
  const gone = apiWith(({ url }) => (
    tokenRoute(url) || { code: 230002, msg: 'chat not found' }
  ));
  assert.strictEqual(await gone.api.getChat('oc_gone'), null);

  const other = apiWith(({ url }) => (
    tokenRoute(url) || { code: 99991672, msg: 'forbidden' }
  ));
  await assert.rejects(() => other.api.getChat('oc_x'), (e) => e.code === 99991672);
});

test('downloadResource 返回 Buffer', async () => {
  const { api } = apiWith(({ url }) => (
    tokenRoute(url) || { __raw: Buffer.from('PNGDATA') }
  ));
  const buf = await api.downloadResource('om_1', 'file_key_1', 'image');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString(), 'PNGDATA');
});

test('updateCardEntity 带上 sequence 与 uuid', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: {} }
  ));
  await api.updateCardEntity('card_1', { schema: '2.0' }, 3);
  const call = calls.find((c) => c.url.includes('/cardkit/v1/cards/card_1'));
  assert.strictEqual(call.opts.method, 'PUT');
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.sequence, 3);
  assert.strictEqual(body.card.type, 'card_json');
  assert.deepStrictEqual(JSON.parse(body.card.data), { schema: '2.0' });
  assert.ok(body.uuid);
});

test('getBotInfo 读顶层 bot 字段（该接口没有 data 包装）', async () => {
  const { api } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', bot: { app_name: '飞书桥', open_id: 'ou_bot' } }
  ));
  const info = await api.getBotInfo();
  assert.strictEqual(info.app_name, '飞书桥');
  assert.strictEqual(info.open_id, 'ou_bot');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/feishu-api.test.js`
预期：FAIL，`Cannot find module '../src/feishu/api'`

- [ ] **步骤 3：编写实现**

```js
// src/feishu/api.js
class FeishuError extends Error {
  constructor(code, msg, path) {
    super(`Feishu ${code}: ${msg} (${path})`);
    this.name = 'FeishuError';
    this.code = code;
    this.path = path;
  }
}

const CHAT_NOT_FOUND = 230002;

function createApi({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  baseUrl = 'https://open.feishu.cn',
  now = () => Date.now(),
}) {
  let token = null;
  let tokenExp = 0;
  let inflight = null;

  function getToken(force = false) {
    if (!force && token && now() < tokenExp - 60000) return Promise.resolve(token);
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const json = await res.json();
      if (json.code !== 0) {
        throw new FeishuError(json.code, json.msg, '/open-apis/auth/v3/tenant_access_token/internal');
      }
      token = json.tenant_access_token;
      tokenExp = now() + json.expire * 1000;
      return token;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function request(method, path, { query, body, raw = false } = {}) {
    const t = await getToken();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetchImpl(`${baseUrl}${path}${qs}`, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) {
      if (!res.ok) throw new FeishuError(res.status, await res.text(), path);
      return Buffer.from(await res.arrayBuffer());
    }
    const json = await res.json();
    if (json.code !== 0) throw new FeishuError(json.code, json.msg, path);
    return json.data;
  }

  const sendMessage = async (chatId, msgType, content) => {
    const data = await request('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
    });
    return data.message_id;
  };

  return {
    token: getToken,

    sendText: (chatId, text) => sendMessage(chatId, 'text', { text }),

    sendCard: (chatId, card) => sendMessage(chatId, 'interactive', card),

    createCardEntity: async (card) => {
      const data = await request('POST', '/open-apis/cardkit/v1/cards', {
        body: { type: 'card_json', data: JSON.stringify(card) },
      });
      return data.card_id;
    },

    updateCardEntity: (cardId, card, sequence) => request('PUT', `/open-apis/cardkit/v1/cards/${cardId}`, {
      body: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence,
        uuid: `${cardId}-${sequence}`,
      },
    }),

    sendCardEntity: (chatId, cardId) => sendMessage(chatId, 'interactive', {
      type: 'card', data: { card_id: cardId },
    }),

    createGroup: async (name, openIds) => {
      const data = await request('POST', '/open-apis/im/v1/chats', {
        query: { user_id_type: 'open_id' },
        body: { name, chat_mode: 'group', chat_type: 'private', user_id_list: openIds },
      });
      return data.chat_id;
    },

    getChat: async (chatId) => {
      try {
        return await request('GET', `/open-apis/im/v1/chats/${chatId}`);
      } catch (err) {
        if (err instanceof FeishuError && err.code === CHAT_NOT_FOUND) return null;
        throw err;
      }
    },

    disbandChat: (chatId) => request('DELETE', `/open-apis/im/v1/chats/${chatId}`),

    downloadResource: (messageId, fileKey, type) => request(
      'GET',
      `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
      { query: { type }, raw: true },
    ),

    getBotInfo: async () => {
      // bot/v3/info 把结果放在顶层 bot 字段，没有 data 包装，不能复用 request
      const t = await getToken();
      const res = await fetchImpl(`${baseUrl}/open-apis/bot/v3/info`, {
        method: 'GET',
        headers: { authorization: `Bearer ${t}` },
      });
      const json = await res.json();
      if (json.code !== 0) throw new FeishuError(json.code, json.msg, '/open-apis/bot/v3/info');
      return json.bot;
    },
  };
}

module.exports = { createApi, FeishuError };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/feishu-api.test.js`
预期：`# pass 9`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/feishu/api.js test/feishu-api.test.js
git commit -m "feat: 飞书 REST 层（token 缓存、消息、群、资源、CardKit）"
```

---

### 任务 11：飞书卡片构造层

**文件：**
- 创建：`src/feishu/cards.js`
- 测试：`test/feishu-cards.test.js`

> 卡片全部用 schema 2.0（CardKit 实体更新要求 2.0）。这里只产出纯 JSON，不碰网络，所以能用断言逐字段检查。

- [ ] **步骤 1：编写失败的测试**

```js
// test/feishu-cards.test.js
const test = require('node:test');
const assert = require('node:assert');
const cards = require('../src/feishu/cards');

test('truncate：未超限时原样返回', () => {
  const r = cards.truncate('短文本');
  assert.deepStrictEqual(r, { text: '短文本', truncated: false });
});

test('truncate：超限时保留头尾并标注截断', () => {
  const long = 'A'.repeat(9000) + 'END';
  const r = cards.truncate(long, 8000);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.text.length < long.length);
  assert.ok(r.text.includes('已截断'));
  assert.ok(r.text.endsWith('END'));
  assert.ok(r.text.startsWith('AAAA'));
});

test('所有卡片都是可序列化的 2.0 卡片', () => {
  const all = [
    cards.processingCard({ agent: 'claude', prompt: '改地形' }),
    cards.replyCard({ text: '**完成**', agent: 'claude', cwd: 'D:/x' }),
    cards.screenCard({ text: 'screen text', reason: 'not-ready' }),
    cards.noticeCard({ title: '已停止', text: '会话被关闭' }),
    cards.errorCard({ title: '出错了', text: 'boom' }),
  ];
  for (const c of all) {
    assert.strictEqual(c.schema, '2.0');
    assert.ok(Array.isArray(c.body.elements));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(c)));
  }
});

test('processingCard 标题含「正在处理」', () => {
  const c = cards.processingCard({ agent: 'codex', prompt: '看看这个 bug' });
  assert.match(c.header.title.content, /正在处理/);
  const json = JSON.stringify(c);
  assert.ok(json.includes('看看这个 bug'));
});

test('replyCard 把正文放进 markdown 元素', () => {
  const c = cards.replyCard({ text: '第一行\n第二行', agent: 'claude', cwd: 'D:/feishu-workspace' });
  const md = c.body.elements.find((e) => e.tag === 'markdown');
  assert.ok(md);
  assert.ok(md.content.includes('第一行\n第二行'));
  assert.ok(JSON.stringify(c).includes('D:/feishu-workspace'));
});

test('screenCard 带「仍然发送」回调按钮', () => {
  const c = cards.screenCard({ text: '当前画面', reason: 'not-ready' });
  const btn = c.body.elements.find((e) => e.tag === 'button');
  assert.ok(btn);
  assert.strictEqual(btn.text.content, '仍然发送');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'force-send' });
});

test('errorCard 用红色标题', () => {
  const c = cards.errorCard({ title: '出错了', text: 'x' });
  assert.strictEqual(c.header.template, 'red');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/feishu-cards.test.js`
预期：FAIL，`Cannot find module '../src/feishu/cards'`

- [ ] **步骤 3：编写实现**

```js
// src/feishu/cards.js
const MAX_CARD_CHARS = 8000;
const TAIL_CHARS = 1500;

function truncate(text, limit = MAX_CARD_CHARS) {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  const tail = text.slice(-TAIL_CHARS);
  const omitted = Math.max(0, text.length - limit - TAIL_CHARS);
  return {
    text: `${head}\n\n…（已截断 ${omitted} 字，完整内容见附件）\n\n${tail}`,
    truncated: true,
  };
}

function card({ title, template = 'blue', elements }) {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

const md = (content) => ({ tag: 'markdown', content });
const note = (content) => ({ tag: 'markdown', content: `<font color='grey'>${content}</font>` });

function footer({ agent, cwd }) {
  const bits = [];
  if (agent) bits.push(agent === 'codex' ? 'Codex' : 'Claude');
  if (cwd) bits.push(cwd);
  return bits.length ? note(bits.join(' · ')) : null;
}

const elements = (...items) => items.filter(Boolean);

function processingCard({ agent, prompt }) {
  return card({
    title: '⏳ 正在处理…',
    template: 'blue',
    elements: elements(
      md(truncate(prompt || '（无输入）', 2000).text),
      { tag: 'hr' },
      footer({ agent }),
    ),
  });
}

function replyCard({ text, agent, cwd }) {
  const { text: body, truncated } = truncate(text || '（空回复）');
  return card({
    title: truncated ? '✅ 回复（已截断）' : '✅ 回复',
    template: 'green',
    elements: elements(
      md(body),
      truncated ? note('内容过长已截断，完整输出请到电脑上看。') : null,
      footer({ agent, cwd }),
    ),
  });
}

function screenCard({ text, reason }) {
  const why = reason === 'not-ready'
    ? '会话当前不在可输入状态，下面是你手机屏幕上的内容：'
    : '最近一次会话画面：';
  return card({
    title: '🖥 当前画面',
    template: 'orange',
    elements: elements(
      md(why),
      { tag: 'hr' },
      md('```\n' + truncate(text || '（无画面）', 6000).text + '\n```'),
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '仍然发送' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: { act: 'force-send' } }],
      },
      note('也可以直接回复「仍然发送」四个字。'),
    ),
  });
}

function noticeCard({ title, text, template = 'grey' }) {
  return card({
    title,
    template,
    elements: elements(text ? md(truncate(text).text) : null),
  });
}

function errorCard({ title, text }) {
  return card({
    title,
    template: 'red',
    elements: elements(text ? md(truncate(text).text) : null),
  });
}

module.exports = {
  MAX_CARD_CHARS,
  card,
  truncate,
  processingCard,
  replyCard,
  screenCard,
  noticeCard,
  errorCard,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/feishu-cards.test.js`
预期：`# pass 7`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/feishu/cards.js test/feishu-cards.test.js
git commit -m "feat: 飞书卡片构造层（处理中/回复/画面/提示/错误）"
```

---

### 任务 12：终端屏幕快照层

**文件：**
- 创建：`src/screen.js`
- 测试：`test/screen.test.js`

> 顺序说明：任务 9 的 `createPtySession` 只接收注入的 `screenFactory`，测试里用假对象，所以本任务放在它之后不影响 TDD 顺序；真实终端实现在组装守护进程（任务 21）时才被注入。

- [ ] **步骤 1：编写失败的测试**

```js
// test/screen.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createScreen } = require('../src/screen');

function fakeTerminal(opts) {
  const t = {
    opts,
    lines: ['line0', 'line1', 'line2', 'line3'],
    wrapped: new Set(),
    writes: [],
    modes: { bracketedPasteMode: true },
    buffer: {
      active: {
        baseY: 0,
        cursorY: 3,
        cursorX: 0,
        length: 4,
        getLine(y) {
          if (y < 0 || y >= t.lines.length) return undefined;
          return {
            isWrapped: t.wrapped.has(y),
            translateToString: () => t.lines[y],
          };
        },
      },
    },
    write(data, cb) {
      t.writes.push(data);
      if (cb) setImmediate(cb);
    },
    resize(c, r) { t.size = [c, r]; },
    dispose() { t.disposed = true; },
  };
  return t;
}

function setup({ quietMs = 400 } = {}) {
  let terminal;
  let clock = 10_000;
  const screen = createScreen({
    quietMs,
    now: () => clock,
    terminalFactory: (opts) => (terminal = fakeTerminal(opts)),
  });
  return { screen, terminal: () => terminal, advance: (ms) => { clock += ms; } };
}

test('构造时传 allowProposedApi，否则 buffer 不可用', () => {
  const { terminal } = setup();
  assert.strictEqual(terminal().opts.allowProposedApi, true);
  assert.strictEqual(terminal().opts.cols, 120);
  assert.strictEqual(terminal().opts.rows, 30);
});

test('write 转发到终端并等解析完成', async () => {
  const { screen, terminal } = setup();
  await screen.write('hello');
  assert.deepStrictEqual(terminal().writes, ['hello']);
});

test('没收到数据前 isReady 为 false；收到后需静默满 quietMs', async () => {
  const { screen, terminal, advance } = setup({ quietMs: 400 });
  assert.strictEqual(screen.isReady(), false);

  await screen.write('x');
  assert.strictEqual(screen.isReady(), false);
  advance(399);
  assert.strictEqual(screen.isReady(), false);
  advance(1);
  assert.strictEqual(screen.isReady(), true);

  await screen.write('y');
  assert.strictEqual(screen.isReady(), false);
  assert.ok(terminal().writes.length === 2);
});

test('bracketedPaste 按终端当前模式包裹', () => {
  const { screen, terminal } = setup();
  assert.strictEqual(screen.bracketedPaste('你好'), '\x1b[200~你好\x1b[201~');

  terminal().modes.bracketedPasteMode = false;
  assert.strictEqual(screen.bracketedPaste('你好'), '你好');
});

test('snapshot 取最近 N 行并去掉尾部空行', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['a', 'b', 'c', 'd', 'e', ''];
  terminal().buffer.active.cursorY = 5;
  // 光标在第 5 行，取最近 3 行即 y=3..5：'d'、'e'、末尾空行（被裁掉）
  const text = screen.snapshot({ lines: 3 });
  assert.strictEqual(text, 'd\ne');
});

test('snapshot 用 baseY + cursorY 定位，不用 cursorY', () => {
  const { screen, terminal } = setup();
  terminal().buffer.active.baseY = 100;
  terminal().buffer.active.cursorY = 2;
  terminal().lines = ['a', 'b', 'c', 'd', 'e'];
  terminal().buffer.active.getLine = (y) => ({
    isWrapped: false,
    translateToString: () => `row${y}`,
  });
  const text = screen.snapshot({ lines: 3 });
  assert.strictEqual(text, 'row100\nrow101\nrow102');
});

test('snapshot 拼接被自动换行的物理行', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['abc', 'def', 'X'];
  terminal().buffer.active.cursorY = 2;
  terminal().wrapped.add(1);
  assert.strictEqual(screen.snapshot({ lines: 3 }), 'abcdef\nX');
});

test('inputLine 取最近一行 ❯ 提示符后面的内容', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['前一屏输出', '❯ 现在几点了'];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inputLine(), '现在几点了');

  terminal().lines = ['❯ 旧输入', '输出', '❯ '];
  terminal().buffer.active.cursorY = 2;
  assert.strictEqual(screen.inputLine(), '');
});

test('inInputBox：有 ❯ 输入框为 true，菜单光标/无提示符为 false', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['输出', '❯ '];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), true);

  terminal().lines = ['Do you want to proceed?', '❯ 1. Yes', '  2. No, tell Claude what to do differently'];
  terminal().buffer.active.cursorY = 2;
  assert.strictEqual(screen.inInputBox(), false);

  terminal().lines = ['PS D:\\feishu-workspace> '];
  terminal().buffer.active.cursorY = 0;
  assert.strictEqual(screen.inInputBox(), false);
});

test('resize / dispose 透传', () => {
  const { screen, terminal } = setup();
  screen.resize(100, 20);
  assert.deepStrictEqual(terminal().size, [100, 20]);
  screen.dispose();
  assert.strictEqual(terminal().disposed, true);
  assert.strictEqual(screen.isReady(), false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/screen.test.js`
预期：FAIL，`Cannot find module '../src/screen'`

- [ ] **步骤 3：编写实现**

```js
// src/screen.js
const { Terminal } = require('@xterm/headless');

const BRACKET_OPEN = '\x1b[200~';
const BRACKET_CLOSE = '\x1b[201~';

function createScreen({
  cols = 120,
  rows = 30,
  scrollback = 5000,
  quietMs = 400,
  now = () => Date.now(),
  terminalFactory = (opts) => new Terminal(opts),
} = {}) {
  // allowProposedApi 必须为 true，否则访问 term.buffer 会直接抛错
  const term = terminalFactory({ cols, rows, scrollback, allowProposedApi: true });
  let lastDataAt = 0;
  let disposed = false;

  // 取末尾 n 个物理行（不拼接换行），去掉尾部空行
  function tailLines(n) {
    const buf = term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const start = Math.max(0, end - n + 1);
    const out = [];
    for (let y = start; y <= end; y += 1) {
      const line = buf.getLine(y);
      if (line) out.push(line.translateToString(true));
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  const screen = {
    write(data) {
      if (disposed) return Promise.resolve();
      lastDataAt = now();
      return new Promise((resolve) => term.write(data, resolve));
    },

    get bracketedPasteMode() {
      return Boolean(term.modes && term.modes.bracketedPasteMode);
    },

    bracketedPaste(text) {
      return screen.bracketedPasteMode
        ? `${BRACKET_OPEN}${text}${BRACKET_CLOSE}`
        : text;
    },

    isReady() {
      return !disposed && lastDataAt > 0 && now() - lastDataAt >= quietMs;
    },

    snapshot({ lines = 40 } = {}) {
      if (disposed) return '';
      const buf = term.buffer.active;
      // 当前光标所在的绝对缓冲区行 = baseY + cursorY
      const end = buf.baseY + buf.cursorY;
      const start = Math.max(0, end - lines + 1);
      const out = [];
      for (let y = start; y <= end; y += 1) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
        else out.push(text);
      }
      while (out.length > 0 && out[out.length - 1] === '') out.pop();
      return out.join('\n');
    },

    inputLine() {
      if (disposed) return '';
      const lines = tailLines(12);
      // 从下往上找最近的 ❯ 提示符，取提示符之后的内容
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const m = lines[i].match(/❯\s*(.*)$/);
        if (m) return m[1].trim();
      }
      // 没有提示符（例如 shell 提示符）时退回最后一行非空文本
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]) return lines[i].trim();
      }
      return '';
    },

    inInputBox() {
      if (disposed) return false;
      const lines = tailLines(15);
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].includes('❯')) { idx = i; break; }
      }
      if (idx < 0) return false;
      // 菜单/确认弹窗的光标也是 ❯，但它后面跟着「1. Yes」这类序号
      return !/^❯?\s*\d+[.)]\s/.test(lines[idx].trim());
    },

    resize(nextCols, nextRows) {
      if (!disposed) term.resize(nextCols, nextRows);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },

    get lastDataAt() {
      return lastDataAt;
    },
  };

  return screen;
}

module.exports = { createScreen };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/screen.test.js`
预期：`# pass 10`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/screen.js test/screen.test.js
git commit -m "feat: 终端屏幕快照层（headless xterm + 就绪判定 + bracketed paste）"
```

---

### 任务 13：飞书长连接 + 事件分发

**文件：**
- 创建：`src/feishu/ws.js`
- 测试：`test/feishu-ws.test.js`

> 已核实的 SDK 事实（`@larksuiteoapi/node-sdk@1.77.0`，证据行号见 `types/index.d.ts` 与 `lib/index.js`）：
> 1. **回调收到的是拍平对象**——SDK 把 `header` 和 `event` 合并到顶层，所以去重键是 `data.event_id`，`data.header` 不存在；消息在 `data.message`，发送者在 `data.sender.sender_id.open_id`。
> 2. `WSClient` 只有 `close()`，没有 `stop()`；`close({force:true})` 是强杀。
> 3. `start()` 不会等连接就绪，只发起重连。
> 4. 静默用 `loggerLevel: LoggerLevel.fatal`（0）。

- [ ] **步骤 1：编写失败的测试**

```js
// test/feishu-ws.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createFeishuWs, createDedup } = require('../src/feishu/ws');

function makeSdk() {
  const registered = {};
  const state = { clientOpts: null, startArgs: null, closed: false };
  class EventDispatcher {
    register(map) {
      Object.assign(registered, map);
      return this;
    }
  }
  class WSClient {
    constructor(opts) { state.clientOpts = opts; }
    start(args) { state.startArgs = args; return Promise.resolve(); }
    close() { state.closed = true; }
  }
  const sdk = {
    EventDispatcher,
    WSClient,
    LoggerLevel: { fatal: 0, error: 1, info: 3 },
    Domain: { Feishu: 0, Lark: 1 },
  };
  return { sdk, registered, state };
}

function setup(extra = {}) {
  const { sdk, registered, state } = makeSdk();
  const logs = [];
  const calls = { message: [], disbanded: [], botRemoved: [], botAdded: [], cardAction: [] };
  const ws = createFeishuWs({
    appId: 'cli_0123456789abcdef',
    appSecret: 'sec',
    sdk,
    log: { error: (m) => logs.push(m), info: () => {}, debug: () => {} },
    handlers: {
      onMessage: (d) => { calls.message.push(d); },
      onDisbanded: (d) => { calls.disbanded.push(d); },
      onBotRemoved: (d) => { calls.botRemoved.push(d); },
      onBotAdded: (d) => { calls.botAdded.push(d); },
      onCardAction: (d) => { calls.cardAction.push(d); },
    },
    ...extra,
  });
  return { ws, registered, state, logs, calls };
}

test('注册五个事件', () => {
  const { registered } = setup();
  assert.deepStrictEqual(Object.keys(registered).sort(), [
    'card.action.trigger',
    'im.chat.disbanded_v1',
    'im.chat.member.bot.added_v1',
    'im.chat.member.bot.deleted_v1',
    'im.message.receive_v1',
  ]);
});

test('start 传入 dispatcher；客户端静默日志', async () => {
  const { ws, state } = setup();
  await ws.start();
  assert.ok(state.startArgs.eventDispatcher);
  assert.strictEqual(state.clientOpts.appId, 'cli_0123456789abcdef');
  assert.strictEqual(state.clientOpts.loggerLevel, 0);
  assert.strictEqual(state.clientOpts.domain, 0);
});

test('消息事件以拍平对象下发（event_id 在顶层）', async () => {
  const { registered, calls } = setup();
  const payload = {
    event_id: 'ev_1',
    event_type: 'im.message.receive_v1',
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"你好"}',
    },
  };
  await registered['im.message.receive_v1'](payload);
  assert.strictEqual(calls.message.length, 1);
  assert.strictEqual(calls.message[0].event_id, 'ev_1');
  assert.strictEqual(calls.message[0].message.chat_id, 'oc_1');
});

test('相同 event_id 只处理一次（飞书会重投）', async () => {
  const { registered, calls } = setup();
  const payload = { event_id: 'ev_dup', message: { chat_id: 'oc_1' } };
  await registered['im.message.receive_v1'](payload);
  await registered['im.message.receive_v1'](payload);
  await registered['im.message.receive_v1']({ ...payload });
  assert.strictEqual(calls.message.length, 1);
});

test('没有 event_id 的事件不参与去重', async () => {
  const { registered, calls } = setup();
  await registered['im.message.receive_v1']({ message: { chat_id: 'oc_1' } });
  await registered['im.message.receive_v1']({ message: { chat_id: 'oc_1' } });
  assert.strictEqual(calls.message.length, 2);
});

test('处理器抛同步错误不会冒泡，写错误日志', async () => {
  const s = setup({ handlers: { onMessage: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => {
    s.registered['im.message.receive_v1']({ event_id: 'e_sync' });
  });
  assert.ok(s.logs.some((m) => m.includes('boom')));
});

test('处理器返回 rejected promise 不会造成未捕获拒绝', async () => {
  const s = setup({ handlers: { onMessage: async () => { throw new Error('async boom'); } } });
  await s.registered['im.message.receive_v1']({ event_id: 'e_async' });
  await new Promise((r) => setImmediate(r));
  assert.ok(s.logs.some((m) => m.includes('async boom')));
});

test('机器人被拉进群路由到 onBotAdded', async () => {
  const { registered, calls } = setup();
  await registered['im.chat.member.bot.added_v1']({
    event_id: 'ev_added',
    chat_id: 'oc_9',
    operator_id: { open_id: 'ou_owner' },
  });
  assert.strictEqual(calls.botAdded.length, 1);
  assert.strictEqual(calls.botAdded[0].operator_id.open_id, 'ou_owner');
});

test('卡片按钮回调路由到 onCardAction', async () => {
  const { registered, calls } = setup();
  await registered['card.action.trigger']({
    event_id: 'ev_card',
    operator: { open_id: 'ou_owner' },
    action: { value: { act: 'force-send' } },
    context: { open_chat_id: 'oc_1' },
  });
  assert.strictEqual(calls.cardAction.length, 1);
  assert.deepStrictEqual(calls.cardAction[0].action.value, { act: 'force-send' });
});

test('close 走 WSClient.close', () => {
  const { ws, state } = setup();
  ws.close();
  assert.strictEqual(state.closed, true);
});

test('createDedup 在 ttl 之后允许同 id 再次通过', () => {
  let clock = 0;
  const dedup = createDedup({ ttl: 1000, now: () => clock });
  assert.strictEqual(dedup.isDuplicate('a'), false);
  assert.strictEqual(dedup.isDuplicate('a'), true);
  clock = 1001;
  assert.strictEqual(dedup.isDuplicate('a'), false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/feishu-ws.test.js`
预期：FAIL，`Cannot find module '../src/feishu/ws'`

- [ ] **步骤 3：编写实现**

```js
// src/feishu/ws.js
function createDedup({ ttl = 10 * 60 * 1000, max = 5000, now = () => Date.now() } = {}) {
  const seen = new Map();

  function sweep(t) {
    for (const [key, at] of seen) {
      if (t - at > ttl) seen.delete(key);
    }
  }

  return {
    isDuplicate(id) {
      if (!id) return false;
      const t = now();
      if (seen.size >= max) sweep(t);
      const prev = seen.get(id);
      if (prev !== undefined && t - prev <= ttl) return true;
      seen.set(id, t);
      return false;
    },
    size: () => seen.size,
  };
}

/**
 * handlers 约定：
 *   onMessage(data)       —— im.message.receive_v1
 *   onDisbanded(data)     —— im.chat.disbanded_v1
 *   onBotRemoved(data)    —— im.chat.member.bot.deleted_v1
 *   onBotAdded(data)      —— im.chat.member.bot.added_v1（自己把机器人拉进群 → 发自我介绍）
 *   onCardAction(data)    —— card.action.trigger
 *
 * 处理器只做「入队」这类立即返回的事，重活由调用方自己的串行队列完成，
 * 这样飞书 3 秒 ack 窗口不会被拖爆。
 */
function createFeishuWs({
  appId,
  appSecret,
  sdk,
  handlers = {},
  log,
  dedup = createDedup(),
  domain,
}) {
  const Lark = sdk || require('@larksuiteoapi/node-sdk');

  function dispatch(name, data) {
    if (data && data.event_id && dedup.isDuplicate(data.event_id)) {
      log?.debug?.(`ws: duplicate ${name} ${data.event_id}`);
      return;
    }
    const fn = handlers[name];
    if (!fn) return;
    try {
      const ret = fn(data);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => log?.error?.(`ws: handler ${name} failed: ${err && err.message}`));
      }
    } catch (err) {
      log?.error?.(`ws: handler ${name} threw: ${err && err.message}`);
    }
  }

  const dispatcher = new Lark.EventDispatcher({});
  dispatcher.register({
    'im.message.receive_v1': (data) => dispatch('onMessage', data),
    'im.chat.disbanded_v1': (data) => dispatch('onDisbanded', data),
    'im.chat.member.bot.deleted_v1': (data) => dispatch('onBotRemoved', data),
    'im.chat.member.bot.added_v1': (data) => dispatch('onBotAdded', data),
    'card.action.trigger': (data) => dispatch('onCardAction', data),
  });

  const client = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.fatal,
    domain: domain === undefined ? Lark.Domain.Feishu : domain,
  });

  return {
    start: () => client.start({ eventDispatcher: dispatcher }),
    close: () => client.close(),
  };
}

module.exports = { createFeishuWs, createDedup };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/feishu-ws.test.js`
预期：`# pass 11`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/feishu/ws.js test/feishu-ws.test.js
git commit -m "feat: 飞书长连接与事件分发（快速返回 + 去重 + 卡片回调）"
```

---

### 任务 14：`npm run setup` 自检向导

**文件：**
- 创建：`src/setup.js`
- 创建：`bin/setup.js`
- 创建：`test/setup.test.js`
- 修改：`package.json:7-10`（加 `setup` 脚本）

**为什么需要它：** 飞书后台的坑几乎全在配置细节上——App ID 抄错一位、Secret 重置过、权限没勾、版本没发布、事件订阅没开、连接方式选了 Webhook。这些错误在 daemon 里只会表现为「连不上」，用户无法自查。向导把每一环单独点验，失败时直接给出该去哪个页面改什么。

- [ ] **步骤 1：编写失败的测试**

```js
// test/setup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetup } = require('../src/setup');
const { FeishuError } = require('../src/feishu/api');

const P2P = {
  event_id: 'ev_1',
  message: { chat_id: 'oc_p2p', chat_type: 'p2p', content: '{"text":"你好"}' },
  sender: { sender_id: { open_id: 'ou_owner' } },
};

function fakeApi({ failToken, failCard } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      token: async () => { if (failToken) throw failToken; return 't-1'; },
      getBotInfo: async () => ({ app_name: '飞书桥' }),
      createGroup: async (name, openIds) => { calls.push(['createGroup', name, openIds]); return 'oc_group'; },
      sendText: async (chatId, text) => { calls.push(['sendText', chatId, text]); return 'om_1'; },
      sendCard: async (chatId, card) => {
        calls.push(['sendCard', chatId, card]);
        if (failCard) throw failCard;
        return 'om_2';
      },
      disbandChat: async (chatId) => { calls.push(['disbandChat', chatId]); },
    },
  };
}

function harness({ answers, api, evt = P2P, timeoutMs = 100 } = {}) {
  const saved = [];
  const configs = [];
  const lines = [];
  let apiCreated = 0;
  const setup = createSetup({
    prompt: async () => answers.shift(),
    createApi: () => { apiCreated += 1; return api; },
    createWs: ({ handlers }) => ({
      start() { setImmediate(() => { if (evt) handlers.onMessage(evt); }); },
      close() { lines.push('ws closed'); },
    }),
    loadConfigFn: () => ({ appId: '', queueLimit: 20 }),
    saveConfigFn: (file, config) => configs.push({ file, config }),
    secretStore: { save: (v) => saved.push(v) },
    configPath: 'D:/tmp/test-config.json',
    timeoutMs,
    print: (line) => lines.push(line),
  });
  return { setup, saved, configs, lines, apiCreated: () => apiCreated };
}

test('App ID 格式不对：不创建 API、不写配置', async () => {
  const h = harness({ answers: ['cli_bad', 'sec'], api: fakeApi().api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(h.apiCreated(), 0);
  assert.strictEqual(h.configs.length, 0);
  assert.match(res.steps[0].detail, /cli_/);
});

test('token 失败：给出「发布版本」提示', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi({ failToken: new FeishuError(99991663, 'no scope', '/x') }).api,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.match(res.steps.find((s) => !s.ok).detail, /版本/);
});

test('收到群消息而不是私聊：提示改成私聊', async () => {
  const evt = { ...P2P, message: { ...P2P.message, chat_type: 'group' } };
  const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: fakeApi().api, evt });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.match(res.steps.at(-1).detail, /私聊/);
});

test('全流程成功：建房 → 文本 → 卡片 → 解散 → 写配置', async () => {
  const f = fakeApi();
  const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: f.api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(f.calls.map((c) => c[0]), ['createGroup', 'sendText', 'sendCard', 'disbandChat']);
  assert.deepStrictEqual(f.calls[0][2], ['ou_owner']);
  assert.deepStrictEqual(h.saved, ['sec']);
  assert.strictEqual(h.configs.length, 1);
  assert.strictEqual(h.configs[0].config.appId, 'cli_0123456789abcdef');
  assert.strictEqual(h.configs[0].config.ownerOpenId, 'ou_owner');
  assert.strictEqual(h.configs[0].config.ownerChatId, 'oc_p2p');
  assert.strictEqual(h.configs[0].config.queueLimit, 20); // 原配置保留
  assert.ok(res.steps.every((s) => s.ok));
});

test('卡片发送失败不阻断，仍写配置', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi({ failCard: new FeishuError(99991672, 'forbidden', '/x') }).api,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(h.configs.length, 1);
  const cardStep = res.steps.find((s) => s.name.includes('卡片'));
  assert.strictEqual(cardStep.ok, false);
  assert.match(cardStep.detail, /可先不管/);
});

test('长连接等待超时：提示检查事件订阅与发布状态', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi().api,
    evt: null,
    timeoutMs: 20,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.match(res.steps.at(-1).detail, /im\.message\.receive_v1/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/setup.test.js`
预期：FAIL，`Cannot find module '../src/setup'`

- [ ] **步骤 3：编写实现**

```js
// src/setup.js
const {
  createApi: defaultCreateApi,
} = require('./feishu/api');
const { createFeishuWs: defaultCreateWs } = require('./feishu/ws');
const { loadConfig, saveConfig } = require('./config');
const { noticeCard } = require('./feishu/cards');

const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;

const HINTS = {
  10003: 'App ID 不存在，去「凭证与基础信息」重新复制。',
  10014: 'App Secret 不正确，去「凭证与基础信息」重置后复制。',
  99991663: '应用未发布：去「版本管理与发布」创建版本并申请发布，等审核通过。',
  99991672: '权限不足：去「权限管理」勾选 im:chat、im:message、cardkit:card，然后发布新版本。',
  99991679: '权限不足（事件/长连接）：确认「事件与回调」的连接方式是「长连接」。',
};

function hintFor(err) {
  const hint = HINTS[err && err.code];
  return hint ? `（${hint}）` : '';
}

function durationText(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} ${durationText(ms)}后仍未完成`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createSetup({
  prompt,
  createApi = defaultCreateApi,
  createWs = defaultCreateWs,
  loadConfigFn = loadConfig,
  saveConfigFn = saveConfig,
  secretStore,
  configPath,
  log = console,
  timeoutMs = 120000,
  print = () => {},
}) {
  const steps = [];

  function record(name, ok, detail = '') {
    steps.push({ name, ok, detail });
    print(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  }

  async function run() {
    steps.length = 0;
    print('打开 https://open.feishu.cn/app → 选你的应用 →「凭证与基础信息」，复制 App ID 与 App Secret。');

    const appId = String((await prompt('App ID（cli_ 开头）：')) ?? '').trim();
    if (!APP_ID_RE.test(appId)) {
      record('App ID 格式', false, '应形如 cli_0123456789abcdef（cli_ + 16 位十六进制）');
      return { ok: false, steps };
    }
    record('App ID 格式', true, appId);

    const appSecret = String((await prompt('App Secret：')) ?? '').trim();
    if (!appSecret) {
      record('App Secret', false, '不能为空');
      return { ok: false, steps };
    }

    const api = createApi({ appId, appSecret, log });

    try {
      await api.token();
      record('换取 tenant_access_token', true, '凭据有效');
    } catch (err) {
      record('换取 tenant_access_token', false, `${err.message}${hintFor(err)}`);
      return { ok: false, steps };
    }

    try {
      const info = await api.getBotInfo();
      record('读取机器人信息', true, (info && info.app_name) || 'ok');
    } catch (err) {
      record('读取机器人信息', false, `${err.message}${hintFor(err)}`);
      return { ok: false, steps };
    }

    print('现在用手机飞书给机器人发一条私聊消息（随便什么字都行）…');
    let resolveMsg;
    const got = new Promise((resolve) => { resolveMsg = resolve; });
    const ws = createWs({
      appId,
      appSecret,
      log,
      handlers: { onMessage: (evt) => resolveMsg(evt) },
    });
    ws.start();

    let evt;
    try {
      evt = await withTimeout(got, timeoutMs, '等待手机消息');
    } catch (err) {
      record('长连接收到消息', false,
        `${err.message}。请检查：订阅了 im.message.receive_v1、连接方式选「长连接」、应用已发布且你自己可用`);
      return { ok: false, steps };
    } finally {
      ws.close();
    }

    const chatId = evt && evt.message && evt.message.chat_id;
    const openId = evt && evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id;
    const chatType = evt && evt.message && evt.message.chat_type;
    if (!chatId || !openId) {
      record('长连接收到消息', false, '事件里缺少 chat_id / open_id，检查是否订阅了 im.message.receive_v1');
      return { ok: false, steps };
    }
    if (chatType !== 'p2p') {
      record('长连接收到消息', false, `收到的是群消息（chat_type=${chatType}），请改成跟机器人私聊`);
      return { ok: false, steps };
    }
    record('长连接收到消息', true, `chat_id=${chatId} open_id=${openId}`);

    let groupId;
    try {
      groupId = await api.createGroup(`飞书桥自测 ${new Date().toLocaleTimeString()}`, [openId]);
      record('创建测试群', true, groupId);
    } catch (err) {
      record('创建测试群', false, `${err.message}${hintFor(err)}`);
      return { ok: false, steps };
    }

    try {
      await api.sendText(groupId, '桥接测试：这条消息来自你的电脑。');
      record('发送文本消息', true);
    } catch (err) {
      record('发送文本消息', false, `${err.message}${hintFor(err)}`);
      try { await api.disbandChat(groupId); } catch { /* 清理失败不覆盖主错误 */ }
      return { ok: false, steps };
    }

    try {
      await api.sendCard(groupId, noticeCard({
        title: '卡片测试',
        text: '能看到这张卡片，说明卡片通道正常（按钮和「当前画面」都靠它）。',
      }));
      record('发送卡片消息', true);
    } catch (err) {
      record('发送卡片消息', false, `${err.message}${hintFor(err)}（可先不管：卡片失败只影响按钮，回复文字仍可用）`);
    }

    try {
      await api.disbandChat(groupId);
      record('解散测试群', true, groupId);
    } catch (err) {
      record('解散测试群', false, `${err.message}（手动删掉这个群即可）`);
    }

    secretStore.save(appSecret);
    saveConfigFn(configPath, {
      ...loadConfigFn(configPath),
      appId,
      ownerOpenId: openId,
      ownerChatId: chatId,
    });
    record('写入配置', true, `${configPath}（Secret 已单独加密保存）`);

    return { ok: true, steps };
  }

  return { run };
}

module.exports = { createSetup, APP_ID_RE };
```

```js
// bin/setup.js
const readline = require('node:readline');
const paths = require('../src/paths');
const { createSecretStore } = require('../src/secrets');
const { createSetup } = require('../src/setup');

async function main() {
  paths.ensureDirs();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const setup = createSetup({
    prompt: ask,
    secretStore: createSecretStore({ file: paths.SECRET, log: console }),
    configPath: paths.CONFIG,
    print: (line) => console.log(line),
    log: console,
  });

  let result;
  try {
    result = await setup.run();
  } finally {
    rl.close();
  }

  if (!result.ok) {
    console.log('\n自检没通过。照上面 ❌ 后面的提示改飞书后台，然后重新运行：npm run setup');
    process.exitCode = 1;
    return;
  }
  console.log('\n配置已保存。下一步：npm start');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

```json
// package.json（scripts 段落改成）
  "scripts": {
    "start": "node bin/daemon.js",
    "setup": "node bin/setup.js",
    "test": "node --test"
  },
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/setup.test.js`
预期：`# pass 6`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/setup.js bin/setup.js test/setup.test.js package.json
git commit -m "feat: 加 npm run setup 自检向导（凭据 / 长连接 / 建房 / 发卡片 全链路点验）"
```

### 任务 15：编排层（建会话：手机建群 / 电脑建群）

**文件：**
- 创建：`src/projects.js`
- 创建：`src/session/manager.js`
- 测试：`test/projects.test.js`
- 测试：`test/manager.test.js`

> 编排层只做「决定用哪个目录、建群、写记录、起 PTY、回卡片」，真正的 PTY 由注入的 `createPtySession` 建（测试里换成假对象）。`state/projects.json` 的别名读取单独拆成 `src/projects.js`，因为它要容忍文件不存在和 JSON 损坏——守护进程第一次启动时这个文件根本不存在。

- [ ] **步骤 1：编写失败的测试**

```js
// test/projects.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProjects } = require('../src/projects');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proj-'));
}

test('文件不存在时返回空别名与传入的默认目录', () => {
  const r = loadProjects({ file: path.join(tmpDir(), 'none.json'), defaultCwd: 'D:/w' });
  assert.deepStrictEqual(r, { aliases: {}, default: 'D:/w' });
});

test('读取 aliases 与 default，过滤非字符串和空白值', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({
    aliases: { 卡牌: 'D:/card', 坏: 42, 空: '   ' },
    default: 'D:/workspace',
  }));
  assert.deepStrictEqual(loadProjects({ file, defaultCwd: 'D:/w' }), {
    aliases: { 卡牌: 'D:/card' },
    default: 'D:/workspace',
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON 损坏时不抛错，退回默认值', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, '{ 这不是 json');
  assert.deepStrictEqual(loadProjects({ file, defaultCwd: 'D:/w' }), { aliases: {}, default: 'D:/w' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件里没有 default 时用传入的 defaultCwd', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({ aliases: {} }));
  assert.strictEqual(loadProjects({ file, defaultCwd: 'D:/w' }).default, 'D:/w');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

```js
// test/manager.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createManager } = require('../src/session/manager');

function fakeStore() {
  const map = new Map();
  return {
    map,
    load() {},
    all: () => [...map.values()],
    get: (id) => map.get(id) || null,
    getByChat: (chatId) => [...map.values()].find((s) => s.chatId === chatId) || null,
    upsert(s) { map.set(s.id, s); },
    remove(id) { map.delete(id); },
    save() {},
  };
}

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    async sendText(chatId, text) { calls.push(['sendText', chatId, text]); },
    async sendCard(chatId, card) { calls.push(['sendCard', chatId, card]); },
    async createGroup(name, openIds) { calls.push(['createGroup', name, openIds]); return 'oc_new'; },
    async getChat() { return { chat_id: 'oc' }; },
    async disbandChat(chatId) { calls.push(['disbandChat', chatId]); },
    async createCardEntity(card) { calls.push(['createCardEntity', card]); return 'card_1'; },
    async updateCardEntity(cardId, card, seq) { calls.push(['updateCardEntity', cardId, seq, card]); },
    async sendCardEntity(chatId, cardId) { calls.push(['sendCardEntity', chatId, cardId]); },
    async downloadResource() { return Buffer.from(''); },
    ...overrides,
  };
  return { api, calls };
}

function setup({
  apiOverrides, fsApi, getProjects, now, projects,
} = {}) {
  const store = fakeStore();
  const { api, calls } = fakeApi(apiOverrides);
  const spawned = [];
  const createPtySession = (o) => {
    const ps = {
      session: o.session,
      started: false,
      submitted: [],
      confirm: false,
      start() { ps.started = true; },
      submitText(text, origin, opts) {
        const item = { text, origin };
        if (opts && opts.force) item.force = true;
        ps.submitted.push(item);
        return ps.pushResult || 'queued';
      },
      onPcKeys() {},
      needsConfirm() { return ps.confirm; },
      get screen() { return { snapshot: () => ps.screenText || '屏幕内容' }; },
      releaseTurn() {},
      kill() {},
      emit(e) { o.onEvent({ sessionId: o.session.id, ...e }); },
    };
    spawned.push(ps);
    return ps;
  };
  const manager = createManager({
    config: {
      defaultCwd: 'D:/w',
      ownerOpenId: 'ou_me',
      queueLimit: 20,
      autoDisband: false,
    },
    api,
    store,
    log: { info() {}, warn() {}, error() {} },
    createPtySession,
    mediaRoot: 'D:/media',
    now: now || (() => new Date(2026, 10, 23, 21, 40).getTime()),
    rand: () => 0,
    fsApi: fsApi || { existsSync: () => true, mkdirSync() {} },
    getProjects: getProjects || (() => ({ ...(projects || { aliases: { 卡牌: 'D:/card' }, default: 'D:/w' }) })),
  });
  return { manager, store, calls, spawned };
}

test('createFromPhone：别名命中 → 建记录、起 PTY、提交首条、回已开工卡片', async () => {
  const { manager, store, calls, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 加个技能' });

  assert.strictEqual(rec.cwd, 'D:/card');
  assert.strictEqual(rec.alias, '卡牌');
  assert.strictEqual(rec.agent, 'claude');
  assert.strictEqual(rec.status, 'starting');
  assert.strictEqual(rec.chatId, 'oc_1');
  assert.strictEqual(store.getByChat('oc_1').id, rec.id);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].started, true);
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);

  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.ok(cardCall[2].header.title.content.includes('已开工'));
});

test('createFromPhone：只发别名时不提交空提示词', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  assert.strictEqual(rec.cwd, 'D:/card');
  assert.deepStrictEqual(spawned[0].submitted, []);
});

test('createFromPhone：盘符路径不存在 → 回错误卡片，不建会话', async () => {
  const { manager, store, calls } = setup({
    getProjects: () => ({ aliases: {}, default: 'D:/w' }),
    fsApi: { existsSync: (p) => !p.includes('nope'), mkdirSync() {} },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: 'x', text: 'D:/nope/alpha 跑测试' });
  assert.strictEqual(rec, null);
  assert.strictEqual(store.all().length, 0);
  const cardCall = calls.find((c) => c[0] === 'sendCard');
  assert.strictEqual(cardCall[2].header.template, 'red');
});

test('createFromPhone：默认目录不存在时自动创建', async () => {
  const made = [];
  const { manager } = setup({
    getProjects: () => ({ aliases: {}, default: 'D:/w' }),
    fsApi: { existsSync: () => false, mkdirSync: (p) => made.push(p) },
  });
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: 'x', text: '随便做点什么' });
  assert.strictEqual(rec.cwd, 'D:/w');
  assert.deepStrictEqual(made, ['D:/w']);
});

test('createFromPhone：同一个群已有会话时拒绝重复建', async () => {
  const { manager } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  await assert.rejects(
    () => manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 二' }),
    /已经有会话/,
  );
});

test('createFromPc：建群、邀请自己、发提示', async () => {
  const { manager, calls, spawned } = setup();
  const rec = await manager.createFromPc({ cwd: 'D:/card', agent: 'codex', alias: '卡牌' });
  assert.strictEqual(rec.chatId, 'oc_new');
  assert.strictEqual(rec.chatName, '卡牌 · 11-23 21:40');
  assert.deepStrictEqual(calls[0], ['createGroup', '卡牌 · 11-23 21:40', ['ou_me']]);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('可以从手机说话')));
  assert.strictEqual(rec.agent, 'codex');
  assert.strictEqual(spawned.length, 1);
});

test('createFromPc：目录不存在时抛错', async () => {
  const { manager } = setup({ fsApi: { existsSync: () => false, mkdirSync() {} } });
  await assert.rejects(() => manager.createFromPc({ cwd: 'D:/nope' }), /目录不存在/);
});

test('PTY 事件：spawned 记 pid、ready 转 idle 并落盘', async () => {
  const { manager, store, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 一' });
  spawned[0].emit({ type: 'spawned', pid: 4321 });
  spawned[0].emit({ type: 'ready' });
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '一', at: 1 } });
  assert.strictEqual(store.get(rec.id).ptyPid, 4321);
  assert.strictEqual(store.get(rec.id).status, 'idle');
  assert.strictEqual(store.get(rec.id).lastInput.origin, 'phone');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/projects.test.js test/manager.test.js`
预期：FAIL，`Cannot find module '../src/projects'`

- [ ] **步骤 3：编写实现**

```js
// src/projects.js
const fs = require('node:fs');

// 读 state/projects.json；文件不存在或 JSON 损坏都退回默认值，绝不抛错
function loadProjects({ file, defaultCwd }) {
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    doc = {};
  }
  const aliases = {};
  const raw = doc && typeof doc === 'object' ? doc.aliases : null;
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      if (typeof val === 'string' && val.trim()) aliases[key] = val;
    }
  }
  const def = doc && typeof doc.default === 'string' && doc.default.trim()
    ? doc.default
    : defaultCwd;
  return { aliases, default: def };
}

module.exports = { loadProjects };
```

```js
// src/session/manager.js
const fs = require('node:fs');
const path = require('node:path');
const { parseFirstMessage } = require('./router');
const { loadProjects } = require('../projects');
const { paths } = require('../paths');
const cards = require('../feishu/cards');

// 这些事件才值得写盘和广播，'data' 是高频字节流，绝不能每条都存
const PERSIST_EVENTS = new Set(['spawned', 'ready', 'turn-start', 'exit', 'input', 'pc-input', 'overflow']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(ms) {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function createManager({
  config,
  api,
  store,
  log,
  createPtySession,
  ipc = null,
  now = () => Date.now(),
  rand = () => Math.random(),
  fsApi = fs,
  getProjects = null,
}) {
  const sessions = new Map();
  const loadProjectsFn = getProjects
    || (() => loadProjects({ file: paths.PROJECTS, defaultCwd: config.defaultCwd }));

  function newId() {
    return `s${now().toString(36)}${Math.floor(rand() * 46656).toString(36).padStart(3, '0')}`;
  }

  function labelOf(record) {
    return record.alias || path.basename(record.cwd) || record.agent;
  }

  function onEvent(e) {
    const record = store.get(e.sessionId);
    if (!record) return;
    if (e.type === 'spawned') record.ptyPid = e.pid || null;
    else if (e.type === 'ready') record.status = 'idle';
    else if (e.type === 'turn-start') record.status = 'running';
    else if (e.type === 'exit') record.status = 'error';
    if (e.type === 'input' || e.type === 'pc-input') record.lastInput = e.input || null;

    if (e.type === 'data') {
      if (ipc && ipc.broadcast) {
        ipc.broadcast({ type: 'data', sessionId: e.sessionId, data: e.data });
      }
      return;
    }
    if (PERSIST_EVENTS.has(e.type)) {
      record.lastActiveAt = new Date(now()).toISOString();
      store.save();
      if (ipc && ipc.broadcast) ipc.broadcast({ type: 'session', session: record });
    }
    if (e.type === 'error') log.warn('会话出错', { sessionId: e.sessionId, message: e.message });
    if (e.type === 'overflow') log.warn('队列已满', { sessionId: e.sessionId });
  }

  function spawn(record) {
    const ps = createPtySession({
      session: record,
      onEvent,
      queueLimit: config.queueLimit,
      now,
    });
    sessions.set(record.id, ps);
    ps.start();
    return ps;
  }

  function newRecord({ chatId, chatName, cwd, alias, agent }) {
    const at = new Date(now()).toISOString();
    return {
      id: newId(),
      agent: agent === 'codex' ? 'codex' : 'claude',
      cwd,
      alias: alias || null,
      chatId,
      chatName,
      claudeSessionId: null,
      transcriptPath: null,
      ptyPid: null,
      status: 'starting',
      createdAt: at,
      lastActiveAt: at,
      inputSeq: 0,
      lastInput: null,
    };
  }

  async function createFromPhone({ chatId, chatName, text, agent = 'claude' }) {
    if (store.getByChat(chatId)) {
      throw new Error('这个群已经有会话了，直接在群里发消息就行');
    }

    const projects = loadProjectsFn();
    const parsed = parseFirstMessage(text, {
      aliases: projects.aliases,
      defaultCwd: projects.default || config.defaultCwd,
      exists: (p) => fsApi.existsSync(p),
    });

    if (parsed.source === 'path-missing') {
      await api.sendCard(chatId, cards.errorCard({
        title: '目录不存在',
        text: `你说的路径在本机不存在：\n\`${parsed.prompt.split(/\s+/)[0]}\`\n\n换一个目录，或者直接说要做的事（会落到默认目录 \`${config.defaultCwd}\`）。`,
      }));
      return null;
    }

    if (!fsApi.existsSync(parsed.cwd)) {
      if (parsed.source !== 'default') {
        await api.sendCard(chatId, cards.errorCard({
          title: '目录不存在',
          text: `别名「${parsed.alias}」指向的目录不存在：\n\`${parsed.cwd}\``,
        }));
        return null;
      }
      fsApi.mkdirSync(parsed.cwd, { recursive: true });
    }

    const record = newRecord({
      chatId,
      chatName: chatName || parsed.alias || path.basename(parsed.cwd),
      cwd: parsed.cwd,
      alias: parsed.alias,
      agent,
    });
    store.upsert(record);
    spawn(record);

    await api.sendCard(chatId, cards.noticeCard({
      title: '✅ 已开工',
      template: 'green',
      text: `${labelOf(record)} · \`${record.cwd}\`\n\n${parsed.prompt ? '第一条已进队，处理中…' : '可以直接说话。'}`,
    }));
    if (parsed.prompt) sessions.get(record.id).submitText(parsed.prompt, 'phone');
    return record;
  }

  async function createFromPc({ cwd, agent = 'claude', alias = null }) {
    if (!fsApi.existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
    const label = alias || path.basename(cwd);
    const chatName = `${label} · ${stamp(now())}`;
    const chatId = await api.createGroup(chatName, [config.ownerOpenId]);
    const record = newRecord({ chatId, chatName, cwd, alias, agent });
    store.upsert(record);
    spawn(record);
    await api.sendText(chatId, '会话已创建，可以从手机说话了。');
    return record;
  }

  return {
    createFromPhone,
    createFromPc,
    _sessions: sessions,
  };
}

module.exports = { createManager };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/projects.test.js test/manager.test.js`
预期：`# pass 12`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/projects.js src/session/manager.js test/projects.test.js test/manager.test.js
git commit -m "feat: 编排层建会话（别名/路径/默认目录 → 建群 + 起 PTY）"
```

---

### 任务 16：手机消息注入（护栏、队列满、附件）

**文件：**
- 修改：`src/session/manager.js`（新增 `onPhoneMessage` / `attachMedia`，`createManager` 解构里加 `mediaRoot`）
- 测试：`test/manager.test.js`（追加 8 个用例）

> 三条规则来自规格 §6.1：① 群没登记过 ⇒ 首句就是建会话指令；② 屏幕停在不认识的界面（菜单/弹窗）⇒ 不盲写，回画面卡片 + 「仍然发送」；③ 队列满 ⇒ 明说「积压了 N 条」。附件先落盘成绝对路径再随文本写进终端——手机发图时 Claude Code 才读得到。

- [ ] **步骤 1：编写失败的测试**

```js
// 追加到 test/manager.test.js 末尾
test('onPhoneMessage：未登记的群把首句当作建会话指令', async () => {
  const { manager, store, spawned } = setup();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '卡牌 加个技能', senderOpenId: 'ou_me' });
  assert.strictEqual(store.all().length, 1);
  assert.strictEqual(store.getByChat('oc_1').cwd, 'D:/card');
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '加个技能', origin: 'phone' }]);
});

test('onPhoneMessage：登记过的群直接进队列（去掉首尾空白）', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '  跑一下测试  ', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(spawned[0].submitted.at(-1), { text: '跑一下测试', origin: 'phone' });
});

test('onPhoneMessage：非主人的消息一律忽略', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: 'rm -rf', senderOpenId: 'ou_other' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, 1); // 只有「已开工」
});

test('onPhoneMessage：队列满时提示积压', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].pushResult = 'full';
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '再来一条', senderOpenId: 'ou_me' });
  assert.ok(calls.some((c) => c[0] === 'sendText' && /积压/.test(c[2])));
});

test('onPhoneMessage：不在输入框 → 回画面卡片，不写入', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].confirm = true;
  spawned[0].screenText = '❯ 1. Yes';
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.strictEqual(card.header.title.content, '🖥 当前画面');
  assert.ok(JSON.stringify(card).includes('❯ 1. Yes'));
});

test('onPhoneMessage：回「仍然发送」强行写入上一条', async () => {
  const { manager, spawned } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '仍然发送', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '继续', origin: 'phone', force: true }]);
});

test('onPhoneMessage：媒体先落盘，再把绝对路径发给会话', async () => {
  const writes = [];
  const { manager, spawned } = setup({
    apiOverrides: { downloadResource: async () => Buffer.from('img') },
    fsApi: {
      existsSync: () => true,
      mkdirSync() {},
      writeFileSync: (p, b) => writes.push([p, b.toString()]),
    },
  });
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  await manager.onPhoneMessage({
    chatId: 'oc_1',
    text: '照这个改',
    senderOpenId: 'ou_me',
    media: { messageId: 'om_1', fileKey: 'fk_1', fileName: '截图.png', type: 'image' },
  });
  assert.deepStrictEqual(writes.map((w) => w[1]), ['img']);
  assert.ok(writes[0][0].endsWith('截图.png'));
  const sent = spawned[0].submitted.at(-1).text;
  assert.ok(sent.includes('照这个改'));
  assert.ok(sent.includes('截图.png'));
});

test('onPhoneMessage：会话已停 → 提示「重来」，不写入', async () => {
  const { manager, spawned, calls } = setup();
  await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌' });
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '还在吗', senderOpenId: 'ou_me' });
  assert.strictEqual(spawned[0].submitted.length, 0);
  assert.ok(calls.some((c) => c[0] === 'sendText' && /重来/.test(c[2])));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/manager.test.js`
预期：FAIL，8 个新用例报 `manager.onPhoneMessage is not a function`

- [ ] **步骤 3：编写实现**

把 `createManager` 的参数解构加一行：

```js
// src/session/manager.js —— createManager 解构里加 mediaRoot
function createManager({
  config,
  api,
  store,
  log,
  createPtySession,
  ipc = null,
  now = () => Date.now(),
  rand = () => Math.random(),
  fsApi = fs,
  getProjects = null,
  mediaRoot = paths.MEDIA,
}) {
```

在 `const sessions = new Map();` 后面加待确认表，并新增两个函数（放在 `createFromPc` 之后）：

```js
  const forcePending = new Map();   // chatId -> { text }：被护栏拦下、等「仍然发送」的那句

  // 文件名只留安全字符，截断到 120 字符以内（Windows 路径上限）
  function safeName(name) {
    const base = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').trim();
    return base.slice(-120) || 'file';
  }

  async function attachMedia(chatId, text, media) {
    try {
      const buf = await api.downloadResource(media.messageId, media.fileKey, media.type);
      const dir = path.join(mediaRoot, chatId);
      fsApi.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, safeName(media.fileName));
      fsApi.writeFileSync(abs, buf);
      return text ? `${text}\n\n[附件] ${abs}` : `[附件] ${abs}`;
    } catch (err) {
      log.warn('附件下载失败', { chatId, message: String((err && err.message) || err) });
      await api.sendText(chatId, '附件下载失败了，把内容直接打出来吧。');
      return text;
    }
  }

  async function onPhoneMessage({
    chatId, text, media = null, senderOpenId = null,
  }) {
    if (config.ownerOpenId && senderOpenId && senderOpenId !== config.ownerOpenId) {
      log.warn('忽略非主人的消息', { chatId });
      return;
    }

    const record = store.getByChat(chatId);
    if (!record) {
      // 没登记过的群：首句即建会话指令（ws 层只把 @机器人 的消息转发到这里）
      await createFromPhone({ chatId, chatName: null, text, agent: config.defaultAgent || 'claude' });
      return;
    }

    const ps = sessions.get(record.id);
    if (!ps || ['error', 'closed', 'closing'].includes(record.status)) {
      await api.sendText(chatId, '这个会话已经停了，回复「重来」重新开一轮。');
      return;
    }
    if (record.status === 'interrupted') {
      await api.sendText(chatId, '电脑重启过，这个会话还没接上。再发一次，我就用 --resume 接着干。');
      return;
    }

    let payload = String(text == null ? '' : text).trim();

    const pending = forcePending.get(chatId);
    if (pending && payload === '仍然发送') {
      forcePending.delete(chatId);
      ps.submitText(pending.text, 'phone', { force: true });
      return;
    }
    forcePending.delete(chatId);

    if (media) payload = await attachMedia(chatId, payload, media);
    if (!payload) return;

    if (ps.needsConfirm()) {
      forcePending.set(chatId, { text: payload });
      await api.sendCard(chatId, cards.screenCard({
        text: ps.screen.snapshot({ lines: 40 }),
        reason: 'not-ready',
      }));
      return;
    }

    const result = ps.submitText(payload, 'phone');
    if (result === 'full') {
      await api.sendText(chatId, `积压了 ${config.queueLimit} 条还没处理完，稍后再发。`);
    }
  }
```

并在返回对象里加上 `onPhoneMessage`：

```js
  return {
    createFromPhone,
    createFromPc,
    onPhoneMessage,
    _sessions: sessions,
  };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/manager.test.js`
预期：`# pass 16`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/manager.js test/manager.test.js
git commit -m "feat: 手机消息注入（主人校验、盲写护栏、队列满提示、附件落盘）"
```

---

### 任务 17：Stop 推送（回复 → 手机）

规格依据：§6.2（Q&A 成对推送、`🖥` 前缀只在电脑来源、输入为空不推、Esc 打断）、§6.4（「正在处理…」卡片原地定稿、工具摘要行、8000 字截断）。

本任务做三件事：

1. `src/agent/tools.js`：从 transcript 的 JSONL 末尾统计本轮工具调用，产出 `🔧 改了 3 个文件 · Bash×2`。
2. `turn-start` 时发一张「⏳ 正在处理…」卡片实体，把 `cardId` 记进会话记录。
3. Stop hook 到达时：写回 `claudeSessionId` / `transcriptPath`、状态转 `idle`、拼卡片正文（`🖥` 行 + 回复 + 工具摘要），原地更新那张卡片；没有待定卡片就新发一张。

> **本任务的已知取舍（v1 不做文件上传）：** 回复超过 8000 字时只截断（卡片底部已提示「完整输出请到电脑上看」），不上传 `.md` 文件——飞书上传要走 multipart 的 `im/v1/files`，留到 Plan B 再加。差异会记入文末「与规格的差异」。

**文件：**
- 创建：`src/agent/tools.js`
- 修改：`src/session/manager.js`
- 测试：`test/tools.test.js`（新建）、`test/manager.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

新建 `test/tools.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { summarizeToolUse } = require('../src/agent/tools');

const line = (o) => JSON.stringify(o);

test('统计工具次数与改动文件数', () => {
  const jsonl = [
    line({ type: 'user', message: { content: '改地形' } }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'a.gd' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'a.gd' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 改了 1 个文件 · Edit×2 · Bash×1');
});

test('只看最后一轮：从后往前扫，遇到 user 消息就停', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
    line({ type: 'user', message: { content: '第二轮' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Bash×1');
});

test('没有工具调用返回空串', () => {
  const jsonl = line({ type: 'assistant', message: { content: [{ type: 'text', text: '直接回答' }] } });
  assert.strictEqual(summarizeToolUse(jsonl), '');
});

test('坏行与空行跳过', () => {
  const jsonl = [
    '',
    '不是 json',
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: {} }] } }),
  ].join('\n');
  assert.strictEqual(summarizeToolUse(jsonl), '🔧 Grep×1');
});
```

在 `test/manager.test.js` 末尾追加（沿用该文件已有的 `setup()` / `fakeStore()` / `fakeApi()`）：

```js
async function started(props) {
  const h = setup(props);
  const rec = await h.manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 你好' });
  h.spawned[0].emit({ type: 'ready' });
  return { ...h, rec };
}

test('Stop：手机来源只推回复，不重复用户输入', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '现在几点', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '十点半。' } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  const body = JSON.stringify(card.body);
  assert.ok(body.includes('十点半。'));
  assert.ok(!body.includes('你刚在电脑上问'));
  assert.ok(!body.includes('现在几点'));
});

test('Stop：电脑来源顶部带 🖥 行', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '现在几点', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '十点半。' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('🖥 你刚在电脑上问：现在几点'));
  assert.ok(body.includes('十点半。'));
});

test('Stop：输入为空（只按了回车）不推', async () => {
  const { manager, calls, spawned, rec } = await started();
  const before = calls.filter((c) => c[0] === 'sendCard').length;
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '   ', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '好的' } });
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, before);
});

test('Stop：斜杠命令同样作为电脑来源推回', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '/compact', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '已压缩 12 条消息' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('🖥 你刚在电脑上问：/compact'));
});

test('Stop：超过 8000 字的回复走截断', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '写长一点', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '字'.repeat(9000) } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.strictEqual(card.header.title.content, '✅ 回复（已截断）');
});

test('Stop：正文带上工具摘要行', async () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: '改地形' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/card/a.gd' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/card/b.gd' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    }),
  ].join('\n');
  const { manager, calls, spawned, rec } = await started({
    fsApi: {
      existsSync: () => true,
      mkdirSync() {},
      statSync: () => ({ size: jsonl.length }),
      readFileSync: () => jsonl,
    },
  });
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '改地形', at: 1 } });
  await manager.onHookStop({
    sessionId: rec.id,
    payload: { transcript_path: 'D:/t.jsonl', last_assistant_message: '改好了' },
  });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('改了 2 个文件'));
  assert.ok(body.includes('Bash×1'));
});

test('Stop：画面停在 Interrupted 且没有正文 → 推「（已打断）」', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].screenText = '⎿  Interrupted · What should Claude do instead?';
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'pc', text: '跑很久的任务', at: 1 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('（已打断）'));
});

test('turn-start 建处理中卡片，Stop 原地定稿', async () => {
  const { manager, calls, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '跑测试' });
  await manager._drain();

  assert.ok(calls.some((c) => c[0] === 'createCardEntity'));
  assert.ok(calls.some((c) => c[0] === 'sendCardEntity' && c[2] === 'card_1'));

  spawned[0].emit({ type: 'input', input: { seq: 2, origin: 'phone', text: '跑测试', at: 2 } });
  await manager.onHookStop({ sessionId: rec.id, payload: { last_assistant_message: '全绿' } });

  const upd = calls.find((c) => c[0] === 'updateCardEntity');
  assert.strictEqual(upd[1], 'card_1');
  assert.strictEqual(upd[2], 1);
  assert.ok(JSON.stringify(upd[3].body).includes('全绿'));
  assert.strictEqual(calls.filter((c) => c[0] === 'sendCard').length, 1);   // 只有「已开工」
});

test('Stop：回填 claudeSessionId 与 transcriptPath，状态转 idle', async () => {
  const { manager, store, spawned, rec } = await started();
  spawned[0].emit({ type: 'turn-start', seq: 2, origin: 'phone', text: '一' });
  await manager._drain();
  assert.strictEqual(store.get(rec.id).status, 'running');

  await manager.onHookStop({
    sessionId: rec.id,
    payload: { session_id: 'cs_9', transcript_path: 'D:/t.jsonl', last_assistant_message: '完' },
  });

  const saved = store.get(rec.id);
  assert.strictEqual(saved.claudeSessionId, 'cs_9');
  assert.strictEqual(saved.transcriptPath, 'D:/t.jsonl');
  assert.strictEqual(saved.status, 'idle');
});

test('Stop：桥梁 sessionId 对不上时，用 payload.session_id 兜底找会话', async () => {
  const { manager, calls, store, spawned, rec } = await started();
  store.get(rec.id).claudeSessionId = 'cs_1';
  spawned[0].emit({ type: 'input', input: { seq: 1, origin: 'phone', text: '一', at: 1 } });
  await manager.onHookStop({ sessionId: 's_unknown', payload: { session_id: 'cs_1', last_assistant_message: '找到了' } });

  const body = JSON.stringify(calls.filter((c) => c[0] === 'sendCard').at(-1)[2].body);
  assert.ok(body.includes('找到了'));
});

test('Stop：找不到任何会话时静默返回', async () => {
  const { manager, calls } = setup();
  await manager.onHookStop({ sessionId: 's_none', payload: { last_assistant_message: '幽灵' } });
  assert.strictEqual(calls.length, 0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/tools.test.js test/manager.test.js`
预期：FAIL，`Cannot find module '../src/agent/tools'`；manager 侧报 `manager.onHookStop is not a function`。

- [ ] **步骤 3：编写实现**

新建 `src/agent/tools.js`：

```js
// src/agent/tools.js
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MAX_TYPES = 3;

// 从 transcript JSONL 的末尾倒着扫，统计「最后一轮」的工具调用；
// 碰到 user 消息就停（那是这一轮的开始）。
function summarizeToolUse(jsonlText) {
  const lines = String(jsonlText || '').split('\n');
  const counts = new Map();
  const files = new Set();

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'user') break;
    if (entry.type !== 'assistant') continue;

    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || !block.name) continue;
      counts.set(block.name, (counts.get(block.name) || 0) + 1);
      if (FILE_TOOLS.has(block.name) && block.input && typeof block.input.file_path === 'string') {
        files.add(block.input.file_path);
      }
    }
  }

  const parts = [];
  if (files.size > 0) parts.push(`改了 ${files.size} 个文件`);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TYPES);
  for (const [name, n] of top) parts.push(`${name}×${n}`);
  return parts.length ? `🔧 ${parts.join(' · ')}` : '';
}

module.exports = { summarizeToolUse };
```

修改 `src/session/manager.js`。顶部 require 区追加：

```js
const { summarizeToolUse } = require('../agent/tools');
```

在 `const forcePending = new Map();` 之后追加（异步任务串行化：`onEvent` 保持同步，卡片创建/更新排在同一条链上；`_drain()` 只给测试用）：

```js
  const TOOL_SUMMARY_MAX_BYTES = 20 * 1024 * 1024;
  let pendingWork = Promise.resolve();

  function enqueueWork(fn) {
    pendingWork = pendingWork
      .then(fn)
      .catch((err) => log.warn('异步任务失败', { message: String((err && err.message) || err) }));
    return pendingWork;
  }
```

在 `onEvent` 中 `PERSIST_EVENTS` 那段之后追加：

```js
    if (e.type === 'turn-start') enqueueWork(() => startProcessingCard(record, e));
```

在 `createFromPc` 之后新增这四个函数：

```js
  async function startProcessingCard(record, e) {
    if (record.agent !== 'claude') return;      // Codex 不做卡片定稿，走画面推送（任务 20）
    try {
      const cardId = await api.createCardEntity(cards.processingCard({ agent: record.agent, prompt: e.text }));
      await api.sendCardEntity(record.chatId, cardId);
      record.pendingCard = { cardId, seq: 0, origin: e.origin, prompt: e.text };
      store.save();
    } catch (err) {
      log.warn('处理中卡片发送失败，Stop 时改为新发一张', { message: String((err && err.message) || err) });
    }
  }

  function toolSummary(record) {
    if (!record.transcriptPath) return '';
    try {
      const st = fsApi.statSync(record.transcriptPath);
      if (!st || st.size > TOOL_SUMMARY_MAX_BYTES) return '';
      return summarizeToolUse(fsApi.readFileSync(record.transcriptPath, 'utf8'));
    } catch {
      return '';
    }
  }

  function sawInterrupted(record) {
    const ps = sessions.get(record.id);
    if (!ps || !ps.screen) return false;
    try {
      return ps.screen.snapshot({ lines: 12 }).includes('Interrupted');
    } catch {
      return false;
    }
  }

  function findByClaudeSessionId(claudeSessionId) {
    if (!claudeSessionId) return null;
    return store.all().find((s) => s.claudeSessionId === claudeSessionId) || null;
  }

  async function onHookStop({ sessionId, payload = {} }) {
    const record = store.get(sessionId) || findByClaudeSessionId(payload.session_id);
    if (!record) {
      log.warn('Stop hook 找不到会话，忽略', { sessionId });
      return;
    }

    // 回填 Claude 自己的会话信息：重启后 --resume 靠它（任务 19）
    if (payload.session_id) record.claudeSessionId = payload.session_id;
    if (payload.transcript_path) record.transcriptPath = payload.transcript_path;
    if (!['error', 'closed', 'closing'].includes(record.status)) record.status = 'idle';
    // ptySession 内部状态也要回到 idle，否则 canWrite 永远为 false，队列里的手机消息再也写不进去
    const stoppedPs = sessions.get(record.id);
    if (stoppedPs) stoppedPs.releaseTurn();
    record.lastActiveAt = new Date(now()).toISOString();
    store.save();
    ipc?.broadcast({ type: 'session', session: record });

    const input = record.lastInput;
    if (input && !String(input.text || '').trim()) return;   // 只按了回车，不推

    const reply = String(payload.last_assistant_message || '').trim();
    const interrupted = sawInterrupted(record);
    if (!reply && !interrupted) return;

    const parts = [];
    if (input && input.origin === 'pc' && input.text) parts.push(`🖥 你刚在电脑上问：${input.text}`);
    parts.push(interrupted && !reply ? '（已打断）' : reply);
    const tools = toolSummary(record);
    if (tools) parts.push(tools);

    const card = cards.replyCard({ text: parts.join('\n\n'), agent: record.agent, cwd: record.cwd });
    const pending = record.pendingCard;
    record.pendingCard = null;

    if (pending && pending.cardId) {
      try {
        await api.updateCardEntity(pending.cardId, card, pending.seq + 1);
        store.save();
        return;
      } catch (err) {
        log.warn('卡片定稿失败，改为新发一张', { message: String((err && err.message) || err) });
      }
    }
    await api.sendCard(record.chatId, card);
    store.save();
  }
```

在返回对象里补上：

```js
    onHookStop,
    _drain: () => pendingWork,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/tools.test.js test/manager.test.js`
预期：`# pass 31`（tools 4 + manager 27）

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/agent/tools.js src/session/manager.js test/tools.test.js test/manager.test.js
git commit -m "feat: Stop 推送回复到手机（🖥 前缀、工具摘要、原地定稿、打断提示）"
```

---

### 任务 18：生命周期（解散 / 移出 / 崩溃 / 抽检 / 卡片按钮）

规格依据：§8 生命周期表（解散、机器人被移出、PTY 崩溃、事件丢失后的 30s 抽检、autoDisband）。

> **对规格 §8 的一处修正（要记进差异）：** 规格写「每 30s 抽检**非 idle** 会话」，但用户恰恰是在会话空闲时才会去手机上解散群——只查非 idle 会让兜底在常见场景失效。本任务改为抽检**所有未 closed 的会话**。每 30s 每会话一次 `im.chat.get`，量级可忽略。

**文件：**
- 修改：`src/session/manager.js`
- 测试：`test/manager.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

先让 `setup()` 能注入 `ipc` 与配置覆盖，并让假 PTY 记录 `kill` 调用。把 `test/manager.test.js` 里的 `setup()` 改成：

```js
function setup({
  apiOverrides, fsApi, getProjects, now, projects, ipc, configOverrides,
} = {}) {
  const store = fakeStore();
  const { api, calls } = fakeApi(apiOverrides);
  const spawned = [];
  const createPtySession = (o) => {
    const ps = {
      session: o.session,
      started: false,
      killed: false,
      submitted: [],
      confirm: false,
      start() { ps.started = true; },
      submitText(text, origin, opts) {
        const item = { text, origin };
        if (opts && opts.force) item.force = true;
        ps.submitted.push(item);
        return ps.pushResult || 'queued';
      },
      onPcKeys() {},
      needsConfirm() { return ps.confirm; },
      get screen() { return { snapshot: () => ps.screenText || '屏幕内容' }; },
      releaseTurn() {},
      kill() { ps.killed = true; },
      emit(e) { o.onEvent({ sessionId: o.session.id, ...e }); },
    };
    spawned.push(ps);
    return ps;
  };
  const manager = createManager({
    config: {
      defaultCwd: 'D:/w',
      ownerOpenId: 'ou_me',
      queueLimit: 20,
      autoDisband: false,
      ...configOverrides,
    },
    api,
    store,
    log: { info() {}, warn() {}, error() {} },
    createPtySession,
    ipc: ipc || null,
    mediaRoot: 'D:/media',
    now: now || (() => new Date(2026, 10, 23, 21, 40).getTime()),
    rand: () => 0,
    fsApi: fsApi || { existsSync: () => true, mkdirSync() {} },
    getProjects: getProjects || (() => ({ ...(projects || { aliases: { 卡牌: 'D:/card' }, default: 'D:/w' }) })),
  });
  return { manager, store, calls, spawned };
}
```

在文件末尾追加：

```js
test('onDisbanded：杀 PTY、移除记录、窗口收到 closed', async () => {
  const broadcasts = [];
  const { manager, store, spawned, rec } = await started({ ipc: { broadcast: (m) => broadcasts.push(m) } });
  await manager.onDisbanded({ chatId: 'oc_1' });

  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id), null);
  assert.ok(broadcasts.some((m) => m.type === 'session' && m.session.status === 'closed'));
});

test('onDisbanded：没登记的群静默返回', async () => {
  const { manager, spawned } = setup();
  await manager.onDisbanded({ chatId: 'oc_none' });
  assert.strictEqual(spawned.length, 0);
});

test('onBotRemoved：等同解散', async () => {
  const { manager, store, spawned, rec } = await started();
  await manager.onBotRemoved({ chatId: 'oc_1' });
  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id), null);
});

test('PTY 崩溃：状态转 error，群里收到异常卡片', async () => {
  const { manager, calls, store, spawned, rec } = await started();
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager._drain();

  assert.strictEqual(store.get(rec.id).status, 'error');
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(card.header.title.content.includes('异常退出'));
  assert.ok(JSON.stringify(card).includes('code 1'));
  assert.ok(JSON.stringify(card).includes('重来'));
});

test('回「重来」：目录还在就重新拉起 PTY', async () => {
  const { manager, store, spawned, rec } = await started();
  spawned[0].emit({ type: 'exit', code: 2 });
  await manager._drain();
  assert.strictEqual(store.get(rec.id).status, 'error');

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].started, true);
  assert.strictEqual(store.get(rec.id).status, 'starting');
});

test('回「重来」：原目录不在了就报错，不再拉起', async () => {
  let gone = false;
  const { manager, calls, spawned } = await started({
    fsApi: { existsSync: () => !gone, mkdirSync() {} },
  });
  spawned[0].emit({ type: 'exit', code: 2 });
  await manager._drain();
  gone = true;

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 1);
  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(card.header.title.content.includes('目录'));
});

test('tick：群已不存在 → 关闭会话；群还在 → 不动', async () => {
  let existing = true;
  const { manager, store, spawned, rec } = await started({
    apiOverrides: { getChat: async () => (existing ? { chat_id: 'oc_1' } : null) },
  });

  await manager.tick();
  assert.strictEqual(spawned[0].killed, false);

  existing = false;
  await manager.tick();
  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id), null);
});

test('onCardAction：force-send 按钮等同「仍然发送」', async () => {
  const { manager, spawned } = await started();
  spawned[0].confirm = true;
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'force-send' } });

  assert.deepStrictEqual(spawned[0].submitted.at(-1), { text: '继续', origin: 'phone', force: true });
});

test('closeSession：notify 时群发「会话已结束」，autoDisband 打开则解散群', async () => {
  const { manager, calls, rec } = await started({ configOverrides: { autoDisband: true } });
  await manager.closeSession(rec.id, { reason: 'window', notify: true });

  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('会话已结束')));
  assert.ok(calls.some((c) => c[0] === 'disbandChat' && c[1] === 'oc_1'));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/manager.test.js`
预期：FAIL，`manager.onDisbanded is not a function`（新用例 9 个）

- [ ] **步骤 3：编写实现**

修改 `onEvent` 里的 exit 分支（防住「正常关闭」被误判为崩溃）：

```js
    else if (e.type === 'exit' && record.status !== 'closing') record.status = 'error';
```

在 `onEvent` 末尾（`turn-start` 那行之后）追加崩溃通知：

```js
    if (e.type === 'exit' && record.status === 'error') enqueueWork(() => notifyCrash(record, e));
```

在 `onHookStop` 之后新增：

```js
  async function notifyCrash(record, e) {
    const code = typeof e.code === 'number' ? `（code ${e.code}）` : '';
    try {
      await api.sendCard(record.chatId, cards.errorCard({
        title: '进程异常退出',
        text: `会话进程异常退出${code}。\n\n回复「重来」，我用 --resume 接着干。`,
      }));
    } catch (err) {
      log.warn('崩溃通知发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
  }

  async function closeSession(sessionId, { reason = 'closed', notify = false } = {}) {
    const record = store.get(sessionId);
    if (!record) return;

    const ps = sessions.get(sessionId);
    sessions.delete(sessionId);
    record.status = 'closing';        // 先置 closing，kill 出来的 exit 事件不会被当成崩溃
    store.save();
    if (ps) {
      try {
        ps.kill();
      } catch (err) {
        log.warn('结束 PTY 失败', { sessionId, message: String((err && err.message) || err) });
      }
    }

    record.status = 'closed';
    record.closedReason = reason;
    record.closedAt = new Date(now()).toISOString();
    store.save();
    ipc?.broadcast({ type: 'session', session: record });

    if (notify) {
      try {
        await api.sendText(record.chatId, '会话已结束');
      } catch (err) {
        log.warn('会话结束提示发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
      }
    }
    if (config.autoDisband && reason !== 'disbanded' && reason !== 'bot-removed') {
      try {
        await api.disbandChat(record.chatId);
      } catch (err) {
        log.warn('解散群失败', { chatId: record.chatId, message: String((err && err.message) || err) });
      }
    }

    store.remove(sessionId);
    store.save();
  }

  // 崩溃 / 已停的会话原地重启。hook 文件、--settings、信任标记、--resume
  // 都在 launcher.buildLaunch 里按需重写，这里只管状态与目录校验。
  async function revive(record) {
    if (!fsApi.existsSync(record.cwd)) {
      await api.sendCard(record.chatId, cards.errorCard({
        title: '原目录不见了',
        text: `\`${record.cwd}\` 已经不存在，没法恢复这个会话。改个目录重新开一个吧。`,
      }));
      return false;
    }

    record.status = 'starting';
    record.error = null;
    record.pendingCard = null;
    record.lastActiveAt = new Date(now()).toISOString();
    store.save();
    spawn(record);
    ipc?.broadcast({ type: 'session', session: record });

    const resumed = record.agent === 'claude' && record.claudeSessionId;
    await api.sendText(record.chatId, resumed ? '重新开起来了，接着上次的对话。' : '重新开起来了。');
    return true;
  }

  async function onDisbanded({ chatId }) {
    const record = store.getByChat(chatId);
    if (!record) return;
    await closeSession(record.id, { reason: 'disbanded', notify: false });
  }

  async function onBotRemoved({ chatId }) {
    const record = store.getByChat(chatId);
    if (!record) return;
    await closeSession(record.id, { reason: 'bot-removed', notify: false });
  }

  async function onCardAction({ chatId, openId = null, action }) {
    if (config.ownerOpenId && openId && openId !== config.ownerOpenId) {
      log.warn('忽略非主人的卡片操作', { chatId });
      return;
    }
    const act = action && action.act;
    if (act === 'force-send') {
      await onPhoneMessage({ chatId, text: '仍然发送', senderOpenId: openId || config.ownerOpenId });
      return;
    }
    log.warn('未知的卡片操作', { chatId, act });
  }

  // 由 daemon 每 30s 调一次（任务 21 装配时起定时器）：兜住丢失的解散事件。
  async function tick() {
    for (const record of store.all()) {
      if (record.status === 'closed') continue;
      let chat;
      try {
        chat = await api.getChat(record.chatId);
      } catch (err) {
        log.warn('抽检群失败', { chatId: record.chatId, message: String((err && err.message) || err) });
        continue;
      }
      if (!chat) await closeSession(record.id, { reason: 'disbanded', notify: false });
    }
  }
```

修改 `onPhoneMessage`：把 `payload` 的计算提到最前，并加「重来」分支（同时删掉原来那行 `let payload = ...`）：

```js
    const ps = sessions.get(record.id);
    let payload = String(text == null ? '' : text).trim();

    if (payload === '重来' && (!ps || record.status === 'error')) {
      await revive(record);
      return;
    }

    if (!ps || ['error', 'closed', 'closing'].includes(record.status)) {
      await api.sendText(chatId, '这个会话已经停了，回复「重来」重新开一轮。');
      return;
    }
    if (record.status === 'interrupted') {
      await api.sendText(chatId, '电脑重启过，这个会话还没接上。再发一次，我就用 --resume 接着干。');
      return;
    }

    const pending = forcePending.get(chatId);
    ...
```

返回对象补齐：

```js
    closeSession,
    onDisbanded,
    onBotRemoved,
    onCardAction,
    tick,
    revive,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/manager.test.js`
预期：`# pass 36`（原 27 + 新 9）

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/manager.js test/manager.test.js
git commit -m "feat: 会话生命周期（解散/移出/崩溃重启/30s 抽检/卡片按钮）"
```

---

### 任务 19：daemon 重启恢复（interrupted + --resume）

规格依据：§8 生命周期表「daemon 重启 → 全部 interrupted + 群里发『电脑重启了，回一条消息我就接上』」以及 `--resume` 四件事。

四件事的落点：① cwd 校验在 `revive()`（任务 18）里；② hook 文件重写、③ 信任标记预写、④ `--settings` 与 `--resume` 参数 —— 这三件 **launcher.buildLaunch 每次 spawn 都会做**（任务 8），manager 不需要重复。manager 还欠的一件事是：**`--resume` 非零退出要能降级重开**，否则会话就此卡死。

**文件：**
- 修改：`src/session/manager.js`
- 测试：`test/manager.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

在文件末尾追加：

```js
test('restoreAll：记录转 interrupted、逐群提示、不拉起 PTY', async () => {
  const { manager, store, calls, spawned, rec } = await started();

  const n = await manager.restoreAll();

  assert.strictEqual(n, 1);
  assert.strictEqual(store.get(rec.id).status, 'interrupted');
  assert.strictEqual(spawned.length, 1);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('电脑重启了')));
});

test('restoreAll：closed 的记录直接清掉', async () => {
  const { manager, store } = setup();
  store.upsert({ id: 's_old', chatId: 'oc_9', status: 'closed', agent: 'claude', cwd: 'D:/w' });

  await manager.restoreAll();

  assert.strictEqual(store.get('s_old'), null);
});

test('interrupted 会话收到消息：重开并投递这条消息', async () => {
  const { manager, spawned } = await started();
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '接着干', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.deepStrictEqual(spawned[1].submitted.at(-1), { text: '接着干', origin: 'phone' });
});

test('interrupted + claudeSessionId：重开带着它（--resume 由 launcher 加）', async () => {
  const { manager, store, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned[1].session.claudeSessionId, 'cs_1');
  assert.strictEqual(spawned[1].session.resuming, true);
});

test('--resume 失败：清掉旧会话 ID，改用新会话重建', async () => {
  const { manager, store, calls, spawned, rec } = await started();
  rec.claudeSessionId = 'cs_1';
  store.save();
  await manager.restoreAll();
  await manager.onPhoneMessage({ chatId: 'oc_1', text: '继续', senderOpenId: 'ou_me' });

  spawned[1].emit({ type: 'exit', code: 1 });
  await manager._drain();

  assert.strictEqual(store.get(rec.id).claudeSessionId, null);
  assert.strictEqual(spawned.length, 3);
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('改用新会话重建')));
});

test('interrupted 状态回「重来」：直接重启，不把「重来」当提示词', async () => {
  const { manager, spawned } = await started();
  await manager.restoreAll();

  await manager.onPhoneMessage({ chatId: 'oc_1', text: '重来', senderOpenId: 'ou_me' });

  assert.strictEqual(spawned.length, 2);
  assert.strictEqual(spawned[1].submitted.length, 0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/manager.test.js`
预期：FAIL，`manager.restoreAll is not a function`（新用例 6 个）

- [ ] **步骤 3：编写实现**

修改 `onEvent` 里任务 18 加的那行崩溃通知，按「是否正在 resume」分流：

```js
    if (e.type === 'exit' && record.status === 'error') {
      if (record.resuming) enqueueWork(() => retryWithoutResume(record, e));
      else enqueueWork(() => notifyCrash(record, e));
    }
```

`revive()` 里 `spawn(record);` 之前加一行：

```js
    record.resuming = record.agent === 'claude' && Boolean(record.claudeSessionId);
```

在 `tick` 之前新增：

```js
  // 启动时把 sessions.json 里的旧记录全部标成 interrupted，等用户发话再拉起来。
  async function restoreAll() {
    const records = store.all();
    let restored = 0;
    for (const record of records) {
      if (record.status === 'closed') {
        store.remove(record.id);
        continue;
      }
      record.status = 'interrupted';
      record.ptyPid = null;
      restored += 1;
      try {
        await api.sendText(record.chatId, '电脑重启了，回一条消息我就接上。');
      } catch (err) {
        log.warn('重启提示发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
      }
    }
    store.save();
    return restored;
  }

  // --resume 起不来（记录被删/版本不对）时的兜底：丢掉旧会话 ID，新开一个。
  async function retryWithoutResume(record) {
    record.resuming = false;
    record.claudeSessionId = null;
    record.transcriptPath = null;
    record.status = 'starting';
    store.save();
    try {
      await api.sendText(record.chatId, '上次的对话记录不在了，改用新会话重建。');
    } catch (err) {
      log.warn('重建提示发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
    spawn(record);
    ipc?.broadcast({ type: 'session', session: record });
  }
```

修改 `onPhoneMessage`：

```js
    let ps = sessions.get(record.id);
    let payload = String(text == null ? '' : text).trim();

    if (payload === '重来' && (!ps || ['error', 'closed', 'interrupted'].includes(record.status))) {
      await revive(record);
      return;
    }

    if (!ps || ['error', 'closed', 'closing'].includes(record.status)) {
      await api.sendText(chatId, '这个会话已经停了，回复「重来」重新开一轮。');
      return;
    }
    if (record.status === 'interrupted') {
      const ok = await revive(record);
      if (!ok) return;
      ps = sessions.get(record.id);
    }
```

返回对象补齐：

```js
    restoreAll,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/manager.test.js`
预期：`# pass 42`（原 36 + 新 6）

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/manager.js test/manager.test.js
git commit -m "feat: 重启恢复（interrupted、--resume、失败降级重建）"
```

---

### 任务 20：Codex 轮次结束判定（ptySession 发 turn-end）

规格依据：§6.3「Codex 没有 Stop hook，v1 用终端画面序列化」。

判据：Codex 会话在 `running` 状态下，画面**静默稳定**（`isReady()` + `inInputBox()`）且距写入已超过 1.5s，连续探测 3 次（≈600ms）就认为这一轮结束：先 `releaseTurn()` 把内部状态和队列放开，再派发 `{ type: 'turn-end' }`。

**文件：**
- 修改：`src/session/ptySession.js`
- 测试：`test/ptySession.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

先让测试 harness 支持切换 agent 与推进时钟。把 `test/ptySession.test.js` 里的 `harness()` 改成：

```js
function harness(overrides = {}) {
  const written = [];
  const events = [];
  let dataHandler = () => {};
  let exitHandler = () => {};
  let ready = true;
  let clock = 1000;

  const pty = {
    onData(fn) { dataHandler = fn; },
    onExit(fn) { exitHandler = fn; },
    write(s) { written.push(s); },
    kill() { exitHandler({ exitCode: 0 }); },
  };

  const screen = {
    write(d) { lastScreen += d; },
    isReady: () => ready,
    snapshot: () => 'screen-tail',
    inputLine: () => overrides.inputLine || '输入中的话',
    inInputBox: () => inBox,
    bracketedPaste: (t) => `\x1b[200~${t}\x1b[201~`,
    resize() {},
    dispose() {},
  };
  let lastScreen = '';
  let inBox = true;

  const session = {
    id: 's1', agent: overrides.agent || 'claude', cwd: 'D:/w', status: 'idle', inputSeq: 0, lastInput: null,
  };

  const ps = createPtySession({
    session,
    launch: () => ({ file: 'node', args: ['x.js'], cwd: 'D:/w' }),
    ptyFactory: () => pty,
    screenFactory: () => screen,
    queueFactory: createQueue,
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => events.push(e),
    now: () => clock,
  });

  return {
    ps, written, events, session,
    setReady(v) { ready = v; },
    setInBox(v) { inBox = v; },
    setNow(v) { clock = v; },
    emitData(d) { dataHandler(d); },
    emitExit(code) { exitHandler({ exitCode: code }); },
  };
}
```

在文件末尾追加：

```js
test('codex 轮次结束：画面静默稳定后派发 turn-end 并回到 idle', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');

  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0); // 还没过 1.5s

  h.setNow(7000);
  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 1);
  assert.strictEqual(h.ps.status, 'idle');
});

test('codex 还在刷屏时不判结束', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');
  h.setReady(false);

  h.setNow(9000);
  for (let i = 0; i < 10; i += 1) h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);
  assert.strictEqual(h.ps.status, 'running');
});

test('codex 画面停在菜单（不在输入框）时不判结束', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');
  h.setInBox(false);

  h.setNow(9000);
  for (let i = 0; i < 10; i += 1) h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);
});

test('claude 会话不会误发 turn-end（它走 Stop hook）', () => {
  const h = harness({ agent: 'claude' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('你好', 'phone');

  h.setNow(9000);
  for (let i = 0; i < 10; i += 1) h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);
  assert.strictEqual(h.ps.status, 'running');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/ptySession.test.js`
预期：FAIL，`turn-end` 计数为 0（应 1）

- [ ] **步骤 3：编写实现**

在 `src/session/ptySession.js` 顶部常量区追加：

```js
const CODEX_MIN_TURN_MS = 1500;   // 刚写进去的这段不判结束
const CODEX_SETTLE_POLLS = 3;     // 静默稳定连续 3 次探测（200ms × 3）
```

在 `let disposed = false;` 之后追加：

```js
  let runningSince = 0;
  let settlePolls = 0;
```

`queue.write` 里 `status = 'running';` 之后加：

```js
      runningSince = now();
      settlePolls = 0;
```

`releaseTurn()` 开头加：

```js
    settlePolls = 0;
```

`pollReady()` 末尾（两个既有分支之后）追加：

```js
    // Codex 没有 Stop hook：画面静默稳定且回到输入框，就认为这一轮结束了
    if (status === 'running' && session.agent === 'codex') {
      const stable = screen.isReady() && screen.inInputBox() && now() - runningSince >= CODEX_MIN_TURN_MS;
      settlePolls = stable ? settlePolls + 1 : 0;
      if (settlePolls >= CODEX_SETTLE_POLLS) {
        settlePolls = 0;
        releaseTurn();
        emit({ type: 'turn-end' });
      }
    }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/ptySession.test.js`
预期：`# pass 14`（原 10 + 新 4）

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/ptySession.js test/ptySession.test.js
git commit -m "feat: codex 轮次结束判定（画面静默稳定发 turn-end）"
```

---

### 任务 21：首条消息识别 codex

**文件：**
- 修改：`src/session/router.js`（`parseFirstMessage` 返回值新增 `agent`）
- 修改：`src/session/manager.js:3855`（`createFromPhone` 采用 `parsed.agent`）
- 修改：`test/router.test.js`（两个 `deepStrictEqual` 断言补 `agent: null`）
- 测试：`test/router.test.js`、`test/manager.test.js`

规格验收第 10 条要求「临时草稿 用 codex 写个快排」能开出一个 codex 会话。目前 `createFromPhone` 的 `agent` 只来自 `config.defaultAgent`，手机端没法指定 codex——本任务补上。

识别范围只认两种写法，避免把「看下 codex 配置」这类正文误判：
1. 开头就是 `codex`（可选跟「模式」「:」「：」）；
2. 句中带动词前缀 `用 / 使用 / 走 codex`。

命中后把这一段从 prompt 里去掉，其余原样保留。

- [ ] **步骤 1：编写失败的测试**

先在 `test/router.test.js` 末尾追加三个用例：

```js
test('「用 codex」→ agent=codex，并从 prompt 里去掉这一段', () => {
  const r = parseFirstMessage('卡牌 用 codex 写个快排', {
    ...base,
    aliases: { 卡牌: 'D:/b' },
  });
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.prompt, '写个快排');
  assert.strictEqual(r.cwd, 'D:/b');
});

test('开头直接说 codex 也能识别（带全角冒号）', () => {
  const r = parseFirstMessage('codex：写个快排', base);
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.prompt, '写个快排');
});

test('正文里只是提到 codex 时不改 agent', () => {
  const r = parseFirstMessage('看看 codex 的配置文件在哪', base);
  assert.strictEqual(r.agent, null);
  assert.strictEqual(r.prompt, '看看 codex 的配置文件在哪');
});
```

再把已有的两个 `deepStrictEqual` 用例（「别名命中，剩余部分作为 prompt」和「盘符路径存在时用它」）的期望对象补上 `agent: null`：

```js
  assert.deepStrictEqual(r, {
    cwd: 'D:/★CardGame/demo44',
    alias: '卡牌',
    prompt: '帮我加个技能',
    source: 'alias',
    agent: null,
  });
```

```js
  assert.deepStrictEqual(r, {
    cwd: 'D:/work/alpha',
    alias: null,
    prompt: '跑一下测试',
    source: 'path',
    agent: null,
  });
```

`test/manager.test.js` 追加一个用例：

```js
test('createFromPhone：首条消息提 codex → 记录用 codex，提示词去掉那一段', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 用 codex 写个快排' });
  assert.strictEqual(rec.agent, 'codex');
  assert.deepStrictEqual(spawned[0].submitted, [{ text: '写个快排', origin: 'phone' }]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/router.test.js test/manager.test.js`

预期：FAIL。router 里 `r.agent` 为 `undefined`（`deepStrictEqual` 报多了 `agent` 键），manager 里 `rec.agent` 为 `'claude'`。

- [ ] **步骤 3：编写实现**

`src/session/router.js` 顶部（`SEP` 定义之后）加：

```js
// 「用 codex」「走 codex」「codex：」这类明确指名才算，正文里顺口提到不算
const AGENT_LEAD = /^\s*codex\s*(?:模式)?\s*[:：]?\s*/i;
const AGENT_VERB = /(?:用|使用|走)\s*codex\s*(?:模式)?\s*[:：]?\s*/i;

function splitAgent(prompt) {
  const text = String(prompt || '');
  if (AGENT_LEAD.test(text)) {
    return { agent: 'codex', prompt: text.replace(AGENT_LEAD, '').trim() };
  }
  if (AGENT_VERB.test(text)) {
    return { agent: 'codex', prompt: text.replace(AGENT_VERB, '').replace(/\s+/g, ' ').trim() };
  }
  return { agent: null, prompt: text };
}
```

`parseFirstMessage` 的三个成功分支统一过一层 `withAgent`：

```js
function parseFirstMessage(text, { aliases = {}, defaultCwd, exists = () => false }) {
  const raw = String(text || '').replace(/\uFEFF/g, '').trim();
  const withAgent = (r) => ({ ...r, ...splitAgent(r.prompt) });   // splitAgent 的 prompt 覆盖原值

  for (let len = Math.min(ALIAS_MAX, raw.length); len >= 1; len -= 1) {
    const cand = raw.slice(0, len);
    if (!has(aliases, cand)) continue;
    const rest = raw.slice(len);
    if (rest !== '' && !SEP.test(rest)) continue;
    return withAgent({ cwd: aliases[cand], alias: cand, prompt: rest.replace(SEP, '').trim(), source: 'alias' });
  }

  const m = raw.match(/^([A-Za-z]:[\\/][^\s]*)([\s\S]*)$/);
  if (m) {
    const cwd = m[1];
    const prompt = m[2].replace(SEP, '').trim();
    if (exists(cwd)) return withAgent({ cwd, alias: null, prompt, source: 'path' });
    return withAgent({ cwd: null, alias: null, prompt: raw, source: 'path-missing' });
  }

  return withAgent({ cwd: defaultCwd, alias: null, prompt: raw, source: 'default' });
}
```

`src/session/manager.js` 的 `createFromPhone` 里，`newRecord` 的 `agent` 改为：

```js
      agent: parsed.agent || agent,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/router.test.js test/manager.test.js`

预期：PASS。router 11 个、manager 43 个，`# fail 0`。

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge && git add src/session/router.js src/session/manager.js test/router.test.js test/manager.test.js && git commit -m "feat: 首条消息识别 codex"
```

---

### 任务 22：Codex 画面推送卡 +「查看完整画面」按钮

**文件：**
- 修改：`src/feishu/cards.js`（新增 `screenOutputCard`、`fullScreenCard`）
- 修改：`src/session/manager.js`（`turn-end` → 推画面；`onCardAction` 处理 `full-screen`）
- 测试：`test/feishu-cards.test.js`、`test/manager.test.js`

Claude 靠 Stop hook 把 `last_assistant_message` 推回群里；Codex 没有 hook，只能看到屏幕。任务 20 已经在轮次结束时派发 `turn-end`，本任务把它变成手机能读的东西：

- `turn-end` 到达 → manager 取屏上最近 40 行 → 发 `screenOutputCard`（电脑端问的，顶部带「🖥 你刚在电脑上问：…」；手机端问的，显示「这一轮跑完了」）；
- 卡片上的「查看完整画面」按钮 → 回一张 `fullScreenCard`，默认 200 行（40~500 之间夹取）；
- 会话已停 / 画面取不到时，按钮回一句提示，不静默。

- [ ] **步骤 1：编写失败的测试**

`test/feishu-cards.test.js` 末尾追加：

```js
test('screenOutputCard：引导行 + 代码块 + 查看完整画面按钮', () => {
  const c = cards.screenOutputCard({
    lead: '🖥 你刚在电脑上问：写个快排',
    text: 'def quicksort():\n    pass',
    agent: 'codex',
    cwd: 'D:/x',
  });
  const body = JSON.stringify(c.body);
  assert.ok(body.includes('你刚在电脑上问'));
  assert.ok(body.includes('def quicksort'));
  const btn = c.body.elements.find((e) => e.tag === 'button');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'full-screen', lines: 200 });
});

test('screenOutputCard：超长画面截断', () => {
  const c = cards.screenOutputCard({ text: 'x'.repeat(9000) });
  assert.ok(JSON.stringify(c.body).includes('已截断'));
});

test('fullScreenCard：标题带行数，正文带画面', () => {
  const c = cards.fullScreenCard({ text: '第 1 行\n第 200 行', lines: 200 });
  assert.ok(c.header.title.content.includes('200'));
  assert.ok(JSON.stringify(c.body).includes('第 200 行'));
});
```

`test/manager.test.js` 末尾追加：

```js
test('codex turn-end：把最近画面推回群里，电脑来源带 🖥 引言行', async () => {
  const h = setup();
  const rec = await h.manager.createFromPhone({ chatId: 'oc_1', chatName: '卡牌', text: '卡牌 codex 写个快排' });
  const ps = h.spawned[0];
  ps.emit({ type: 'ready' });
  ps.emit({ type: 'pc-input', input: { seq: 2, origin: 'pc', text: '帮我写快排', at: 2 } });
  ps.emit({ type: 'turn-start', text: '帮我写快排' });
  ps.screenText = 'def quicksort():\n    pass';
  ps.emit({ type: 'turn-end' });
  await h.manager._drain();

  const card = h.calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  const body = JSON.stringify(card.body);
  assert.ok(body.includes('你刚在电脑上问：帮我写快排'));
  assert.ok(body.includes('def quicksort'));
  assert.strictEqual(h.store.get(rec.id).status, 'idle');
});

test('onCardAction：full-screen 回最近 200 行画面', async () => {
  const { manager, calls, spawned } = await started();
  spawned[0].screenText = '第 1 行\n第 200 行';
  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen', lines: 200 } });

  const card = calls.filter((c) => c[0] === 'sendCard').at(-1)[2];
  assert.ok(card.header.title.content.includes('200'));
  assert.ok(JSON.stringify(card.body).includes('第 200 行'));
});

test('onCardAction：会话已停时 full-screen 回提示', async () => {
  const { manager, calls, spawned } = await started();
  spawned[0].emit({ type: 'exit', code: 1 });
  await manager._drain();

  await manager.onCardAction({ chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen' } });
  assert.ok(calls.some((c) => c[0] === 'sendText' && c[2].includes('会话已经停了')));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/feishu-cards.test.js test/manager.test.js`

预期：FAIL，`cards.screenOutputCard is not a function`。

- [ ] **步骤 3：编写实现**

`src/feishu/cards.js` 在 `errorCard` 之后、`module.exports` 之前加：

```js
function screenOutputCard({ lead, text, agent, cwd }) {
  return card({
    title: '🖥 Codex 输出',
    template: 'turquoise',
    elements: elements(
      lead ? md(lead) : null,
      md('```\n' + truncate(text || '（无画面）', 6000).text + '\n```'),
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '查看完整画面' },
        type: 'default',
        behaviors: [{ type: 'callback', value: { act: 'full-screen', lines: 200 } }],
      },
      footer({ agent, cwd }),
    ),
  });
}

function fullScreenCard({ text, lines }) {
  return card({
    title: `🖥 最近 ${lines} 行`,
    template: 'turquoise',
    elements: elements(md('```\n' + truncate(text || '（无画面）', 6000).text + '\n```')),
  });
}
```

`module.exports` 里补上 `screenOutputCard, fullScreenCard,`（放在 `screenCard,` 之后）。

`src/session/manager.js`：

1）`PERSIST_EVENTS` 加 `'turn-end'`：

```js
const PERSIST_EVENTS = new Set(['spawned', 'ready', 'turn-start', 'turn-end', 'exit', 'input', 'pc-input', 'overflow']);
```

2）`onEvent` 里补状态与推送（`turn-start` 分支之后）：

```js
    else if (e.type === 'turn-end' && record.status === 'running') record.status = 'idle';
```

在已有的 `exit` 推送判断之后加：

```js
    if (e.type === 'turn-end') enqueueWork(() => pushScreenOutput(record));
```

3）在 `notifyCrash` 之后新增：

```js
  // Codex 没有 Stop hook：轮次结束时把屏上最近画面推回群里当回复
  async function pushScreenOutput(record) {
    if (record.agent !== 'codex') return;
    const ps = sessions.get(record.id);
    if (!ps || ['error', 'closed', 'closing'].includes(record.status)) return;
    let snap = '';
    try {
      snap = ps.screen.snapshot({ lines: 40 });
    } catch (err) {
      log.warn('取画面失败', { sessionId: record.id, message: String((err && err.message) || err) });
      return;
    }
    const input = record.lastInput;
    const fromPc = input && input.origin === 'pc' && String(input.text || '').trim();
    const lead = fromPc
      ? `🖥 你刚在电脑上问：${String(input.text).replace(/\s+/g, ' ').slice(0, 80)}`
      : '🖥 这一轮跑完了：';
    try {
      await api.sendCard(record.chatId, cards.screenOutputCard({
        lead, text: snap, agent: record.agent, cwd: record.cwd,
      }));
    } catch (err) {
      log.warn('画面推送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
  }
```

4）`onCardAction` 里 `force-send` 分支之后加：

```js
          if (act === 'full-screen') {
            const record = store.getByChat(chatId);
            const ps = record ? sessions.get(record.id) : null;
            if (!ps || ['error', 'closed', 'closing', 'interrupted'].includes(record.status)) {
              await api.sendText(chatId, '会话已经停了，看不到完整画面了。');
              return;
            }
            const lines = Math.min(Math.max(Number(action.lines) || 200, 40), 500);
            let snap = '';
            try {
              snap = ps.screen.snapshot({ lines });
            } catch (err) {
              log.warn('取画面失败', { chatId, message: String((err && err.message) || err) });
              return;
            }
            await api.sendCard(chatId, cards.fullScreenCard({ text: snap, lines }));
            return;
          }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/feishu-cards.test.js test/manager.test.js`

预期：PASS。cards 10 个、manager 46 个，`# fail 0`。

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge && git add src/feishu/cards.js src/session/manager.js test/feishu-cards.test.js test/manager.test.js && git commit -m "feat: codex 画面推送卡与查看完整画面按钮"
```

---

### 任务 23：飞书事件载荷解析

**文件：**
- 创建：`src/feishu/events.js`
- 测试：`test/feishu-events.test.js`

飞书的事件载荷形如 `{ event_id, sender: { sender_id: { open_id }, sender_type }, message: { message_id, chat_id, chat_type, message_type, content, mentions } }`，`content` 是一段 JSON **字符串**。`events.js` 只做纯函数解析，不碰网络、不碰状态——这样守卫逻辑（防回环、@ 过滤、owner 校验）可以单测。

- [ ] **步骤 1：编写失败的测试**

```js
// test/feishu-events.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseMessage, parseCardAction, parseChatId } = require('../src/feishu/events');

function evt(over = {}, msgOver = {}) {
  return {
    event_id: 'ev_1',
    sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"你好"}',
      ...msgOver,
    },
    ...over,
  };
}

test('解析文本消息的基本字段', () => {
  const m = parseMessage(evt());
  assert.deepStrictEqual(m, {
    chatId: 'oc_1', chatType: 'p2p', messageId: 'om_1', openId: 'ou_me',
    senderType: 'user', text: '你好', media: null, mentioned: false, unsupported: null,
  });
});

test('剥离 @_user_N 占位符并标记 mentioned', () => {
  const m = parseMessage(evt({}, {
    chat_type: 'group',
    content: '{"text":"@_user_1 看看这个"}',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '桥' }],
  }));
  assert.strictEqual(m.text, '看看这个');
  assert.strictEqual(m.mentioned, true);
  assert.strictEqual(m.chatType, 'group');
});

test('富文本 post 拉平为带标题的文本', () => {
  const content = JSON.stringify({
    title: '标题',
    content: [
      [{ tag: 'text', text: '第一段' }, { tag: 'at', user_id: '@_user_1', user_name: '桥' }],
      [{ tag: 'text', text: '第二段' }],
    ],
  });
  const m = parseMessage(evt({}, { message_type: 'post', content, mentions: [{ key: '@_user_1', name: '桥' }] }));
  assert.strictEqual(m.text, '标题\n第一段@桥\n第二段');
  assert.strictEqual(m.mentioned, true);
});

test('图片消息解析出 media', () => {
  const m = parseMessage(evt({}, { message_type: 'image', content: '{"image_key":"img_1"}' }));
  assert.deepStrictEqual(m.media, { messageId: 'om_1', fileKey: 'img_1', type: 'image', fileName: 'om_1.png' });
  assert.strictEqual(m.text, '');
});

test('文件消息保留原始文件名', () => {
  const m = parseMessage(evt({}, { message_type: 'file', content: '{"file_key":"file_1","file_name":"需求.md"}' }));
  assert.deepStrictEqual(m.media, { messageId: 'om_1', fileKey: 'file_1', type: 'file', fileName: '需求.md' });
});

test('机器人自己发的消息返回 null（防回环）', () => {
  assert.strictEqual(parseMessage(evt({ sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' } })), null);
});

test('无法解析的 content 与空载荷不抛异常', () => {
  const m = parseMessage(evt({}, { content: '{坏' }));
  assert.strictEqual(m.text, '');
  assert.strictEqual(parseMessage({}), null);
});

test('不支持的类型放进 unsupported', () => {
  const m = parseMessage(evt({}, { message_type: 'audio', content: '{"file_key":"a_1"}' }));
  assert.strictEqual(m.unsupported, 'audio');
  assert.strictEqual(m.media, null);
});

test('卡片动作从 context.open_chat_id 取群，缺字段返回 null', () => {
  const a = parseCardAction({
    operator: { open_id: 'ou_me' },
    action: { value: { act: 'send', sessionId: 's_1' } },
    context: { open_chat_id: 'oc_1' },
  });
  assert.deepStrictEqual(a, {
    chatId: 'oc_1', openId: 'ou_me', action: { act: 'send', sessionId: 's_1' },
  });
  assert.strictEqual(parseCardAction({ operator: { open_id: 'ou_me' }, action: { value: { act: 'send' } } }), null);
  assert.strictEqual(parseCardAction({ context: { open_chat_id: 'oc_1' }, action: { value: {} } }), null);
});

test('parseChatId 兼容两种群事件载荷', () => {
  assert.strictEqual(parseChatId({ chat_id: 'oc_1' }), 'oc_1');
  assert.strictEqual(parseChatId({ chat: { chat_id: 'oc_2' } }), 'oc_2');
  assert.strictEqual(parseChatId({ message: { chat_id: 'oc_3' } }), 'oc_3');
  assert.strictEqual(parseChatId({}), '');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/feishu-events.test.js`
预期：FAIL，`Cannot find module '../src/feishu/events'`

- [ ] **步骤 3：编写实现**

```js
// src/feishu/events.js

function parseContent(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function postToText(post) {
  const blocks = Array.isArray(post && post.content) ? post.content : [];
  const lines = blocks.map((line) => (Array.isArray(line) ? line : []).map((el) => {
    if (!el) return '';
    if (el.tag === 'text') return String(el.text || '');
    if (el.tag === 'a') return String(el.text || '') || String(el.href || '');
    if (el.tag === 'at') return el.user_name ? `@${el.user_name}` : '';
    return '';
  }).join(''));
  const body = lines.filter((l) => l !== '').join('\n');
  const title = post && post.title ? String(post.title) : '';
  if (!title) return body;
  return body ? `${title}\n${body}` : title;
}

function stripMentions(text, mentions) {
  let out = String(text || '');
  for (const m of mentions || []) {
    if (m && m.key) out = out.split(m.key).join('');
  }
  out = out.replace(/@_user_\d+/g, '');
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function parseMessage(evt) {
  const msg = evt && evt.message;
  if (!msg || !msg.chat_id) return null;
  const sender = evt.sender || {};
  const senderType = sender.sender_type || 'user';
  if (senderType === 'app' || senderType === 'bot') return null;   // 防回环

  const type = msg.message_type || 'text';
  const content = parseContent(msg.content);
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const base = {
    chatId: String(msg.chat_id),
    chatType: msg.chat_type || 'p2p',
    messageId: msg.message_id || '',
    openId: (sender.sender_id && sender.sender_id.open_id) || '',
    senderType,
    text: '',
    media: null,
    mentioned: mentions.length > 0,
    unsupported: null,
  };

  if (type === 'text') {
    base.text = stripMentions(content.text, mentions);
    return base;
  }
  if (type === 'post') {
    base.text = stripMentions(postToText(content), mentions);
    return base;
  }
  if (type === 'image' && content.image_key) {
    base.media = { messageId: base.messageId, fileKey: content.image_key, type: 'image', fileName: `${base.messageId || 'image'}.png` };
    return base;
  }
  if (type === 'file' && content.file_key) {
    base.media = { messageId: base.messageId, fileKey: content.file_key, type: 'file', fileName: content.file_name || `${base.messageId}.bin` };
    return base;
  }
  base.unsupported = type;
  return base;
}

function parseCardAction(evt) {
  const ctx = (evt && evt.context) || {};
  const chatId = evt && (evt.open_chat_id || ctx.open_chat_id);
  const action = evt && evt.action && evt.action.value;
  if (!chatId || !action || !action.act) return null;
  return { chatId: String(chatId), openId: (evt.operator && evt.operator.open_id) || '', action };
}

function parseChatId(evt) {
  if (!evt) return '';
  return String(evt.chat_id || (evt.chat && evt.chat.chat_id) || (evt.message && evt.message.chat_id) || '');
}

module.exports = { parseMessage, parseCardAction, parseChatId };
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/feishu-events.test.js`
预期：`# pass 10`，`# fail 0`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/feishu/events.js test/feishu-events.test.js
git commit -m "feat: 飞书事件载荷解析"
```

---

### 任务 24：窗口通道补齐（resize / onPcKeys / list / shutdown）

**文件：**
- 修改：`src/session/ptySession.js`（加 `resize`）
- 修改：`src/session/manager.js`（加 `onPcKeys`、`onPcResize`、`list`、`shutdown`，并给 exit 分支加停机守卫）
- 测试：`test/ptySession.test.js`（+1）、`test/manager.test.js`（+4）

§2 里 IPC 协议声明了 `input` / `resize` / `list`，窗口端和 `bin/daemon.js` 都要用；`shutdown()` 是「电脑正常退出」时的收尾——不能走 `closeSession`（那会删记录、可能解散群），要走「杀 PTY + 标记 interrupted」，留给下次启动的 `restoreAll()` 接上。

- [ ] **步骤 1：修改测试脚手架并追加失败的测试**

**1a. `test/ptySession.test.js` 的 `harness()`：** 让假 PTY 与假屏幕记录尺寸。

```js
  const written = [];
  const resized = [];
  const screenResized = [];
  const events = [];
```

```js
    write(s) { written.push(s); },
    resize(c, r) { resized.push([c, r]); },
    kill() { exitHandler({ exitCode: 0 }); },
```

```js
    resize(c, r) { screenResized.push([c, r]); },
    dispose() {},
```

```js
  return {
    ps, written, events, session,
    get resized() { return resized; },
    get screenResized() { return screenResized; },
```

在该文件末尾追加：

```js
test('resize：合法尺寸转发给屏幕与 PTY，非法尺寸忽略', () => {
  const h = harness();
  h.ps.start();
  h.ps.resize(100, 30);
  h.ps.resize(0, 30);
  h.ps.resize(100, -1);
  assert.deepStrictEqual(h.resized, [[100, 30]]);
  assert.deepStrictEqual(h.screenResized, [[100, 30]]);
});
```

**1b. `test/manager.test.js` 的 `setup()`：** 给假 PTY 补 `onPcKeys` / `resize` / `snapshot`。

```js
      onPcKeys(data) { (ps.keys || (ps.keys = [])).push(data); },
      resize(cols, rows) { (ps.resized || (ps.resized = [])).push([cols, rows]); },
      snapshot() { return { id: o.session.id, chatId: o.session.chatId, agent: o.session.agent, cwd: o.session.cwd }; },
      needsConfirm() { return ps.confirm; },
```

在文件末尾追加：

```js
test('onPcKeys：转发电脑按键，忽略空数据与未知会话', async () => {
  const { manager, spawned } = await started();
  const id = spawned[0].session.id;
  manager.onPcKeys({ sessionId: id, data: 'a' });
  manager.onPcKeys({ sessionId: id, data: '' });
  manager.onPcKeys({ sessionId: id });
  manager.onPcKeys({ sessionId: 'nope', data: 'b' });
  assert.deepStrictEqual(spawned[0].keys, ['a']);
});

test('onPcResize：转发合法尺寸，忽略非法尺寸与未知会话', async () => {
  const { manager, spawned } = await started();
  const id = spawned[0].session.id;
  manager.onPcResize({ sessionId: id, cols: 120, rows: 40 });
  manager.onPcResize({ sessionId: id, cols: 0, rows: 40 });
  manager.onPcResize({ sessionId: 'nope', cols: 10, rows: 10 });
  assert.deepStrictEqual(spawned[0].resized, [[120, 40]]);
});

test('list：活会话叠加快照，退出后状态为 error', async () => {
  const { manager, spawned, rec } = await started();
  const live = manager.list().find((s) => s.id === rec.id);
  assert.strictEqual(live.status, 'idle');
  assert.strictEqual(live.cwd, 'D:/w');

  spawned[0].emit({ type: 'exit', code: 1 });
  await manager._drain();
  const dead = manager.list().find((s) => s.id === rec.id);
  assert.strictEqual(dead.status, 'error');
});

test('shutdown：杀 PTY、标记 interrupted、不解散群也不推崩溃卡', async () => {
  const { manager, calls, store, spawned, rec } = await started();
  spawned[0].kill = () => {
    spawned[0].killed = true;
    spawned[0].emit({ type: 'exit', code: 1 });
  };
  await manager.shutdown();
  await manager._drain();

  assert.strictEqual(spawned[0].killed, true);
  assert.strictEqual(store.get(rec.id).status, 'interrupted');
  assert.strictEqual(store.get(rec.id).ptyPid, null);
  assert.ok(!calls.some((c) => c[0] === 'disbandChat'));
  assert.ok(!calls.some((c) => c[0] === 'sendCard'));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/ptySession.test.js test/manager.test.js`
预期：FAIL，`h.ps.resize is not a function`、`manager.onPcKeys is not a function`

- [ ] **步骤 3：编写实现**

**3a. `src/session/ptySession.js`：** 在 `onPcKeys` 函数之后新增：

```js
  // 窗口改尺寸：屏幕缓冲和 ConPTY 都要跟着变，否则换行位置会错。
  function resize(cols, rows) {
    const c = Math.floor(Number(cols));
    const r = Math.floor(Number(rows));
    if (!(c > 0 && r > 0)) return;
    if (screen && typeof screen.resize === 'function') screen.resize(c, r);
    if (pty && typeof pty.resize === 'function') pty.resize(c, r);
  }
```

返回对象里 `onPcKeys,` 之后补一行：

```js
    resize,
```

**3b. `src/session/manager.js`：** 在 `const sessions = new Map();` 之后新增停机标志：

```js
  let shuttingDown = false;
```

把任务 18 / 19 加的两处 exit 守卫改成（注意 `!shuttingDown`）：

```js
    else if (e.type === 'exit' && record.status !== 'closing' && !shuttingDown) record.status = 'error';
```

```js
    if (e.type === 'exit' && record.status === 'error' && !shuttingDown) {
      if (record.resuming) enqueueWork(() => retryWithoutResume(record, e));
      else enqueueWork(() => notifyCrash(record, e));
    }
```

在 `restoreAll` 之后新增：

```js
  function onPcKeys({ sessionId, data }) {
    const ps = sessions.get(sessionId);
    if (!ps || typeof data !== 'string' || data === '') return;
    ps.onPcKeys(data);
  }

  function onPcResize({ sessionId, cols, rows }) {
    const ps = sessions.get(sessionId);
    if (!ps || typeof ps.resize !== 'function') return;
    const c = Math.floor(Number(cols));
    const r = Math.floor(Number(rows));
    if (!(c > 0 && r > 0)) return;
    ps.resize(c, r);
  }

  // 窗口连上来时的会话清单：以持久化记录为准，活会话叠加内存里的 pending/lastInput。
  function list() {
    return store.all().map((record) => {
      const ps = sessions.get(record.id);
      const snap = ps && typeof ps.snapshot === 'function' ? ps.snapshot() : {};
      return { ...record, ...snap, status: record.status };
    });
  }

  // 电脑正常退出：只杀进程、标记 interrupted，记录留着给下次启动 restoreAll() 接上。
  async function shutdown() {
    shuttingDown = true;
    for (const id of [...sessions.keys()]) {
      const ps = sessions.get(id);
      const record = store.get(id);
      sessions.delete(id);
      try {
        ps.kill();
      } catch (err) {
        log.warn('结束 PTY 失败', { sessionId: id, message: String((err && err.message) || err) });
      }
      if (record) {
        record.status = 'interrupted';
        record.ptyPid = null;
        record.lastActiveAt = new Date(now()).toISOString();
      }
    }
    store.save();
  }
```

返回对象里 `restoreAll,` 之后补：

```js
    onPcKeys,
    onPcResize,
    list,
    shutdown,
```

**3c. 同步 §2 契约注释**，把 `list()` 那行改成：

```js
  list() -> Array<record>                                       // IPC {type:'list'} 的应答：记录为准，活会话叠加快照
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/ptySession.test.js test/manager.test.js`
预期：ptySession `# pass 11`、manager `# pass 50`，`# fail 0`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/session/ptySession.js src/session/manager.js test/ptySession.test.js test/manager.test.js docs/superpowers/plans/2026-11-23-feishu-agent-bridge.md
git commit -m "feat: 窗口通道补齐（resize / 电脑按键转发 / 会话清单 / 停机收尾）"
```

---

### 任务 25：守护进程装配 `bin/daemon.js`

**文件：**
- 创建：`bin/daemon.js`
- 测试：`test/daemon.test.js`
- 修改：`docs/superpowers/plans/2026-11-23-feishu-agent-bridge.md`（§2 两行契约补全，见步骤 3c）

`daemon.js` 是唯一把网络、进程、磁盘串起来的地方，所以它自己几乎不含业务逻辑——只做四件事：**装配**（把工厂注入 manager / ws / ipc）、**守卫**（凭据缺失、单实例）、**事件翻译**（飞书载荷 → manager 调用）、**生命周期**（start/stop、SIGINT/SIGTERM、30s 巡检）。所有依赖都可注入，测试里全部用假件。

- [ ] **步骤 1：编写失败的测试**

```js
// test/daemon.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createDaemon, main } = require('../bin/daemon');

const CONFIG = {
  appId: 'cli_0123456789abcdef',
  ownerOpenId: 'ou_me',
  ownerChatId: 'oc_own',
  defaultAgent: 'claude',
  autoDisband: false,
  claudeExe: 'claude',
  claudeArgs: [],
  codexEntry: 'codex.js',
  codexArgs: [],
  defaultCwd: 'D:/w',
  queueLimit: 20,
  sweepIntervalMs: 0,
  ipcPort: 47831,
};

function makeDeps(over = {}) {
  const calls = {
    sent: [], text: [], manager: [], order: [],
    dirs: 0, storeLoaded: 0, redacted: null,
    managerOpts: null, ipcOpts: null, wsOpts: null,
    apiOpts: null, launchOpts: null, spawnArgs: null,
  };
  const manager = {
    list: () => [],
    createFromPhone: async () => null,
    createFromPc: async (a) => { calls.manager.push(['createFromPc', a]); return { id: 's_new' }; },
    onPhoneMessage: async (a) => { calls.manager.push(['onPhoneMessage', a]); },
    onCardAction: async (a) => { calls.manager.push(['onCardAction', a]); },
    onHookStop: async (a) => { calls.manager.push(['onHookStop', a]); },
    onPcKeys: (a) => { calls.manager.push(['onPcKeys', a]); },
    onPcResize: (a) => { calls.manager.push(['onPcResize', a]); },
    onDisbanded: async (a) => { calls.manager.push(['onDisbanded', a]); },
    onBotRemoved: async (a) => { calls.manager.push(['onBotRemoved', a]); },
    closeSession: async (a, b) => { calls.manager.push(['closeSession', a, b]); },
    restoreAll: async () => { calls.order.push('restoreAll'); },
    shutdown: async () => { calls.order.push('shutdown'); },
    tick: async () => { calls.order.push('tick'); },
  };
  const ipc = {
    port: 51000,
    handlers: null,
    send: (ws, obj) => calls.sent.push({ ws, obj }),
    broadcast: () => {},
    close: async () => { calls.order.push('ipcClosed'); },
  };
  const ws = {
    start: async () => { calls.order.push('wsStart'); },
    close: async () => { calls.order.push('wsClosed'); },
  };
  const api = {
    sendText: async (chatId, text) => { calls.text.push([chatId, text]); },
  };
  const deps = {
    pathsApi: {
      CONFIG: 'C:/state/config.json',
      LOGS: 'C:/logs',
      SECRET: 'C:/state/secret',
      SESSIONS: 'C:/state/sessions.json',
      PROJECTS: 'C:/state/projects.json',
      IPC: 'C:/state/ipc.json',
      HOOKS: 'C:/hooks',
      HOOK_SCRIPT: 'C:/bin/hook-stop.js',
      CLAUDE_JSON: 'C:/Users/me/.claude.json',
      ensureDirs() { calls.dirs += 1; },
    },
    loadConfigFn: () => ({ ...CONFIG }),
    logger: () => ({ info() {}, warn() {}, error() {}, redactor: { add(v) { calls.redacted = v; } } }),
    secretStoreFactory: () => ({ load: () => 'sec_1' }),
    storeFactory: () => ({
      load() { calls.storeLoaded += 1; return this; },
      all: () => [], get: () => null, getByChat: () => null,
      upsert() {}, remove() {}, save() {},
    }),
    apiFactory: (o) => { calls.apiOpts = o; return api; },
    ipcFactory: async (o) => { calls.ipcOpts = o; ipc.handlers = o.handlers; return ipc; },
    wsFactory: (o) => { calls.wsOpts = o; return ws; },
    managerFactory: (o) => { calls.managerOpts = o; return manager; },
    ptySessionFactory: (o) => o,
    ptyModule: { spawn: (...args) => { calls.spawnArgs = args; return { kill() {} }; } },
    launchFn: (o) => { calls.launchOpts = o; return { file: 'fake', args: [], cwd: o.session.cwd }; },
    screenFactory: () => ({ fake: true }),
    getProjectsFn: () => ({ aliases: { 卡牌: 'D:/card' }, default: 'D:/w' }),
    randomToken: () => 'tok',
    ...over,
  };
  return { deps, calls, manager, ipc, ws, api };
}

function fakeFs({ ipcExists = false, content = '{}' } = {}) {
  const log = { unlinked: [] };
  return {
    log,
    existsSync: () => ipcExists,
    readFileSync: () => content,
    unlinkSync: (p) => { log.unlinked.push(p); },
  };
}

function evt(over = {}) {
  return {
    sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p',
      message_type: 'text', content: '{"text":"你好"}', ...over,
    },
  };
}

test('缺凭据：报错并提示先跑 setup', async () => {
  const noSecret = makeDeps({ secretStoreFactory: () => ({ load: () => null }) });
  await assert.rejects(() => createDaemon({ deps: noSecret.deps }), /npm run setup/);

  const noAppId = makeDeps({ loadConfigFn: () => ({ ...CONFIG, appId: '' }) });
  await assert.rejects(() => createDaemon({ deps: noAppId.deps }), /npm run setup/);
  assert.strictEqual(noAppId.calls.ipcOpts, null);
});

test('装配：密钥进 redactor，store 先加载，各工厂拿到正确参数', async () => {
  const { deps, calls } = makeDeps();
  const daemon = await createDaemon({ deps });

  assert.strictEqual(calls.redacted, 'sec_1');
  assert.strictEqual(calls.dirs, 1);
  assert.strictEqual(calls.storeLoaded, 1);
  assert.strictEqual(calls.apiOpts.appId, CONFIG.appId);
  assert.strictEqual(calls.apiOpts.appSecret, 'sec_1');
  assert.strictEqual(calls.ipcOpts.token, 'tok');
  assert.strictEqual(calls.ipcOpts.port, 47831);
  assert.strictEqual(calls.ipcOpts.ipcFile, 'C:/state/ipc.json');
  assert.strictEqual(calls.wsOpts.appId, CONFIG.appId);
  assert.strictEqual(calls.wsOpts.appSecret, 'sec_1');
  assert.strictEqual(calls.managerOpts.config.appId, CONFIG.appId);
  assert.strictEqual(calls.managerOpts.getProjects().aliases['卡牌'], 'D:/card');
  assert.strictEqual(daemon.port, 51000);
});

test('PTY 工厂：launch 拿到 hook 路径，spawn / 屏幕 / 队列逐个透传', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });

  const wrapped = calls.managerOpts.createPtySession({
    session: { id: 's1', agent: 'claude', cwd: 'D:/w' }, onEvent() {}, queueLimit: 20,
  });
  const launch = wrapped.launch({ id: 's1', agent: 'claude', cwd: 'D:/w' });
  assert.deepStrictEqual(launch, { file: 'fake', args: [], cwd: 'D:/w' });
  assert.strictEqual(calls.launchOpts.hooksDir, 'C:/hooks');
  assert.strictEqual(calls.launchOpts.hookScript, 'C:/bin/hook-stop.js');
  assert.strictEqual(calls.launchOpts.claudeJsonPath, 'C:/Users/me/.claude.json');
  assert.strictEqual(calls.launchOpts.config.appId, CONFIG.appId);

  assert.ok(wrapped.ptyFactory('codex.js', ['--x'], { cwd: 'D:/w' }));
  assert.deepStrictEqual(calls.spawnArgs, ['codex.js', ['--x'], { cwd: 'D:/w' }]);
  assert.deepStrictEqual(wrapped.screenFactory({ cols: 120, rows: 30 }), { fake: true });
});

test('手机文本：p2p 直接转发，群聊必须 @，占位符被剥掉', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });
  const onMessage = calls.wsOpts.handlers.onMessage;

  onMessage(evt());
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onPhoneMessage',
    { chatId: 'oc_1', text: '你好', media: null, senderOpenId: 'ou_me' },
  ]);

  const before = calls.manager.length;
  onMessage(evt({ chat_type: 'group', content: '{"text":"@_user_1 你好"}' }));
  assert.strictEqual(calls.manager.length, before);

  onMessage(evt({
    chat_type: 'group',
    content: '{"text":"@_user_1 开工"}',
    mentions: [{ key: '@_user_1' }],
  }));
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onPhoneMessage',
    { chatId: 'oc_1', text: '开工', media: null, senderOpenId: 'ou_me' },
  ]);
});

test('不支持的消息类型：群里回一句提示，不进 manager', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });
  const before = calls.manager.length;
  calls.wsOpts.handlers.onMessage(evt({ message_type: 'audio', content: '{"file_key":"a"}' }));

  assert.strictEqual(calls.manager.length, before);
  assert.strictEqual(calls.text.length, 1);
  assert.strictEqual(calls.text[0][0], 'oc_1');
  assert.ok(calls.text[0][1].includes('audio'));
});

test('卡片动作与群事件：翻译成 manager 的入参', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });
  const handlers = calls.wsOpts.handlers;

  handlers.onCardAction({
    operator: { open_id: 'ou_me' },
    action: { value: { act: 'full-screen', lines: 200 } },
    context: { open_chat_id: 'oc_1' },
  });
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onCardAction',
    { chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen', lines: 200 } },
  ]);

  handlers.onDisbanded({ chat_id: 'oc_1' });
  handlers.onBotRemoved({ chat: { chat_id: 'oc_2' } });
  assert.deepStrictEqual(calls.manager.at(-2), ['onDisbanded', { chatId: 'oc_1' }]);
  assert.deepStrictEqual(calls.manager.at(-1), ['onBotRemoved', { chatId: 'oc_2' }]);
});

test('IPC 客户端消息：list / ping / input / resize / create / close / 未知', async () => {
  const { deps, calls, ipc } = makeDeps();
  await createDaemon({ deps });
  const ws = { fake: true };
  const onClientMessage = ipc.handlers.onClientMessage;

  onClientMessage({ type: 'list' }, ws);
  assert.deepStrictEqual(calls.sent.at(-1).obj, { type: 'sessions', list: [] });

  onClientMessage({ type: 'ping' }, ws);
  assert.deepStrictEqual(calls.sent.at(-1).obj, { type: 'pong' });

  onClientMessage({ type: 'input', sessionId: 's1', data: 'a' }, ws);
  assert.deepStrictEqual(calls.manager.at(-1), ['onPcKeys', { sessionId: 's1', data: 'a' }]);

  onClientMessage({ type: 'resize', sessionId: 's1', cols: 100, rows: 30 }, ws);
  assert.deepStrictEqual(calls.manager.at(-1), ['onPcResize', { sessionId: 's1', cols: 100, rows: 30 }]);

  onClientMessage({ type: 'create', cwd: 'D:/x', agent: 'codex' }, ws);
  onClientMessage({ type: 'close', sessionId: 's1' }, ws);
  onClientMessage({ type: 'bogus' }, ws);
  await new Promise((r) => setImmediate(r));

  const sent = calls.sent.map((s) => s.obj);
  assert.ok(sent.some((o) => o.type === 'session' && o.session.id === 's_new'));
  assert.deepStrictEqual(
    calls.manager.find((c) => c[0] === 'closeSession'),
    ['closeSession', 's1', { reason: '窗口关闭', notify: true }],
  );
  assert.ok(sent.some((o) => o.type === 'error' && o.message.includes('bogus')));
});

test('start / stop：先恢复会话再连飞书；退出时先断连再收尾', async () => {
  const { deps, calls } = makeDeps();
  const daemon = await createDaemon({ deps });

  await daemon.start();
  assert.deepStrictEqual(calls.order, ['restoreAll', 'wsStart']);
  await daemon.stop();
  assert.deepStrictEqual(calls.order, ['restoreAll', 'wsStart', 'wsClosed', 'shutdown', 'ipcClosed']);
});

test('main：已有实例在跑就直接退出，不再装配', async () => {
  const h = makeDeps({
    fsApi: fakeFs({ ipcExists: true, content: JSON.stringify({ port: 51000, pid: 999 }) }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    attachSignals: false,
  });
  const r = await main({ deps: h.deps });

  assert.deepStrictEqual(r, { started: false, pid: 999, port: 51000 });
  assert.strictEqual(h.calls.ipcOpts, null);
});

test('main：陈旧 ipc.json 探活失败后删掉并正常启动', async () => {
  const fsApi = fakeFs({ ipcExists: true, content: JSON.stringify({ port: 51000, pid: 999 }) });
  const h = makeDeps({
    fsApi,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    attachSignals: false,
  });
  const r = await main({ deps: h.deps });

  assert.strictEqual(r.started, true);
  assert.deepStrictEqual(fsApi.log.unlinked, ['C:/state/ipc.json']);
  assert.ok(h.calls.ipcOpts);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/daemon.test.js`
预期：FAIL，`Cannot find module '../bin/daemon'`

- [ ] **步骤 3：编写实现**

**3a. 新建 `bin/daemon.js`：**

```js
#!/usr/bin/env node
// bin/daemon.js —— 单例后台守护：唯一持有 PTY 与飞书长连接，窗口和 hook 都只是它的客户端。
const fs = require('node:fs');
const crypto = require('node:crypto');
const pty = require('node-pty');
const paths = require('../src/paths');
const { createLogger } = require('../src/log');
const { loadConfig } = require('../src/config');
const { createSecretStore } = require('../src/secrets');
const { createStore } = require('../src/store');
const { loadProjects } = require('../src/projects');
const { createApi } = require('../src/feishu/api');
const { createFeishuWs } = require('../src/feishu/ws');
const { parseMessage, parseCardAction, parseChatId } = require('../src/feishu/events');
const { buildLaunch } = require('../src/agent/launcher');
const { createScreen } = require('../src/screen');
const { createQueue } = require('../src/session/queue');
const { createPtySession } = require('../src/session/ptySession');
const { createManager } = require('../src/session/manager');
const { startIpc } = require('../src/ipc');

const DEFAULT_PORT = 47831;
const DEFAULT_SWEEP_MS = 30000;

const errText = (err) => String((err && err.message) || err);

async function createDaemon({ deps = {} } = {}) {
  const pathsApi = deps.pathsApi || paths;
  const logger = deps.logger || createLogger;
  const loadConfigFn = deps.loadConfigFn || loadConfig;
  const secretStoreFactory = deps.secretStoreFactory || createSecretStore;
  const storeFactory = deps.storeFactory || createStore;
  const apiFactory = deps.apiFactory || createApi;
  const ipcFactory = deps.ipcFactory || startIpc;
  const wsFactory = deps.wsFactory || createFeishuWs;
  const managerFactory = deps.managerFactory || createManager;
  const ptySessionFactory = deps.ptySessionFactory || createPtySession;
  const screenFactory = deps.screenFactory || createScreen;
  const queueFactory = deps.queueFactory || createQueue;
  const launchFn = deps.launchFn || buildLaunch;
  const ptyModule = deps.ptyModule || pty;
  const randomToken = deps.randomToken || (() => crypto.randomBytes(16).toString('hex'));

  pathsApi.ensureDirs();
  const log = deps.log || logger({ dir: pathsApi.LOGS });

  const config = loadConfigFn(pathsApi.CONFIG);
  const secretStore = secretStoreFactory({ file: pathsApi.SECRET, log });
  const appSecret = secretStore.load();
  if (!config.appId || !appSecret) throw new Error('缺少飞书凭据：先运行 npm run setup');
  log.redactor?.add(appSecret);

  const getProjectsFn = deps.getProjectsFn
    || (() => loadProjects({ file: pathsApi.PROJECTS, defaultCwd: config.defaultCwd }));

  const store = storeFactory({ file: pathsApi.SESSIONS, log });
  store.load();
  const api = apiFactory({ appId: config.appId, appSecret, fetchImpl: deps.fetchImpl });

  let manager = null;

  function handleClientMessage(msg, ws) {
    const type = msg && msg.type;
    if (type === 'ping') { ipc.send(ws, { type: 'pong' }); return; }
    if (!manager) { ipc.send(ws, { type: 'error', message: '会话管理器未就绪' }); return; }
    if (type === 'list') { ipc.send(ws, { type: 'sessions', list: manager.list() }); return; }
    if (type === 'attach') {
      const found = manager.list().find((s) => s.id === msg.sessionId);
      if (found) ipc.send(ws, { type: 'session', session: found });
      else ipc.send(ws, { type: 'error', message: '会话不存在' });
      return;
    }
    if (type === 'input') { manager.onPcKeys({ sessionId: msg.sessionId, data: msg.data }); return; }
    if (type === 'resize') { manager.onPcResize({ sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows }); return; }
    if (type === 'create') {
      manager.createFromPc({ cwd: msg.cwd, agent: msg.agent })
        .then((record) => ipc.send(ws, { type: 'session', session: record }))
        .catch((err) => ipc.send(ws, { type: 'error', message: errText(err) }));
      return;
    }
    if (type === 'close') {
      manager.closeSession(msg.sessionId, { reason: '窗口关闭', notify: true })
        .catch((err) => log.warn('关闭会话失败', { sessionId: msg.sessionId, message: errText(err) }));
      return;
    }
    ipc.send(ws, { type: 'error', message: `未知的消息类型：${type}` });
  }

  const ipc = await ipcFactory({
    port: config.ipcPort || DEFAULT_PORT,
    token: randomToken(),
    ipcFile: pathsApi.IPC,
    log,
    handlers: {
      onHookStop: ({ sessionId, payload }) => {
        if (!manager) return;
        manager.onHookStop({ sessionId, payload })
          .catch((err) => log.warn('Stop 处理失败', { sessionId, message: errText(err) }));
      },
      onClientMessage: (msg, ws) => handleClientMessage(msg, ws),
    },
  });

  manager = managerFactory({
    config,
    api,
    store,
    log,
    ipc,
    getProjects: getProjectsFn,
    createPtySession: (opts) => ptySessionFactory({
      ...opts,
      launch: (session) => launchFn({
        session,
        config,
        hooksDir: pathsApi.HOOKS,
        hookScript: pathsApi.HOOK_SCRIPT,
        claudeJsonPath: pathsApi.CLAUDE_JSON,
      }),
      ptyFactory: (file, args, o) => ptyModule.spawn(file, args, o),
      screenFactory: ({ cols, rows }) => screenFactory({ cols, rows }),
      queueFactory,
      log,
    }),
  });

  const ws = wsFactory({
    appId: config.appId,
    appSecret,
    log,
    handlers: {
      onMessage: (evt) => {
        const m = parseMessage(evt);
        if (!m) return;                                        // 机器人自己发的，防回环
        if (m.chatType !== 'p2p' && !m.mentioned) return;      // 群里没 @ 就当闲聊
        if (m.unsupported) {
          api.sendText(m.chatId, `暂不支持 ${m.unsupported} 类型的消息，发文字、图片或文件吧。`)
            .catch((err) => log.warn('类型提示发送失败', { chatId: m.chatId, message: errText(err) }));
          return;
        }
        manager.onPhoneMessage({ chatId: m.chatId, text: m.text, media: m.media, senderOpenId: m.openId })
          .catch((err) => log.warn('手机消息处理失败', { chatId: m.chatId, message: errText(err) }));
      },
      onDisbanded: (evt) => {
        const chatId = parseChatId(evt);
        if (!chatId) return;
        manager.onDisbanded({ chatId })
          .catch((err) => log.warn('解散处理失败', { chatId, message: errText(err) }));
      },
      onBotRemoved: (evt) => {
        const chatId = parseChatId(evt);
        if (!chatId) return;
        manager.onBotRemoved({ chatId })
          .catch((err) => log.warn('移出处理失败', { chatId, message: errText(err) }));
      },
      onCardAction: (evt) => {
        const a = parseCardAction(evt);
        if (!a) return;
        manager.onCardAction(a)
          .catch((err) => log.warn('卡片动作处理失败', { chatId: a.chatId, message: errText(err) }));
      },
    },
  });

  let timer = null;
  let started = false;

  async function start() {
    if (started) return;
    started = true;
    await manager.restoreAll();
    await ws.start();
    const sweepMs = config.sweepIntervalMs === undefined ? DEFAULT_SWEEP_MS : config.sweepIntervalMs;
    if (sweepMs > 0) {
      timer = setInterval(() => {
        manager.tick().catch((err) => log.warn('巡检失败', { message: errText(err) }));
      }, sweepMs);
      if (timer.unref) timer.unref();
    }
    log.info('daemon.started', { port: ipc.port, pid: process.pid });
  }

  async function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    try {
      await ws.close();
    } catch (err) {
      log.warn('关闭长连接失败', { message: errText(err) });
    }
    await manager.shutdown();
    await ipc.close();
    log.info('daemon.stopped', {});
  }

  return { port: ipc.port, config, ipc, ws, manager, log, start, stop };
}

async function probeRunning({ ipcFile, fsApi, fetchImpl }) {
  try {
    if (!fsApi.existsSync(ipcFile)) return null;
    const info = JSON.parse(fsApi.readFileSync(ipcFile, 'utf8'));
    if (!info || !info.port) return null;
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? info : null;
  } catch {
    return null;
  }
}

async function main({ deps = {} } = {}) {
  const fsApi = deps.fsApi || fs;
  const pathsApi = deps.pathsApi || paths;
  const logger = deps.logger || createLogger;
  const fetchImpl = deps.fetchImpl || fetch;

  pathsApi.ensureDirs();
  const log = deps.log || logger({ dir: pathsApi.LOGS });

  const running = await probeRunning({ ipcFile: pathsApi.IPC, fsApi, fetchImpl });
  if (running) {
    log.info('daemon.already_running', { pid: running.pid, port: running.port });
    return { started: false, pid: running.pid, port: running.port };
  }
  try {
    if (fsApi.existsSync(pathsApi.IPC)) fsApi.unlinkSync(pathsApi.IPC);
  } catch {
    // 陈旧 ipc.json 删不掉不阻断启动
  }

  const daemon = await createDaemon({ deps: { ...deps, log } });
  await daemon.start();

  if (deps.attachSignals !== false) {
    let stopping = false;
    const onSignal = (signal) => {
      if (stopping) return;
      stopping = true;
      log.info('daemon.signal', { signal });
      daemon.stop()
        .catch((err) => log.warn('退出清理失败', { message: errText(err) }))
        .then(() => process.exit(0));
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  }

  return { started: true, port: daemon.port, daemon };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`飞书桥启动失败：${(err && err.message) || err}`);
    process.exit(1);
  });
}

module.exports = { createDaemon, probeRunning, main, DEFAULT_PORT };
```

**3b. 同步 §2 契约**，改两行，避免后续任务照着旧签名写：

```js
buildLaunch({ session, config, hooksDir, hookScript, claudeJsonPath }) -> { file, args, cwd }
```

```js
createPtySession({ session, launch, ptyFactory, screenFactory, queueFactory, log, onEvent, now, queueLimit })
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/daemon.test.js`
预期：`# pass 10`，`# fail 0`

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add bin/daemon.js test/daemon.test.js docs/superpowers/plans/2026-11-23-feishu-agent-bridge.md
git commit -m "feat: 守护进程装配（单实例、长连接、IPC、PTY 工厂）"
```

---

### 任务 26：离线端到端冒烟 + 真机验收清单

**文件：**
- 创建：`test/fixtures/fake-agent.js`
- 创建：`test/e2e.test.js`
- 创建：`scripts/check-logs.js`
- 创建：`test/check-logs.test.js`
- 创建：`docs/acceptance.md`
- 修改：`package.json`（加 `test:e2e`、`check:logs` 两个脚本）

规格 §12 的 1–11 条大多要真手机 + 真凭据，没法写进自动测试。所以这里分两层：

1. **能自动化的先自动化**——用真的 `node-pty` + ConPTY 起一个假 agent，验证「启动 → 就绪 → 写入 → 回显 → 串行排队 → 退出」整条终端链路（不碰飞书）。
2. **不能自动化的写成清单**——`docs/acceptance.md` 逐条对应 §12，标清哪条 Plan A（无窗口）就能验、哪条必须等 Plan B，并给出判定标准和日志检查脚本。

- [ ] **步骤 1：编写失败的测试**

```js
// test/e2e.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const pty = require('node-pty');
const { createPtySession } = require('../src/session/ptySession');
const { createScreen } = require('../src/screen');
const { createQueue } = require('../src/session/queue');

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, step = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}

function makeSession(onEvent) {
  const session = {
    id: 'e2e', chatId: 'oc_e2e', agent: 'fake', cwd: process.cwd(),
    status: 'idle', inputSeq: 0, lastInput: null,
  };
  return createPtySession({
    session,
    launch: () => ({ file: process.execPath, args: [FAKE_AGENT], cwd: process.cwd() }),
    ptyFactory: (file, args, opts) => pty.spawn(file, args, opts),
    screenFactory: createScreen,
    queueFactory: createQueue,
    onEvent,
  });
}

test('真实 ConPTY：就绪 → 写入 → 回显 → 连发两条按序执行', async () => {
  const events = [];
  const ps = makeSession((e) => events.push(e));
  try {
    ps.start();
    assert.ok(
      await waitFor(() => ps.status === 'idle'),
      `10 秒内未就绪；最后事件：${JSON.stringify(events.slice(-3))}`,
    );
    assert.ok(ps.screen.snapshot().includes('FAKE_AGENT_READY'));

    assert.strictEqual(ps.submitText('ping-1', 'phone'), 'queued');
    // 第二条应排队（第一条还在跑），不能立刻写进终端
    assert.strictEqual(ps.submitText('ping-2', 'phone'), 'queued');
    assert.ok(await waitFor(() => ps.screen.snapshot().includes('ECHO:ping-1')));

    ps.releaseTurn();
    assert.ok(await waitFor(() => ps.screen.snapshot().includes('ECHO:ping-2')));
    const text = ps.screen.snapshot();
    assert.ok(text.indexOf('ECHO:ping-1') < text.indexOf('ECHO:ping-2'), '输出顺序被打乱');
  } finally {
    try { ps.kill(); } catch { /* 已退出 */ }
  }
});

test('agent 自己退出：状态转 closed 并发出 exit 事件', async () => {
  const events = [];
  const ps = makeSession((e) => events.push(e));
  try {
    ps.start();
    assert.ok(await waitFor(() => ps.status === 'idle'));
    ps.submitText('/exit', 'phone');
    assert.ok(await waitFor(() => ps.status === 'closed'));
    assert.ok(events.some((e) => e.type === 'exit'), '没有 exit 事件');
  } finally {
    try { ps.kill(); } catch { /* 已退出 */ }
  }
});
```

```js
// test/check-logs.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../scripts/check-logs');

test('scan：命中机密时返回文件路径，干净目录与不存在的目录返回空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-logs-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.log'), 'hello\nsec_123456\n');
    fs.writeFileSync(path.join(dir, 'clean.log'), 'nothing here\n');

    assert.deepStrictEqual(scan(dir, ['sec_123456']), [path.join(dir, 'a.log')]);
    assert.deepStrictEqual(scan(dir, ['not-here-at-all']), []);
    assert.deepStrictEqual(scan(path.join(dir, 'nope'), ['sec_123456']), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/check-logs.test.js test/e2e.test.js`
预期：FAIL，`Cannot find module '../scripts/check-logs'`；e2e 报找不到 `test/fixtures/fake-agent.js`

- [ ] **步骤 3：编写实现**

**3a. 假 agent**（只有提示符 + 回显，`/exit` 退出）：

```js
// test/fixtures/fake-agent.js —— 验收测试用的假 agent：一个提示符，收到一行就回显一行。
process.stdout.write('FAKE_AGENT_READY\r\n');
process.stdout.write('❯ ');

const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '/exit') {
    process.stdout.write('\r\nBYE\r\n');
    process.exit(0);
  }
  process.stdout.write(`\r\nECHO:${text}\r\n❯ `);
});
rl.on('close', () => process.exit(0));
```

**3b. 日志脱敏检查脚本：**

```js
// scripts/check-logs.js —— 验收第 11 条：日志里不许出现 App Secret / API token。
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../src/paths');
const { createSecretStore } = require('../src/secrets');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// needles 里太短的串（<8 字符）不参与匹配，避免空串/常见词造成假阳性
function scan(dir, needles) {
  const list = (needles || []).filter((n) => typeof n === 'string' && n.length >= 8);
  if (list.length === 0) return [];
  const hits = [];
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    if (list.some((n) => text.includes(n))) hits.push(file);
  }
  return hits;
}

function main() {
  const needles = [];
  try {
    const secret = createSecretStore({ file: paths.SECRET }).load();
    if (secret) needles.push(secret);
  } catch {
    // 还没配凭据时跳过这一项
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) needles.push(process.env.ANTHROPIC_AUTH_TOKEN);

  const hits = scan(paths.LOGS, needles);
  if (hits.length > 0) {
    console.log(`失败：以下日志含机密\n${hits.join('\n')}`);
    process.exit(1);
  }
  console.log(`OK：扫描 ${walk(paths.LOGS).length} 个日志文件，未发现机密`);
}

module.exports = { scan };

if (require.main === module) main();
```

**3c. 真机验收清单**（新建 `docs/acceptance.md`，内容如下）：

```markdown
# 飞书桥验收清单

> 对应规格 §12。每条有 `- [ ]` 的地方验收通过后打勾，并在「实测」里写数据。
> **🅐 = Plan A（守护进程 + 手机）就能验；🅑 = 必须等 Plan B 的 Electron 窗口。**
> 所有耗时从「飞书显示已发送」开始计。

## 前置检查

| 项 | 命令 | 期望 |
|---|---|---|
| 单元测试 | `cd /d/feishu-bridge && npm test` | 全绿 |
| 离线端到端 | `npm run test:e2e` | `# pass 2` |
| 凭据 | `npm start` | 日志出现 `daemon.started`，不出现「缺少飞书凭据」 |
| 单实例 | 另开终端再 `npm start` | 打印 `daemon.already_running` 后退出 |
| Claude | `claude --version` | 正常输出 |
| Codex | `codex --version` | 正常输出（第 10 条才需要） |

## 逐条验收

### 1. 🅐🅑 手机拉群 @机器人「卡牌 你好」→ 收到回复

1. 手机飞书建群 → 拉机器人进群 → `@机器人 卡牌 你好`。
2. 🅐 记录：首条回复卡片出现的时间。
3. 🅑 记录：Electron 窗口出现时间（≤3 秒）、窗口首屏 `❯` 出现时间（≤8 秒）。

- [ ] 🅐 群里收到 claude 的回复（不是报错卡片）
- [ ] 🅑 窗口 ≤3 秒弹出、首屏 ≤8 秒
- 实测：🅐 ____ 秒 / 🅑 窗口 ____ 秒、首屏 ____ 秒

### 2. 🅐🅑 连续两条不粘连

1. 发「列出这个目录的文件」。
2. 1 秒内再发「只列文件名」。
3. 判定：第二条没被吞、没和第一条粘成一行；输出按顺序。

- [ ] 🅐 两条都执行，顺序正确
- [ ] 🅑 窗口里能看到两句输入和两段回答
- 实测：____

### 3. 🅑 电脑窗口敲字 → 手机收到

1. 在电脑的会话窗口里输入「现在几点」并回车。
2. 判定：群里收到这句输入 + 回答（`pc-input` 卡片）。

- [ ] 🅑 群里出现电脑侧输入和回答

### 4. 🅑 多窗口并行

1. 双击桌面图标 3 次。
2. 三个窗口分别选不同目录，各发一个任务。
3. 判定：3 个窗口 + 3 个群，互不串话。

- [ ] 🅑 3 窗口 / 3 群 / 3 目录同时运行
- 备注：Plan A 阶段可先用手机建 3 个群替代验证「多会话并行」

### 5. 🅑 关窗口 → 该群收到「会话已结束」

1. 关掉其中一个窗口。
2. 判定：对应群收到结束卡片；另外两个窗口和群不受影响。

- [ ] 🅑 只有被关的那个群收到结束通知

### 6. 🅐🅑 解散群 → 会话自己收尾

1. 在飞书里解散一个群。
2. 🅐 判定：`state/sessions.json` 里该记录消失，日志出现 `session.disbanded`。
3. 🅑 判定：对应窗口自己关掉。

- [ ] 🅐 记录被清理、PTY 已结束
- [ ] 🅑 窗口自动关闭

### 7. 🅐🅑 首句别名 / 默认目录

1. 新群第一句：「草稿 帮我查一下 xxx」。
2. 🅐 判定：`sessions.json` 里该会话 `cwd` = `D:/feishu-workspace`（或配置的 defaultCwd）、`alias` = `草稿`。
3. 🅑 判定：窗口标题是「草稿 · …」。

- [ ] 🅐 落默认目录，别名正确
- [ ] 🅑 窗口标题正确

### 8. 🅐🅑 杀掉 claude → 异常提示 + 重来

1. 任务管理器结束该 `claude.exe` 进程。
2. 🅐 判定：群里收到异常卡片（含原因）。
3. 🅑 判定：窗口出现「重来」按钮，点击后能继续对话。

- [ ] 🅐 群里收到异常提示
- [ ] 🅑 「重来」可用

### 9. 🅐 重启电脑 → 自动恢复

1. 先确认任务 27 的计划任务已安装（`schtasks /Query /TN FeishuBridge.Daemon`）。
2. 重启电脑，登录后等 30 秒。
3. 往旧群发一句话。
4. 判定：自动 `--resume` 接回之前的对话（日志有 `session.resumed`）。

- [ ] 🅐 daemon 自启、旧群能接上
- 实测：重启后 ____ 秒可用

### 10. 🅐🅑 Codex 全链路

1. 新群第一句：「临时草稿 用 codex 写个快排」。
2. 🅐 判定：群里持续收到 codex 的终端画面文本。
3. 🅑 判定：窗口里是 codex TUI。

- [ ] 🅐 codex 正常启动并向群里输出
- [ ] 🅑 窗口显示 codex TUI

### 11. 🅐 日志无机密

```bash
cd /d/feishu-bridge
npm run check:logs
```

- [ ] 🅐 输出 `OK：扫描 … 个日志文件，未发现机密`
- 备注：本项目不接 pushplus，该项只查 App Secret 与 `ANTHROPIC_AUTH_TOKEN`。

## 验收结论

- Plan A 通过条数：____ / 11（🅐 部分）
- Plan B 通过条数：____ / 11（🅑 部分）
- 遗留问题：____
```

**3d. 加脚本入口**（`package.json`）：

```json
  "scripts": {
    "start": "node bin/daemon.js",
    "test": "node --test",
    "test:e2e": "node --test test/e2e.test.js",
    "check:logs": "node scripts/check-logs.js"
  },
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/check-logs.test.js test/e2e.test.js`
预期：`# pass 3`（check-logs 1 + e2e 2）

再运行全量：`npm test`
预期：全绿，无 fail。

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add package.json test/fixtures/fake-agent.js test/e2e.test.js test/check-logs.test.js scripts/check-logs.js docs/acceptance.md docs/superpowers/plans/2026-11-23-feishu-agent-bridge.md
git commit -m "test: 离线端到端冒烟与真机验收清单"
```

---

### 任务 27：开机自启（任务计划程序）

**文件：**
- 创建：`scripts/autostart.js`
- 创建：`test/autostart.test.js`
- 修改：`package.json`（加 `autostart` 脚本）
- 修改：`docs/acceptance.md`（第 9 条补上安装命令）

规格 §9 要求「登录自启、隐藏、崩溃 60s 重启」。做法：

- 用 `schtasks /Create /XML` 建任务 `FeishuBridge.Daemon`（`/XML` 才能设 `ExecutionTimeLimit=PT0S`，否则任务计划默认 72 小时会把常驻进程杀掉；已实测：非管理员可建、可删，XML UTF-16LE + BOM 可导入）。
- 任务动作是 `wscript.exe "<ROOT>\state\daemon-hidden.vbs"`——`wscript` 跑 VBS 没有控制台窗口。
- VBS 等 15 秒（登录后网络/磁盘就绪）→ 启动 `state\daemon.cmd`（`cd` 到工程根，node 输出重定向到 `logs\daemon.out.log`）→ 若退出码非 0 则等 60 秒重试；退出码为 0（含「已有实例在跑」的正常退出）就不重试。
- 计划任务对当前用户 SID 生效，`RunLevel=LeastPrivilege`，不需要管理员密码、不存密码。

- [ ] **步骤 1：编写失败的测试**

```js
// test/autostart.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TASK, buildCmd, buildVbs, install, uninstall, status } = require('../scripts/autostart');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-autostart-'));
}

test('buildCmd/buildVbs：路径正确、崩溃 60 秒后重试、正常退出不复跑', () => {
  const cmd = buildCmd({
    root: 'D:\\feishu-bridge',
    execPath: 'C:\\node\\node.exe',
    logPath: 'D:\\feishu-bridge\\logs\\daemon.out.log',
  });
  assert.ok(cmd.includes('cd /d "D:\\feishu-bridge"'));
  assert.ok(cmd.includes('"C:\\node\\node.exe" "D:\\feishu-bridge\\bin\\daemon.js" >> "D:\\feishu-bridge\\logs\\daemon.out.log" 2>&1'));

  const vbs = buildVbs({ root: 'D:\\feishu-bridge', cmdPath: 'D:\\feishu-bridge\\state\\daemon.cmd' });
  assert.ok(vbs.includes('WScript.Sleep 15000'));
  assert.ok(vbs.includes('If rc = 0 Then Exit Do'));
  assert.ok(vbs.includes('WScript.Sleep 60000'));
  assert.ok(vbs.includes('D:\\feishu-bridge\\state\\daemon.cmd'));
});

test('install：写三个文件，用 XML 创建登录自启任务', () => {
  const dir = tmpDir();
  try {
    const calls = [];
    const run = (file, args) => { calls.push([file, args]); return ''; };
    install({
      root: 'D:\\feishu-bridge',
      execPath: 'C:\\node\\node.exe',
      stateDir: dir,
      logPath: 'D:\\feishu-bridge\\logs\\daemon.out.log',
      sid: 'S-1-5-21-1',
      run,
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'schtasks');
    assert.deepStrictEqual(calls[0][1], [
      '/Create', '/TN', TASK, '/XML', path.join(dir, 'task.xml'), '/F',
    ]);

    const raw = fs.readFileSync(path.join(dir, 'task.xml'));
    assert.deepStrictEqual([...raw.subarray(0, 2)], [0xff, 0xfe], 'XML 必须是带 BOM 的 UTF-16LE');
    const xml = raw.subarray(2).toString('utf16le');
    assert.ok(xml.includes('<UserId>S-1-5-21-1</UserId>'));
    assert.ok(xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'));
    assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
    assert.ok(xml.includes(path.join(dir, 'daemon-hidden.vbs')));

    assert.ok(fs.existsSync(path.join(dir, 'daemon.cmd')));
    assert.ok(fs.readFileSync(path.join(dir, 'daemon-hidden.vbs'), 'utf8').includes(path.join(dir, 'daemon.cmd')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstall：End + Delete 并清理文件；status 依据 Query 成败', () => {
  const dir = tmpDir();
  try {
    install({
      root: 'D:\\feishu-bridge',
      execPath: 'C:\\node\\node.exe',
      stateDir: dir,
      logPath: 'D:\\feishu-bridge\\logs\\daemon.out.log',
      sid: 'S-1-5-21-1',
      run: () => '',
    });

    const calls = [];
    const run = (file, args) => {
      calls.push([file, args]);
      if (args[0] === '/Query') throw new Error('not found');
      return '';
    };
    uninstall({ stateDir: dir, run });

    assert.deepStrictEqual(calls.slice(0, 2), [
      ['schtasks', ['/End', '/TN', TASK]],
      ['schtasks', ['/Delete', '/TN', TASK, '/F']],
    ]);
    assert.ok(!fs.existsSync(path.join(dir, 'task.xml')), 'task.xml 未清理');
    assert.ok(!fs.existsSync(path.join(dir, 'daemon.cmd')), 'daemon.cmd 未清理');
    assert.ok(!fs.existsSync(path.join(dir, 'daemon-hidden.vbs')), 'daemon-hidden.vbs 未清理');

    assert.strictEqual(status({ run }), false);
    assert.strictEqual(status({ run: () => '' }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/autostart.test.js`
预期：FAIL，`Cannot find module '../scripts/autostart'`

- [ ] **步骤 3：编写实现**

```js
// scripts/autostart.js —— 开机自启管理（Windows 任务计划程序）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../src/paths');

const TASK = 'FeishuBridge.Daemon';
const WAKE_DELAY_MS = 15000; // 登录后等网络/磁盘就绪
const RETRY_DELAY_MS = 60000; // 异常退出后 60 秒重启

function defaultRun(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true }).trim();
}

function currentSid(run) {
  const out = run('C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const m = /S-1-5-[\d-]+/.exec(out);
  if (!m) throw new Error(`无法读取当前用户 SID：${out}`);
  return m[0];
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCmd({ root, execPath, logPath }) {
  return [
    '@echo off',
    `cd /d "${root}"`,
    `"${execPath}" "${path.join(root, 'bin', 'daemon.js')}" >> "${logPath}" 2>&1`,
    '',
  ].join('\r\n');
}

function buildVbs({ root, cmdPath }) {
  return [
    "' 由 scripts/autostart.js 生成，请勿手改。",
    'Option Explicit',
    'Dim sh, rc',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${root}"`,
    `WScript.Sleep ${WAKE_DELAY_MS}`,
    'Do',
    `  rc = sh.Run(Chr(34) & "${cmdPath}" & Chr(34), 0, True)`,
    '  If rc = 0 Then Exit Do',
    `  WScript.Sleep ${RETRY_DELAY_MS}`,
    'Loop',
    '',
  ].join('\r\n');
}

function buildXml({ sid, vbsPath }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>飞书桥守护进程（登录自启；异常退出后 60 秒重启）</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(sid)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${escapeXml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function writeUtf16(file, text) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

function install({
  root = paths.ROOT,
  execPath = process.execPath,
  stateDir = paths.STATE,
  logPath = path.join(paths.LOGS, 'daemon.out.log'),
  run = defaultRun,
  sid = null,
  dryRun = false,
} = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const cmdPath = path.join(stateDir, 'daemon.cmd');
  const vbsPath = path.join(stateDir, 'daemon-hidden.vbs');
  const xmlPath = path.join(stateDir, 'task.xml');

  const realSid = sid || currentSid(run);
  const cmd = buildCmd({ root, execPath, logPath });
  const vbs = buildVbs({ root, cmdPath });
  const xml = buildXml({ sid: realSid, vbsPath });

  const result = { task: TASK, cmdPath, vbsPath, xmlPath, dryRun };
  if (dryRun) return { ...result, cmd, vbs, xml };

  fs.writeFileSync(cmdPath, cmd);
  fs.writeFileSync(vbsPath, vbs);
  writeUtf16(xmlPath, xml);
  run('schtasks', ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']);
  return result;
}

function uninstall({ stateDir = paths.STATE, run = defaultRun } = {}) {
  try { run('schtasks', ['/End', '/TN', TASK]); } catch { /* 任务没在运行 */ }
  try { run('schtasks', ['/Delete', '/TN', TASK, '/F']); } catch { /* 本来就没装 */ }
  for (const name of ['daemon.cmd', 'daemon-hidden.vbs', 'task.xml']) {
    fs.rmSync(path.join(stateDir, name), { force: true });
  }
  return { task: TASK };
}

function status({ run = defaultRun } = {}) {
  try {
    run('schtasks', ['/Query', '/TN', TASK]);
    return true;
  } catch {
    return false;
  }
}

function main(argv = process.argv.slice(2)) {
  const action = argv[0] || 'status';
  const dryRun = argv.includes('--dry-run');

  if (action === 'install') {
    const r = install({ dryRun });
    if (r.dryRun) {
      console.log('将要写入：');
      console.log(`  ${r.cmdPath}`);
      console.log(`  ${r.vbsPath}`);
      console.log(`  ${r.xmlPath}`);
      console.log(`并创建计划任务 ${TASK}（登录自启、隐藏窗口、异常退出 60 秒重启）`);
      return;
    }
    console.log(`已安装计划任务 ${TASK}：下次登录后自动启动`);
    return;
  }

  if (action === 'uninstall') {
    uninstall();
    console.log(`已取消开机自启（计划任务 ${TASK} 已删除）`);
    return;
  }

  if (action === 'status') {
    console.log(status() ? `已安装：${TASK}` : `未安装：${TASK}`);
    return;
  }

  console.error('用法：node scripts/autostart.js install|uninstall|status [--dry-run]');
  process.exit(2);
}

module.exports = { TASK, buildCmd, buildVbs, buildXml, install, uninstall, status, main };

if (require.main === module) main();
```

**3a. 加脚本入口**（`package.json` 的 `scripts` 里追加一行）：

```json
    "autostart": "node scripts/autostart.js",
```

**3b. 验收清单第 9 条补安装命令**（`docs/acceptance.md`，把第 9 条的「先确认…」改成）：

```markdown
1. 配好凭据、确认 `npm start` 能正常跑之后，安装自启：`npm run autostart -- install`
2. 确认：`npm run autostart -- status` 输出 `已安装：FeishuBridge.Daemon`
3. 重启电脑，登录后等 30 秒，往旧群发一句话。
4. 判定：自动 `--resume` 接回之前的对话（日志有 `session.resumed`）。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd /d/feishu-bridge && node --test test/autostart.test.js`
预期：`# pass 3`

再跑一次 dry-run（不写任何东西、不建任务）：
`node scripts/autostart.js install --dry-run`
预期：打印三个将写入的文件路径 + 一句「并创建计划任务 FeishuBridge.Daemon」，`state/` 下不新增文件，`schtasks /Query /TN FeishuBridge.Daemon` 仍报找不到任务。

**这里先不真正安装**：凭据还没填，装了以后每次登录都会拉一个起不来的 daemon 并每 60 秒重试刷日志。真机安装在验收第 9 条时做。

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add package.json scripts/autostart.js test/autostart.test.js docs/acceptance.md docs/superpowers/plans/2026-11-23-feishu-agent-bridge.md
git commit -m "feat: 开机自启（登录自启、隐藏窗口、异常退出 60 秒重启）"
```

---

### 任务 28：私聊总控面板（会话列表 / 结束会话 / 改别名）

**文件：**
- 创建：`src/control.js`
- 创建：`test/control.test.js`
- 修改：`src/projects.js`（加 `renameAlias`）
- 修改：`test/projects.test.js`（加 2 个用例）
- 修改：`bin/daemon.js`（私聊改走 control、卡片动作分流、加 `onBotAdded`）
- 修改：`test/daemon.test.js`（改 1 个用例、加 2 个用例、装配断言补 2 行）
- 修改：`docs/acceptance.md`（加验收第 12 条）

规格 §10.1 写着「单聊 = 总控面板（看会话列表、结束某个会话、改别名）」，§7 写着「手机端也能通过一张设置卡片改（列出全部别名，点一行改名）」，§9 写着「别人拉机器人进群 → 忽略」。前面的任务把这三件事都漏了，这个任务补上。

设计取舍：飞书表单卡片（`form` + `input` + `form_submit`）的 schema 在 2.0 下没有稳定文档，所以**不用表单**——面板底部每行别名一个按钮（`{act:'alias-rename', from:'卡牌'}`），点完机器人问一句「改成什么？」，用户下一条文字就是新名字。一次点击 + 一次回复，手机上不输命令也能改。

`src/control.js` 只做「读状态 + 发消息」：不建会话、不碰 PTY、不认识 manager，全部依赖由 daemon 注入，所以能纯用假件测试。

- [ ] **步骤 1：编写失败的测试**

**1a. 新建 `test/control.test.js`：**

```js
// test/control.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseControl, formatSessions, createControl } = require('../src/control');

function harness({ sessions = [], aliases = { 卡牌: 'D:/card' }, rename } = {}) {
  const calls = [];
  const renames = [];
  const api = {
    sendText: async (chatId, text) => { calls.push(['text', chatId, text]); },
    sendCard: async (chatId, card) => { calls.push(['card', chatId, card]); },
  };
  const control = createControl({
    api,
    listSessions: () => sessions,
    closeSession: async (id, opts) => { calls.push(['close', id, opts]); },
    getProjects: () => ({ aliases, default: 'D:/w' }),
    renameAlias: (args) => { renames.push(args); return rename ? rename(args) : { ok: true }; },
    ownerOpenId: 'ou_me',
  });
  return { control, calls, renames };
}

test('parseControl：列表 / 结束 / 改名 / 帮助 / 未知', () => {
  assert.deepStrictEqual(parseControl('列表'), { act: 'list' });
  assert.deepStrictEqual(parseControl('  面板 '), { act: 'list' });
  assert.deepStrictEqual(parseControl('结束 卡牌'), { act: 'end', target: '卡牌' });
  assert.deepStrictEqual(parseControl('关掉 D:/card'), { act: 'end', target: 'D:/card' });
  assert.deepStrictEqual(parseControl('改名 卡牌 卡牌2'), {
    act: 'rename', from: '卡牌', to: '卡牌2',
  });
  assert.deepStrictEqual(parseControl('帮助'), { act: 'help' });
  assert.deepStrictEqual(parseControl('随便说点啥'), { act: 'help' });
  assert.deepStrictEqual(parseControl(''), { act: 'help' });
});

test('formatSessions：空列表与非空列表', () => {
  assert.match(formatSessions([]), /没有会话/);
  const text = formatSessions([
    { id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'running' },
    { id: 's2', alias: null, cwd: 'D:/tmp', agent: 'codex', status: 'idle' },
  ]);
  assert.match(text, /1\. 卡牌（D:\/card） · Claude · 运行中/);
  assert.match(text, /2\. D:\/tmp · Codex · 空闲/);
});

test('非主人：私聊消息和卡片都静默忽略', async () => {
  const { control, calls } = harness();
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_other' });
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_other', action: { act: 'alias-rename', from: '卡牌' },
  });
  assert.deepStrictEqual(calls, []);
});

test('列表：发总控面板卡片，含会话状态和别名按钮', async () => {
  const { control, calls } = harness({
    sessions: [{ id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'running' }],
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'card');
  const card = calls[0][2];
  const json = JSON.stringify(card);
  assert.ok(json.includes('卡牌'));
  assert.ok(json.includes('运行中'));
  const btn = card.body.elements.find((e) => e.tag === 'button');
  assert.deepStrictEqual(btn.behaviors[0].value, { act: 'alias-rename', from: '卡牌' });
});

test('结束：按别名或 id 找到会话并关闭，找不到就提示', async () => {
  const { control, calls } = harness({
    sessions: [
      { id: 's1', alias: '卡牌', cwd: 'D:/card', agent: 'claude', status: 'idle' },
      { id: 's2', alias: null, cwd: 'D:/x', agent: 'claude', status: 'idle' },
    ],
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '结束 卡牌', senderOpenId: 'ou_me' });
  await control.onMessage({ chatId: 'oc_p2p', text: '结束 s2', senderOpenId: 'ou_me' });

  const closes = calls.filter((c) => c[0] === 'close');
  assert.deepStrictEqual(closes[0], ['close', 's1', { reason: '手机总控面板关闭', notify: true }]);
  assert.deepStrictEqual(closes[1], ['close', 's2', { reason: '手机总控面板关闭', notify: true }]);

  await control.onMessage({ chatId: 'oc_p2p', text: '结束 不存在', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.at(-1)[0], 'text');
  assert.match(calls.at(-1)[2], /没找到/);
});

test('直接改名：成功与失败都回话', async () => {
  const ok = harness();
  await ok.control.onMessage({ chatId: 'oc_p2p', text: '改名 卡牌 卡牌2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(ok.renames, [{ from: '卡牌', to: '卡牌2' }]);
  assert.match(ok.calls.at(-1)[2], /已把「卡牌」改成「卡牌2」/);

  const bad = harness({ rename: () => ({ ok: false, message: '别名「卡牌」不存在。' }) });
  await bad.control.onMessage({ chatId: 'oc_p2p', text: '改名 卡牌 卡牌2', senderOpenId: 'ou_me' });
  assert.match(bad.calls.at(-1)[2], /不存在/);
});

test('点按钮改名：先问新名字，下一条文字当成新名字', async () => {
  const { control, calls, renames } = harness();
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' },
  });
  assert.match(calls.at(-1)[2], /改成什么/);

  await control.onMessage({ chatId: 'oc_p2p', text: '卡牌2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(renames, [{ from: '卡牌', to: '卡牌2' }]);
  assert.match(calls.at(-1)[2], /已把/);

  // 待定状态用完即清：再随口说一句不会被当成改名
  const before = renames.length;
  await control.onMessage({ chatId: 'oc_p2p', text: '卡牌3', senderOpenId: 'ou_me' });
  assert.strictEqual(renames.length, before);
  assert.match(calls.at(-1)[2], /总控面板/);
});

test('点按钮改名：新名字带空格被拒绝，且不改名', async () => {
  const { control, calls, renames } = harness();
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' },
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '卡牌 2', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(renames, []);
  assert.match(calls.at(-1)[2], /不能带空格/);
});

test('待定改名状态下发命令：按命令处理，不当成新名字', async () => {
  const { control, calls, renames } = harness();
  await control.onCardAction({
    chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' },
  });
  await control.onMessage({ chatId: 'oc_p2p', text: '列表', senderOpenId: 'ou_me' });
  assert.deepStrictEqual(renames, []);
  assert.strictEqual(calls.at(-1)[0], 'card');
});

test('被拉进群：只对主人自我介绍，别人拉的不管', async () => {
  const { control, calls } = harness();
  await control.onBotAdded({ chatId: 'oc_g', openId: 'ou_stranger' });
  assert.deepStrictEqual(calls, []);

  await control.onBotAdded({ chatId: 'oc_g', openId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'card');
  assert.ok(JSON.stringify(calls[0][2]).includes('@我'));
});

test('私聊随口说话：只回帮助，不建会话', async () => {
  const { control, calls } = harness();
  await control.onMessage({ chatId: 'oc_p2p', text: '今天天气不错', senderOpenId: 'ou_me' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'text');
  assert.match(calls[0][2], /总控面板/);
});
```

**1b. 修改 `test/projects.test.js`**：顶部引用加 `renameAlias`。

旧：

```js
const { loadProjects } = require('../src/projects');
```

新：

```js
const { loadProjects, renameAlias } = require('../src/projects');
```

文件末尾追加两个用例（`tmpDir()` 已在文件里定义过，直接用）：

```js
test('renameAlias：改别名，保留 default 与 recent', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({
    aliases: { 卡牌: 'D:/card', 桥: 'D:/feishu-bridge' },
    default: 'D:/w',
    recent: [{ path: 'D:/x' }],
  }));

  const r = renameAlias({ file, from: '卡牌', to: '卡牌2' });
  assert.strictEqual(r.ok, true);

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(doc.aliases, { 卡牌2: 'D:/card', 桥: 'D:/feishu-bridge' });
  assert.strictEqual(doc.default, 'D:/w');
  assert.deepStrictEqual(doc.recent, [{ path: 'D:/x' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameAlias：不存在 / 重名 / 带空格都拒绝且不改文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'projects.json');
  const original = JSON.stringify({ aliases: { 卡牌: 'D:/card', 桥: 'D:/b' } });
  fs.writeFileSync(file, original);

  assert.strictEqual(renameAlias({ file, from: '没有', to: 'x' }).ok, false);
  assert.strictEqual(renameAlias({ file, from: '卡牌', to: '桥' }).ok, false);
  assert.strictEqual(renameAlias({ file, from: '卡牌', to: '新 名' }).ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

**1c. 修改 `test/daemon.test.js`**：

① `makeDeps` 的 `calls` 加两个槽位。

旧：

```js
  const calls = {
    sent: [], text: [], manager: [], order: [],
    dirs: 0, storeLoaded: 0, redacted: null,
    managerOpts: null, ipcOpts: null, wsOpts: null,
    apiOpts: null, launchOpts: null, spawnArgs: null,
  };
```

新：

```js
  const calls = {
    sent: [], text: [], manager: [], control: [], order: [],
    dirs: 0, storeLoaded: 0, redacted: null,
    managerOpts: null, controlOpts: null, ipcOpts: null, wsOpts: null,
    apiOpts: null, launchOpts: null, spawnArgs: null,
  };
```

② 假 `control` 对象与 `controlFactory`。

旧：

```js
  const api = {
    sendText: async (chatId, text) => { calls.text.push([chatId, text]); },
  };
  const deps = {
```

新：

```js
  const api = {
    sendText: async (chatId, text) => { calls.text.push([chatId, text]); },
  };
  const control = {
    onMessage: async (a) => { calls.control.push(['onMessage', a]); },
    onCardAction: async (a) => { calls.control.push(['onCardAction', a]); },
    onBotAdded: async (a) => { calls.control.push(['onBotAdded', a]); },
  };
  const deps = {
```

③ `deps` 里 `managerFactory` 那行下面加 `controlFactory`。

旧：

```js
    managerFactory: (o) => { calls.managerOpts = o; return manager; },
```

新：

```js
    managerFactory: (o) => { calls.managerOpts = o; return manager; },
    controlFactory: (o) => { calls.controlOpts = o; return control; },
```

④ 「装配」用例补两行断言。

旧：

```js
  assert.strictEqual(calls.managerOpts.getProjects().aliases['卡牌'], 'D:/card');
  assert.strictEqual(daemon.port, 51000);
```

新：

```js
  assert.strictEqual(calls.managerOpts.getProjects().aliases['卡牌'], 'D:/card');
  assert.strictEqual(calls.controlOpts.ownerOpenId, CONFIG.ownerOpenId);
  assert.strictEqual(calls.controlOpts.getProjects().aliases['卡牌'], 'D:/card');
  assert.strictEqual(daemon.port, 51000);
```

⑤ 把 p2p 用例整段换掉。

旧：

```js
test('手机文本：p2p 直接转发，群聊必须 @，占位符被剥掉', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });
  const onMessage = calls.wsOpts.handlers.onMessage;

  onMessage(evt());
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onPhoneMessage',
    { chatId: 'oc_1', text: '你好', media: null, senderOpenId: 'ou_me' },
  ]);

  const before = calls.manager.length;
  onMessage(evt({ chat_type: 'group', content: '{"text":"@_user_1 你好"}' }));
  assert.strictEqual(calls.manager.length, before);

  onMessage(evt({
    chat_type: 'group',
    content: '{"text":"@_user_1 开工"}',
    mentions: [{ key: '@_user_1' }],
  }));
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onPhoneMessage',
    { chatId: 'oc_1', text: '开工', media: null, senderOpenId: 'ou_me' },
  ]);
});
```

新：

```js
test('手机文本：私聊进总控面板，群聊必须 @，占位符被剥掉', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });
  const onMessage = calls.wsOpts.handlers.onMessage;

  onMessage(evt());
  assert.deepStrictEqual(calls.control.at(-1), [
    'onMessage',
    { chatId: 'oc_1', text: '你好', senderOpenId: 'ou_me' },
  ]);
  assert.strictEqual(calls.manager.length, 0);

  const before = calls.manager.length;
  onMessage(evt({ chat_type: 'group', content: '{"text":"@_user_1 你好"}' }));
  assert.strictEqual(calls.manager.length, before);

  onMessage(evt({
    chat_type: 'group',
    content: '{"text":"@_user_1 开工"}',
    mentions: [{ key: '@_user_1' }],
  }));
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onPhoneMessage',
    { chatId: 'oc_1', text: '开工', media: null, senderOpenId: 'ou_me' },
  ]);
});
```

⑥ 在「卡片动作与群事件」用例之后插入两个用例：

```js
test('卡片动作：alias-rename 进总控面板，其余进 manager', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });
  const onCardAction = calls.wsOpts.handlers.onCardAction;

  onCardAction({
    operator: { open_id: 'ou_me' },
    action: { value: { act: 'alias-rename', from: '卡牌' } },
    context: { open_chat_id: 'oc_p2p' },
  });
  assert.deepStrictEqual(calls.control.at(-1), [
    'onCardAction',
    { chatId: 'oc_p2p', openId: 'ou_me', action: { act: 'alias-rename', from: '卡牌' } },
  ]);

  onCardAction({
    operator: { open_id: 'ou_me' },
    action: { value: { act: 'full-screen', lines: 200 } },
    context: { open_chat_id: 'oc_1' },
  });
  assert.deepStrictEqual(calls.manager.at(-1), [
    'onCardAction',
    { chatId: 'oc_1', openId: 'ou_me', action: { act: 'full-screen', lines: 200 } },
  ]);
});

test('机器人被拉进群：交给总控面板做自我介绍', async () => {
  const { deps, calls } = makeDeps();
  await createDaemon({ deps });

  calls.wsOpts.handlers.onBotAdded({
    chat_id: 'oc_g',
    operator_id: { open_id: 'ou_me' },
  });
  assert.deepStrictEqual(calls.control.at(-1), [
    'onBotAdded',
    { chatId: 'oc_g', openId: 'ou_me' },
  ]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd /d/feishu-bridge && node --test test/control.test.js test/projects.test.js test/daemon.test.js`
预期：FAIL，先是 `Cannot find module '../src/control'`；修掉这条之后，daemon 的用例会因为 `calls.controlOpts` 为 null 继续红。

- [ ] **步骤 3：编写实现**

**3a. 新建 `src/control.js`：**

```js
// src/control.js —— 私聊总控面板：会话列表 / 结束会话 / 改别名。
// 只做「读状态 + 发消息」，不建会话、不碰 PTY（规格 §7、§10.1）。
const { card } = require('./feishu/cards');

const HELP_TEXT = [
  '我是你的电脑终端桥，私聊时是总控面板：',
  '· 发「列表」看所有会话',
  '· 发「结束 <别名>」关掉某个会话',
  '· 发「改名 <旧名> <新名>」改项目别名（也可以点面板上的按钮）',
  '要开工，请在项目群里 @我 说「<别名> 要做什么」。',
].join('\n');

const STATUS_TEXT = {
  starting: '启动中',
  idle: '空闲',
  running: '运行中',
  error: '出错',
  closing: '关闭中',
  closed: '已关闭',
  interrupted: '已中断',
};

const MAX_ALIAS_BUTTONS = 10;
const HELP_ONLY = /^(帮助|help|\?|？)$/i;

function parseControl(text) {
  const t = String(text || '').trim();
  if (!t) return { act: 'help' };
  if (/^(列表|会话|面板|状态)$/.test(t)) return { act: 'list' };
  if (HELP_ONLY.test(t)) return { act: 'help' };
  let m = t.match(/^(?:结束|关闭|关掉)\s+(.+)$/);
  if (m) return { act: 'end', target: m[1].trim() };
  m = t.match(/^改名\s+(\S+)\s+(\S+)$/);
  if (m) return { act: 'rename', from: m[1], to: m[2] };
  return { act: 'help' };
}

function formatSessions(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '现在没有会话。去项目群里 @我 发一句就能开工。';
  }
  return list.map((s, i) => {
    const name = s.alias ? `${s.alias}（${s.cwd}）` : (s.cwd || s.id);
    const agent = s.agent === 'codex' ? 'Codex' : 'Claude';
    const status = STATUS_TEXT[s.status] || s.status || '未知';
    return `${i + 1}. ${name} · ${agent} · ${status}`;
  }).join('\n');
}

function panelCard({ sessions, aliases }) {
  const names = Object.keys(aliases || {}).slice(0, MAX_ALIAS_BUTTONS);
  const elements = [{ tag: 'markdown', content: formatSessions(sessions) }];
  if (names.length) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: '**项目别名**（点一行改名）' });
    for (const name of names) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `${name} → ${aliases[name]}` },
        type: 'default',
        behaviors: [{ type: 'callback', value: { act: 'alias-rename', from: name } }],
      });
    }
  }
  return card({ title: '🛰️ 总控面板', template: 'blue', elements });
}

function createControl({ api, listSessions, closeSession, getProjects, renameAlias, ownerOpenId, log }) {
  const pending = new Map(); // chatId -> 待改名的旧别名

  const send = (chatId, text) => api.sendText(chatId, text);

  async function sendPanel(chatId) {
    const { aliases } = getProjects() || {};
    await api.sendCard(chatId, panelCard({ sessions: listSessions(), aliases }));
  }

  async function doRename(chatId, from, to) {
    if (!to || /\s/.test(to)) { await send(chatId, '新别名不能为空、不能带空格。'); return; }
    const r = renameAlias({ from, to });
    if (!r || !r.ok) { await send(chatId, (r && r.message) || '改名失败。'); return; }
    log?.info?.('control.alias_renamed', { from, to });
    await send(chatId, `已把「${from}」改成「${to}」。以后在群里发「${to} 要做什么」就行。`);
  }

  async function onMessage({ chatId, text, senderOpenId }) {
    if (senderOpenId !== ownerOpenId) return;
    const body = String(text || '').trim();

    const pendingFrom = pending.get(chatId);
    if (pendingFrom) {
      pending.delete(chatId);
      const cmd = parseControl(body);
      if (!HELP_ONLY.test(body) && cmd.act === 'help' && body) {
        await doRename(chatId, pendingFrom, body);
        return;
      }
      // 用户改主意发了命令，按命令继续处理
    }

    const cmd = parseControl(body);
    if (cmd.act === 'list') { await sendPanel(chatId); return; }

    if (cmd.act === 'end') {
      const list = listSessions();
      const hit = list.find((s) => s.alias === cmd.target) || list.find((s) => s.id === cmd.target);
      if (!hit) { await send(chatId, `没找到会话「${cmd.target}」。发「列表」看看有哪些。`); return; }
      await closeSession(hit.id, { reason: '手机总控面板关闭', notify: true });
      log?.info?.('control.session_closed', { sessionId: hit.id });
      await send(chatId, `已结束会话「${hit.alias || hit.cwd || hit.id}」。`);
      return;
    }

    if (cmd.act === 'rename') { await doRename(chatId, cmd.from, cmd.to); return; }

    await send(chatId, HELP_TEXT);
  }

  async function onCardAction({ chatId, openId, action }) {
    if (openId !== ownerOpenId) return;
    if (!action || action.act !== 'alias-rename') return;
    const { aliases } = getProjects() || {};
    if (!action.from || !aliases || aliases[action.from] === undefined) {
      await send(chatId, `别名「${action.from}」已经不在了，发「列表」重新看。`);
      return;
    }
    pending.set(chatId, action.from);
    await send(chatId, `把「${action.from}」改成什么？直接回复新名字（不带空格）。`);
  }

  async function onBotAdded({ chatId, openId }) {
    if (openId !== ownerOpenId) return;
    await api.sendCard(chatId, card({
      title: '👋 我是终端桥',
      template: 'green',
      elements: [{
        tag: 'markdown',
        content: '在这个群里 @我 说「<项目别名> 要做什么」，我会在电脑上开一个会话。\n没有别名也行，直接说要做什么，会在默认目录开工。',
      }],
    }));
  }

  return { onMessage, onCardAction, onBotAdded };
}

module.exports = {
  HELP_TEXT, STATUS_TEXT, MAX_ALIAS_BUTTONS,
  parseControl, formatSessions, panelCard, createControl,
};
```

**3b. 修改 `src/projects.js`**：顶部加引用、加函数、改导出。

顶部旧：

```js
// src/projects.js
const fs = require('node:fs');
```

新：

```js
// src/projects.js
const fs = require('node:fs');
const { writeJsonAtomic } = require('./store');
```

文件末尾（`module.exports` 之前）加：

```js
// 只改 aliases 一项：读原始 JSON 再写回，default / recent / 未来新增字段原样保留
function renameAlias({ file, from, to }) {
  const name = String(to || '').trim();
  if (!name) return { ok: false, message: '新别名不能为空。' };
  if (/\s/.test(name)) return { ok: false, message: '新别名不能带空格。' };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, message: '读不到 projects.json，先在电脑上跑一次 npm run setup。' };
  }
  if (!doc || typeof doc !== 'object' || !doc.aliases || typeof doc.aliases !== 'object') {
    return { ok: false, message: 'projects.json 里没有别名表。' };
  }
  if (typeof doc.aliases[from] !== 'string') {
    return { ok: false, message: `别名「${from}」不存在。` };
  }
  if (from === name) return { ok: false, message: '新旧别名一样，不用改。' };
  if (Object.prototype.hasOwnProperty.call(doc.aliases, name)) {
    return { ok: false, message: `别名「${name}」已经被占用了。` };
  }

  const aliases = {};
  for (const [k, v] of Object.entries(doc.aliases)) {
    aliases[k === from ? name : k] = v;
  }
  doc.aliases = aliases;
  writeJsonAtomic(file, doc);
  return { ok: true, aliases };
}
```

导出旧：

```js
module.exports = { loadProjects };
```

新：

```js
module.exports = { loadProjects, renameAlias };
```

**3c. 修改 `bin/daemon.js`：**

① 顶部引用：把 projects 那行补上 `renameAlias`，再加 control 一行。

旧：

```js
const { loadProjects } = require('../src/projects');
```

新：

```js
const { loadProjects, renameAlias } = require('../src/projects');
const { createControl } = require('../src/control');
```

② 工厂默认值区加一行（`managerFactory` 下面）：

```js
  const controlFactory = deps.controlFactory || createControl;
```

③ `manager = managerFactory({...});` 整段结束后，紧接着装配 control：

```js
  const control = controlFactory({
    api,
    listSessions: () => manager.list(),
    closeSession: (id, opts) => manager.closeSession(id, opts),
    getProjects: getProjectsFn,
    renameAlias: (args) => renameAlias({ file: pathsApi.PROJECTS, ...args }),
    ownerOpenId: config.ownerOpenId,
    log,
  });
```

④ `wsFactory` 的 `handlers` 里，`onMessage` 和 `onCardAction` 换掉，并在 `onBotRemoved` 后面加 `onBotAdded`。整块新代码：

```js
    handlers: {
      onMessage: (evt) => {
        const m = parseMessage(evt);
        if (!m) return;                                        // 机器人自己发的，防回环
        if (m.chatType !== 'p2p' && !m.mentioned) return;      // 群里没 @ 就当闲聊
        if (m.unsupported) {
          api.sendText(m.chatId, `暂不支持 ${m.unsupported} 类型的消息，发文字、图片或文件吧。`)
            .catch((err) => log.warn('类型提示发送失败', { chatId: m.chatId, message: errText(err) }));
          return;
        }
        if (m.chatType === 'p2p') {                            // 私聊 = 总控面板，绝不建会话
          control.onMessage({ chatId: m.chatId, text: m.text, senderOpenId: m.openId })
            .catch((err) => log.warn('总控面板处理失败', { chatId: m.chatId, message: errText(err) }));
          return;
        }
        manager.onPhoneMessage({ chatId: m.chatId, text: m.text, media: m.media, senderOpenId: m.openId })
          .catch((err) => log.warn('手机消息处理失败', { chatId: m.chatId, message: errText(err) }));
      },
      onDisbanded: (evt) => {
        const chatId = parseChatId(evt);
        if (!chatId) return;
        manager.onDisbanded({ chatId })
          .catch((err) => log.warn('解散处理失败', { chatId, message: errText(err) }));
      },
      onBotRemoved: (evt) => {
        const chatId = parseChatId(evt);
        if (!chatId) return;
        manager.onBotRemoved({ chatId })
          .catch((err) => log.warn('移出处理失败', { chatId, message: errText(err) }));
      },
      onBotAdded: (evt) => {
        const chatId = parseChatId(evt);
        const openId = (evt && evt.operator_id && evt.operator_id.open_id)
          || (evt && evt.operator && evt.operator.open_id);
        if (!chatId) return;
        control.onBotAdded({ chatId, openId })
          .catch((err) => log.warn('入群自我介绍失败', { chatId, message: errText(err) }));
      },
      onCardAction: (evt) => {
        const a = parseCardAction(evt);
        if (!a) return;
        if (a.action.act === 'alias-rename') {
          control.onCardAction(a)
            .catch((err) => log.warn('别名卡片处理失败', { chatId: a.chatId, message: errText(err) }));
          return;
        }
        manager.onCardAction(a)
          .catch((err) => log.warn('卡片动作处理失败', { chatId: a.chatId, message: errText(err) }));
      },
    },
```

**3d. 修改 `docs/acceptance.md`**：在「## 验收结论」之前插入第 12 条，并把 Plan A 分母改成 12。

插入：

```markdown
### 12. 🅐 私聊总控面板

1. 飞书里点机器人头像进私聊，发「列表」→ 收到总控面板卡片：上面是会话列表，下面一行行别名按钮。
2. 点某个别名按钮 → 回「把「XX」改成什么？」；回复一个新名字 → 回「已把「XX」改成「YY」」。
3. 到项目群发「YY 帮我看看这个文件」→ 用的还是原来那个目录（说明改名生效）。
4. 私聊发「结束 YY」→ 该会话被关掉，群里收到停止提示。
5. 私聊发「随便说点什么」→ 只回帮助文字，**不会**新建会话。

- [ ] 🅐 面板能列会话、能改名、能关会话、闲聊不建会话
```

结论区旧：

```markdown
- Plan A 通过条数：____ / 11（🅐 部分）
```

新：

```markdown
- Plan A 通过条数：____ / 12（🅐 部分）
```

- [ ] **步骤 4：运行测试验证通过**

先跑本任务碰到的三个文件：

```bash
cd /d/feishu-bridge && node --test test/control.test.js test/projects.test.js test/daemon.test.js
```

预期：`# pass 37`（control 11 + projects 14 + daemon 12），`# fail 0`

再跑全量：

```bash
cd /d/feishu-bridge && npm test
```

预期：全绿，无 fail。

- [ ] **步骤 5：Commit**

```bash
cd /d/feishu-bridge
git add src/control.js src/projects.js bin/daemon.js test/control.test.js test/projects.test.js test/daemon.test.js docs/acceptance.md
git commit -m "feat: 私聊总控面板（会话列表 / 结束会话 / 改别名）"
```

---

---

## 4. 执行顺序与并发建议

任务是 TDD 串起来的，但**不是每个任务都得排队**。§2 的模块契约已经锁死了跨模块接口，所以只要两个任务不碰同一个文件，就可以同时做。下面按「同一波内文件互不相交」切好，派发时直接用。

| 波次 | 可并发的任务 | 为什么能并发 |
|---|---|---|
| 1 | 任务 1 | `paths.js` / `log.js` 是所有人的地基，必须第一个落地 |
| 2 | 任务 2、3、4、5、6、7、8、10、11、12（10 个） | 分别只改 `config.js+secrets.js` / `store.js` / `queue.js` / `projects.js+router.js` / `launcher.js` / `hook-stop.js` / `ipc.js` / `feishu/api.js` / `feishu/cards.js` / `screen.js`，只依赖任务 1 |
| 3 | 任务 9、13、23 | `ptySession.js` / `feishu/ws.js` / `feishu/events.js` 三个文件互不相交；13 需要 10、11 已完成 |
| 4 | 任务 14、15、20 | `setup.js` / `manager.js` / `ptySession.js`；14 需要 13，15 需要 9，20 需要 9 |
| 5（串行） | 任务 16 → 17 → 18 → 19 → 21 → 22 | 全部改 `src/session/manager.js`，必须一棒一棒接 |
| 6 | 任务 24 | 同时改 `ptySession.js` / `manager.js` / `ipc.js` / `daemon.js`，必须等第 4、5 波全部完成 |
| 7（串行） | 任务 25 → 28 → 26 → 27 | 后三个都要改 `bin/daemon.js`，按这个顺序，避免互相覆盖 |

**派发规则：**

1. 每个任务交给一个独立子代理，在**各自独立的 worktree** 里做，不要在同一个工作目录里同时改。
2. 子代理开工前只读三样：本任务那一节、§2 模块契约、规格里本任务标注的章节。不要让它通读整个计划。
3. 合回顺序按任务号。每合回一个就跑一次 `npm test`；红了立刻修，不要攒批。
4. 如果某个任务的测试 import 了同波次另一个任务还没产出的模块，就把被依赖的那个任务提前到前一波——这是唯一允许打乱波次的情况。
5. 第 5 波是长链，别并发；manager.js 一旦出现两个版本的 `onPhoneMessage` 合并起来比重写还贵。

---

## 5. 验收清单（规格 §12 → 任务）

| 规格 §12 | 由哪些任务实现 | 怎么验 |
|---|---|---|
| 0 ConPTY 最小验证 | 已完成（2026-11-23 实测） | 无需重做 |
| 1 手机拉群 → 回复卡片 | 9、10、13、15、17、23、25 | `docs/acceptance.md` 第 1 条 |
| 2 连发两条不粘连 | 4、16 | 第 2 条 |
| 3 电脑窗口敲字 → 手机收到 | 7、8、17、24 | 第 3 条（Plan A 用 `test/e2e` 的本地 WS 客户端代入键盘） |
| 4 双击 3 次 → 3 窗口 3 群 | 15 提供后端；窗口由 **Plan B** 提供 | 第 4 条（🅑，Plan B） |
| 5 关窗口 → 群收到结束 | 18 提供 `closeSession`；窗口由 **Plan B** 提供 | 第 5 条（🅑，Plan B） |
| 6 解散群 → 会话自己收尾 | 18、26 | 第 6 条 |
| 7 首句别名 / 默认目录 | 5、15 | 第 7 条 |
| 8 杀 claude → 异常提示 + 重来 | 18 | 第 8 条 |
| 9 重启 → 自动恢复 | 19、27、26 | 第 9 条 |
| 10 Codex 全链路 | 20、21、22 | 第 10 条 |
| 11 日志无机密 | 1（脱敏）+ 26（`npm run check:logs`） | 第 11 条 |
| 12 私聊总控面板（本计划新增） | 28 | 第 12 条 |

**Plan A 完成的定义（四条同时成立）：**

1. 28 个任务的所有复选框打了勾。
2. `npm test` 全绿。
3. 填好真实凭据后 `npm run setup` 一次通过。
4. `docs/acceptance.md` 里全部 🅐 条目（12 条）实测通过；🅑 条目留给 Plan B。

---

## 6. 风险与对策

| # | 风险 | 对策 | 落在哪 |
|---|---|---|---|
| 1 | 两个 daemon 同时连飞书 WS，事件随机丢 | 单实例锁：启动先读 `ipc.json` 探活，旧的在就退出并写日志 | 任务 1、8、25 |
| 2 | 事件回调超过 3 秒，飞书重推 | `ws.js` 先 ack 再入串行队列；`event_id` 去重 | 任务 13 |
| 3 | Claude 升级后 Stop hook 不触发，手机端收不到回复 | hook 是唯一来源，但「静默 + 输入框」的轮次判定在 `ptySession` 里是通用的；真出问题时把 Codex 的判定路径套给 Claude（改一个 `agent` 判断即可），并在日志里 `warn` 提示 | 任务 7、20；升级后跑验收第 1 条 |
| 4 | Codex TUI 画面噪声大，推送卡片难看 | 合并节流 + 只推可见区；已知限制，v1 接受 | 任务 12、22 |
| 5 | 全自动权限被非主人利用 | 群消息、私聊、卡片回调三处都校验 `ownerOpenId`；机器人自己发的消息按 `sender_type` 过滤防回环 | 任务 13、16、18、28 |
| 6 | 群解散事件丢失或延迟 | 30 s 抽检所有未 closed 会话（见 §7 差异 2） | 任务 18 |
| 7 | `--resume` 失败（transcript 被清 / claude 换版） | 捕获失败、降级为新建会话并在群里说明 | 任务 19 |
| 8 | 多个窗口同时写 PTY 导致输入错乱 | 只有 `idle` 允许写；每个会话一条 FIFO，一条在途 | 任务 4、9、16 |
| 9 | 密钥进日志 | 日志统一走 `redact()`；验收第 11 条 `npm run check:logs` 兜底 | 任务 1、26 |
| 10 | 计划任务需要管理员 | 用 ONLOGON + LeastPrivilege，已实测免管理员导入 | 任务 27 |
| 11 | 并发子代理互相踩文件 | §4 的波次规则 + 每任务独立 worktree + 合回即跑测试 | §4 |
| 12 | Node / 依赖漂移 | `package-lock.json` 入库；`node` 用绝对路径 `C:\Program Files\nodejs\node.exe`；启动时校验主版本 ≥ 22 | 任务 1、25 |

---

## 7. 与规格的差异

实现前逐条知情，不用再回头翻规格。

1. **长回复只截断，不提供「下载完整内容」。** 规格 §6.2 设想大段输出另存文件让手机下载。本计划只做 8000 字截断 + 提示「完整输出请到电脑上看」（`cards.js` 的 `truncate`，标题变「✅ 回复（已截断）」）。理由：文件上传属飞书另一套接口，v1 先不做；手机上需要全文时看屏幕卡。

2. **30 s 抽检的范围从「非 idle 会话」改成「所有未 closed 会话」。** 规格 §8 原话限定非 idle。但用户解群这个动作通常发生在会话**空闲等指令**的时候，只查非 idle 等于在最常见场景下失效。改成全查，每会话每 30 s 一次 `im.chat.get`，开销可忽略。

3. **Codex 的识别是靠首句关键词，不是靠配置。** 规格 §6.3 只说「Codex 会话」。实际只认两种写法：句首 `codex`，或句中 `用/使用/走 codex`，并把这几个字从 prompt 里剥掉。不认「看下 codex 配置」这类正文。每会话的 `agent` 一经确定不可中途切换（规格 §2 的硬约束）。

4. **`resize` 在 Plan A 就实现了。** 规格 §3.2 把窗口 resize 归到电脑端窗口程序。Plan A 的 `ipc.js` 和 `ptySession.resize()` 已经支持（任务 24），Plan B 直接调用即可。

5. **`buildLaunch` 的入参比规格设想的多。** 除了 exe/args/cwd，还要传 `hookFile`、`bridgeToken`、`hookUrl`、`transcriptPath`、`env`（任务 6）。规格没写契约，以 §2 为准。

6. **项目别名的电脑端管理延后到 Plan B。** 规格 §7 提到「recent 目录扫描」和「电脑端记成别名」。Plan A 只有 `projects.json` 这一份文件（`npm run setup` 写入默认值）+ 手机端总控面板改别名（任务 28）。目录自动扫描、电脑端一键记别名留给 Plan B 的项目选择面板。

7. **改别名用「点按钮 + 回复一次新名字」，不用表单卡片。** 规格 §7 写的是「一张设置卡片」。飞书卡片 2.0 里 `form` / `input` / `form_submit` 的 schema 没有稳定文档，实测风险高。改用：面板每行别名一个按钮 → 点了机器人问「改成什么？」→ 用户下一条文字就是新名字。一次点击 + 一次回复，手机上体验等价，实现全靠已实测的 `button + callback`。

8. **Plan A 没有真窗口，验收第 3、4、5 条分两段走。** 第 3 条（电脑端敲字 → 手机收到）在 Plan A 用 `test/e2e` 里的本地 WS 客户端模拟窗口输入；第 4、5 条（多窗口、关窗口）必须等 Plan B 才有东西可点，所以在验收清单里标成 🅑。

9. **Claude 侧没有「hook 失效」的兜底。** 规格把 Stop hook 当唯一干净来源。本计划照做，不做屏幕推断的并行兜底——两套判定同时跑容易出现「一条回复推两次」。若将来 claude 改掉 hook 字段，按 §6 风险 3 处理。

10. **手机端「结束会话」走的是私聊，不是群命令。** 规格 §8 只写「解散群」。执行层保留了群解散（`im.chat.disbanded_v1`），同时补了私聊「结束 <别名>」（任务 28），这样不解散群也能收掉某个会话。两种都支持，不冲突。

11. **私聊 = 总控面板，私聊里说什么都不会建会话。** 规格 §5.1 只描述「拉群 @机器人」。现在私聊固定按控制面板解析（列表 / 结束 / 改名 / 帮助），随口说话只回帮助文字。这样手机上有两个入口：干活去群，管理去私聊，互不误伤。

> 以下 12–15 是**实现阶段**发现的计划自身缺陷与已知取舍，已裁决并落地，记录在此不再回头改。

12. **`truncate` 的省略字数算式修正（任务 11）。** 计划原文按「头部取满 `limit`、再拼 1500 字尾部」计算，输出会比原文还长（9003 字输入 → 9523 字输出），与自身测试 `r.text.length < long.length` 矛盾。实现改为：`head = text.slice(0, limit - TAIL_CHARS)`、`omitted = text.length - limit`。行为等价于「保头 6500 + 保尾 1500 + 一行截断标记」，输出稳定压在 8000 出头，省略字数如实（9003 → 1003）。

13. **会话表容错的分界（任务 3）。** 计划步骤里写的「损坏时备份成 `.corrupt-`」只适用于**解析失败**（真正的坏 JSON）。JSON 合法但内容为 `null`、或 `sessions` 不是数组时，`store.load()` 的处理是**直接重置为空表**，不产生备份——按计划正文的参考实现口径执行。解析失败的备份行为保持不变。

14. **IPC 的 WebSocket 鉴权测试删掉了一行（任务 8）。** 计划测试在错误 token 的客户端上写 `bad.on('open', () => resolve(false))`，期望它永远不触发 `open`。但 ws 8.23 下服务端在 `connection` 里 `ws.close(4001)` 属于握手后的带内关闭，客户端事件顺序必然是先 `open` 再 `close`，该断言恒失败——是计划测试的缺陷，不是实现问题。**实现保持与计划逐字一致**（`close(4001)`），测试只删掉那一行 `open` 监听，「错误 token 被断开」的断言（`close` 码 4001）保留。同时给测试补了 `t.after(() => ipc.close())`，避免断言失败时 server 未关闭导致 `node --test` 挂住。

15. **首句解析的两条已知限制（任务 5）。** 一是盘符路径按空白截断，`D:/work 副本 帮我修` 只会取 `D:/work`——带空格的项目目录请用别名，别用路径；二是分隔符 `SEP` 只认空白与 `,，:：、`，不认 `。！？；`，所以 `卡牌。帮我看看` 不会切出「卡牌」这个别名，会落到默认目录。两条都是计划的显式取舍（正则即契约），v1 不改；若真机上确实别扭，再把中文句末标点并进 `SEP` 并补测试。

16. **`src/paths.js` 的导入写法与计划不同（任务 15）。** 计划任务 15 的参考代码写 `const { paths } = require('../paths')`，但该模块导出的是对象本身（`ROOT, STATE, …` 直接在顶层），没有 `paths` 键。实际写法必须是 `const paths = require('../paths')`，后续任务照此引用。

17. **首句路径不存在时的降级（任务 5）。** `parseFirstMessage` 对 `source: 'path-missing'` 的处理是：不建目录、不猜，直接把**整条原文**当作 prompt 送进默认目录的会话。计划没写这条分支的语义，这里固定为「宁可原文全给模型，也不悄悄丢掉路径片段」。

18. **Codex 的提示符是 `›` 不是 `❯`（任务 12）。** 计划里的屏幕判定只写了 Claude 的 `❯`（U+276F）。实测 Codex 0.166.0 二进制含 17 处 `›`（U+203A）、0 处 `❯`。`screen.js` 的 `PROMPT_RE` 同时接受两个字形，并且必须**锚定行首**（允许前导空白）；裸 `includes` 会被信任对话框和正文里的 `❯` 骗过。

19. **卡片必须用「卡片实体」三件套更新（任务 10）。** 计划任务说明里曾出现 `updateCard` / `updateMessage`，落地以规格 §6 为准：`createCardEntity(card)` 创建，首次 `sendCardEntity(chatId, cardId)` 发出，后续用 `updateCardEntity(cardId, card, seq)` 原地更新。飞书长连接场景下没有别的可靠更新路径。

20. **卡片 2.0 的若干硬约束（任务 10、11）。** `config` 里只能有 `update_multi: true`；`wide_screen_mode` 是 1.0 专属字段，2.0 不许带；行内标签（如 `<font>`）里的 `<` 要写成 `&#60;`，否则卡片 JSON 解析失败；代码围栏连续 3 个以上反引号会破坏渲染，发出前插入 U+200B 打断；页脚用 `<font color='grey'>`。照计划里的 1.0 写法会直接发不出卡片。

21. **日志脱敏只覆盖 `fields`，`event` 必须是固定字符串（任务 8）。** `createLogger` 的 `redact()` 只处理 `fields`，`event` 原样落盘。上一版 IPC 错误日志把 handler 名和错误文本拼进 `event`，真实探针确认 token 明文进了 JSONL。已改为 `log.warn('ipc.handler_error', { handler, error })`，handler 名再经白名单收敛。**后续任何模块都不许往 `event` 里拼动态内容**，作为硬规则。

22. **hook-stop 的看门狗不能靠「收到响应头就返回」代替（任务 7）。** 修 bug 时实测：只删掉 `BUDGET_MS` 看门狗，drip 测试仍然绿——因为「收到响应头就 `res.destroy()`」独立地解开了挂起；只有换回原始实现才能让测试变红。结论：看门狗作为绝对兜底保留（`BUDGET_MS=1800` 同步设置、`unref()`、`finally` 清除、所有路径 `exit 0`、stdout 为空），测试需能区分这两层。

23. **富文本里的代码块必须保持原文（任务 23）。** `post` 富文本解析会把 `code_block` 的文本和普通文本一起过 `stripMentions` + 空白压缩，实测 4 个空格变 1 个、3 个换行变 2 个、`@_user_1` 被删——代码直接坏掉。已改为 `code_block` 跳过剥离与归一化，并补保真测试。

24. **SDK 1.77.0 的日志开关有 falsy 陷阱（任务 13）。** `lib/index.js` 里是 `new LoggerProxy(params.loggerLevel || LoggerLevel.info, ...)`，`fatal = 0` 是 falsy，只设级别会被回落成 `info`，长连接一启动就往 stdout 打 `[info]: [ 'event-dispatch is ready' ]`。必须**同时**注入一个五方法 noop logger；`WSClient` 那边是解构默认值（只有 `undefined` 才回落），传 0 有效。测试要同时锁定「级别 = 0」和「注入了 logger」。

25. **`turn-end` 必须先发，再 `releaseTurn()`（任务 20）。** `releaseTurn()` → `queue.release()` 会**同步**泵出下一条排队消息并紧接着发 `turn-start(B)`。若先释放再发 `turn-end(A)`，事件顺序会变成 `turn-start(A) → input(A) → input(B) → turn-start(B) → turn-end(A)`，A 的结束事件被排到 B 开始之后。正确顺序是 `emit({type:'turn-end'})` 在前、`releaseTurn()` 在后；`test/ptySession.test.js` 用 `types.slice(-2)` 锁死这个顺序。

26. **Codex 的轮次结束是「静默推断」，不是事件（任务 20）。** Codex 0.166 没有 Stop hook，判定为：`status === 'running'` 且 `isReady()` 且 `inInputBox()` 且距最后一次写入 ≥ 1500 ms（`CODEX_MIN_TURN_MS`），且连续 3 次 200 ms 轮询稳定（`CODEX_SETTLE_POLLS`）。已知风险：**长时间只在思考/跑工具而不刷新画面的回合会被误判结束**。若真机出现，优先调大 `CODEX_MIN_TURN_MS` 或改用画面尾部变化探测；当前 `turn-end` 事件也不带 `seq`，manager 侧不做持久化（留给任务 22/组合时按需补）。

27. **任务 16 的安全与竞态边界（已知、不阻断）。** ①主人校验是 fail-open：`config.ownerOpenId && senderOpenId && senderOpenId !== owner` 才拦截，`senderOpenId` 缺失时放行；真实事件路径上 `events.js` 保证 open_id 必存在，但 daemon 装配时必须校验 `ownerOpenId` 非空，否则所有人可用。②带附件的消息在 `await attachMedia`（下载/落盘）期间若会话恰好退出，`submitText` 返回 `'closed'` 后消息被静默丢弃，连「会话已停」提示都没有——纯文本路径无此窗口（守卫到写入之间无 await）。③未登记群的首条消息若带附件，附件会被丢弃（`createFromPhone` 不接收 media）。④同名文件类附件按原始 `file_name` 落盘，同会话连发两个 `report.md` 后者覆盖前者。

28. **`setup` 的 `ws.close()` 只是「发起」不是「等完成」（任务 14）。** `finally { Promise.resolve(ws.close()).catch(() => {}) }` 已满足测试，但如果 `ws.start()` 同步抛错（SDK 内部非 Promise 路径），`finally` 里的调用仍可能同步抛并掩盖原始错误。装配阶段如需加固，改成 `Promise.resolve().then(() => ws.close()).catch(() => {})`；不影响验收。

29. **任务 15 的两处小冗余（已知）。** ①`loadProjectsFn` 同时用了 `projects.default || config.defaultCwd` 和 `parseFirstMessage` 的 `defaultCwd` 兜底，两处等价，任一处失效仍有另一处，非缺陷。②`newId()` 用 `now()` + 随机 3 位，固定时钟（测试注入）下同毫秒创建多个会话理论可碰撞；真实时钟 + 创建走串行路径，实际不可达。

30. **会话状态机的写入前置条件（任务 9）。** 只有 `idle` 才能写 PTY：`canWrite = status === 'idle' && screen.isReady() && screen.inInputBox()`；`starting` 期间到 `ready` 之前只能排队；`closed`/`disposed` 后 `submitText` 返回 `'closed'` 并 emit `input(rejected)`；`force` 是唯一绕过 `canWrite` 的入口（盲写护栏）。后续任务 18/19 改 `onPhoneMessage`/`restoreAll` 时不得改动这三条不变式。

31. **其余实现期实测结论（任务 7/12/13）。** ①hook-stop 看门狗 `BUDGET_MS = 1500`（绝对兜底），llhttp 在请求行解析阶段对非法方法字符直接回 `400`，因此测试构造的畸形请求要用 `X` 而不是空格，才能命中应用层看门狗而非解析层。②屏幕就绪判定用的是底部 30 行「草稿窗口」+ `lastPromptIndex` 向右移动，往下滚动的长输出不会误判为「回到输入框」。③`WSClient` 的 `onError` 目前只进 SDK 自己的 logger，不路由到应用日志；长连接错误排障需看 `logs/` 之外的 stdout，属已知观测缺口。④富文本 `content_v2` 的 markdown 子集有限，`post` 里不要塞表格/嵌套列表，已按纯文本降级处理。

32. **真实 transcript 里 user 条目绝大多数是 tool_result（任务 17）。** 每调用一次工具，Claude Code 就写一条 `{type:'user', message:{content:[{type:'tool_result'}]}}`，紧跟 assistant 的 tool_use。`summarizeToolUse` 倒扫时若「见 user 就停」，第一个非 assistant 条目几乎必然是 tool_result，摘要恒为空——质量审查实测本机 6 个真实 jsonl 全部返回空串。已改为：content 全为 `tool_result` 块的 user 条目 `continue`，字符串或含 text 块的 user 条目才是真实轮次边界。测试夹具必须用「assistant tool_use ↔ user tool_result 交替 + 真实用户提示」的真实形状，否则改回错误实现也测不出来。

33. **处理中卡片的生命周期与竞态（任务 17）。** ①Stop 的所有提前返回路径（空白输入、无回复且未打断）必须终结 `pendingCard`，否则卡片永远停在「处理中」，下一轮 turn-start 还会把 `pendingCard` 覆盖成新卡，旧卡再无机会定稿。②慢 `createCardEntity` 与 Stop 竞态：Stop 先到会先发回复卡，随后「处理中」卡才发出且永不终结。用 `record.turnSeq` 轮次 token 解决：turn-start 与 Stop 各递增一次；`startProcessingCard` 在 create 返回后校验 token，失配直接不发；`pendingCard` 在 `sendCardEntity` **之前**登记（登记与发卡之间的 `await` 是唯一交错点）。③`updateCardEntity` 失败仍会留下旧卡（已知、不阻断），warn 日志已带 `cardId`/`chatId` 便于排障。

34. **`_drain` 必须是「等到队列稳定」的循环（任务 17）。** 直接暴露 `pendingWork` 是调用瞬间的 promise 快照：在 enqueue 之前 await 会立刻 resolve，测试假绿。已改为 `do { prev = pendingWork; await prev; } while (prev !== pendingWork)`。

35. **任务 17 复审后的已知非阻塞项（不在本任务修，留给最终整体审查评估）。** ①`finalizePendingCard` 的 `updateCardEntity` 失败只记日志，不像主路径那样 `sendCard` 兜底重发——卡片会停在「处理中」且该段文字丢失；概率低（只发生在空白/无输出回合），修法是对齐主路径。②三个测试缺口：pendingCard 先登记后发送、发送失败 catch 清空 pending、drain 的 settle 语义，变异实验显示删掉这三点仍 44/44 绿，靠阅读而非测试守护。③`src/agent/tools.js` 顶部注释仍写「碰到 user 就停」，与新逻辑矛盾，属注释过期。④PTY 在无 Stop 的情况下退出（`exit` 到 `error`）时 `pendingCard` 残留，卡片会停在「处理中」；这是任务 17 之前就有的问题，可在任务 18 的 exit 分支顺手收尾。⑤重复 Stop（重连/重放）会重复发回复卡并多加一次 `turnSeq`，无幂等。⑥超过 20MB 的 transcript 静默跳过工具摘要，9 份真实文件中有 2 份命中。

36. **任务 18 复审后的已知非阻塞项。** ①质量审查发现并已在本任务修复：`ptySession.kill()` 曾把共享的 `session.status` 置 `'closed'`，覆盖 `closeSession` 先置的 `'closing'`，导致主动关闭仍发「进程异常退出」卡并广播一次 error 状态；已删该行，并补「主动关闭不误报崩溃」测试（假 PTY 的 kill 同步 emit exit）。注意该 manager 级测试模拟的是修复后行为，若有人把该行加回 `ptySession.kill()`，这个测试不会拦（靠 ptySession 自身测试与代码评审守护）。②`revive()` 的 `spawn(record)` 与两处网络调用没有 try/catch，与 `createFromPhone`/`createFromPc` 的「启动失败」处理不一致；PTY 拉不起来时记录停在 `starting` 且用户收不到提示。③`closeSession` 的 `store.remove` 在 `notify`/`autoDisband` 两个 await 之后，若期间用户发「重来」复活同一记录，会被随后的 remove 删掉，留下孤儿 PTY；当前调用方（解散/移出/抽检）都不触发，接窗口关闭时要修。④第 35 条④（exit 时 `pendingCard` 残留）仍未处理。⑤`onCardAction` 的 `force-send` 对过期按钮会把字面「仍然发送」当普通消息提交（既有 `onPhoneMessage` 魔法串重载的延伸）。⑥`tick()` 串行 await 每群一次 `getChat`，会话多时单轮可能超过 30 秒与下一轮重叠（`store.all()` 快照语义安全，属性能项）。

37. **任务 19 复审后的补充与已知非阻塞项。** ①实现期自查发现 `record.resuming` 在 `--resume` 成功后从未复位：恢复成功的会话再崩溃会被误判成 resume 失败，静默丢掉 `claudeSessionId` 并提示「会话记录不在了」。已在 `ready` 分支清 `resuming`，并补回归用例（删掉该行即 FAIL）。②规格审查发现规格自相矛盾：`onPhoneMessage` 的「已停」守卫（`!ps || ['error','closed','closing']`）排在 `interrupted` 恢复分支之前，真实 daemon 重启后内存 `sessions` 为空，`!ps` 恒真，普通消息永远走不到 `revive`；原用例因假 PTY 残留在 `sessions` 里而假绿。已把 interrupted 分支前置（条件 `record.status === 'interrupted' && !ps`），并把 5 个用例改成 `_sessions.clear()` 模拟真实重启。③质量审查另补三处：`retryWithoutResume` 改为先 `spawn` 再 `await sendText`（否则 await 窗口内用户消息会写进已退出的旧 PTY 而丢失，期间记录被删还会留下孤儿进程），并加 `store.get(record.id) !== record` 存活守卫；`restoreAll` 的 `store.remove`/`store.save` 包 try/catch（磁盘异常不再中断启动恢复，补了「落盘失败不中断」用例）；删掉 `retryWithoutResume(record, e)` 的无意义第二实参。④残余：`notifyCrash` 没有同款存活守卫（仅当排队后记录被删才可能误发崩溃卡）；`restoreAll` 假设内存 `sessions` 为空，热重载场景会静默拒绝，而 daemon 目前只在冷启动调用；`_sessions.clear()` 只是重启近似，更真实的 e2e 应新建 manager + 预置 store；`revive()` 里 `spawn` 之后的 `sendText` 仍未包 try/catch（与第 36 条②同源）。

38. **任务 21 复审后收紧 codex 识别（偏离计划原文，已改）。** 计划给出的 `AGENT_LEAD`/`AGENT_VERB` 无词边界、VERB 不锚句首，且 VERB 分支 `.replace(/\s+/g,' ')` 会压掉 prompt 换行。质量审查实测三个反例：`'这个功能用 codex 实现过'` 被判为指定、`'codexwriter 是什么'`/`'codex-cli 怎么装'` 被判为指定、多行 prompt 的换行丢失。已改为：两个正则都在 `codex` 后加 `(?![A-Za-z0-9_-])`，`AGENT_VERB` 加 `^\s*` 锚定；VERB 分支只 `.trim()`。别名/路径分支剥前缀后正文本身以「用 codex」开头，原 11 条用例全绿。已知边界（可接受）：default 分支前导中文标点（`'，用 codex 写'`）不识别，属既有 SEP 处理范围外；`'用 codex-1号 写'` 因 lookahead 不识别。测试新增 4 条（句中提及、`codexwriter`/`codex-cli`、换行保留、`codex，` 防回归）；router 15、manager 57、全量 284。

39. **任务 22 复审后的转义加固（必须修的注入缺陷）。** 质量审查发现新增的「画面推送卡」`screenOutputCard` 与「完整画面」`fullScreenCard` 直接用 `md('```\n' + truncate(text) + '\n```')` 拼代码块：终端输出里只要出现三个反引号就会提前闭合围栏，后续内容（例如 Codex 输出里的 `<at id=all></at>`）会被当作真卡片语法解析，等于把 @所有人 的按钮交给终端输出。`lead`（电脑端输入回显）同理未转义。已改为与既有 `screenCard` 一致的三层写法：`neutralizeFences(escapeText(truncate(...)))`（围栏内插 U+200B 打断、`<` → `&#60;`），`lead` 走 `md(escapeText(lead))`。另修两处：完整画面的 `lines` 参数用 `Math.floor` 取整（`'40.5'` 会令 `buf.getLine(40.5)` 取不到行），`pushScreenOutput` 的状态守卫补齐 `'interrupted'` 与完整画面分支一致——该守卫因有更早的分支拦截，属不可达状态，测试无法覆盖，靠阅读守护。新增 4 条真红用例（围栏闭合 ×3、`'40.5'`）+ 3 条回归守卫；cards 20、manager 64、全量 297。

40. **任务 25 复审后的修正与已知非阻塞项（合并 `82f2ac8`，全量 313）。** ①规格审查发现「装配」用例的两条穿透断言是空转：`screenFactory: () => ({fallback:true})` 丢掉了实参，`queueFactory` 压根没断言；已改为在 `calls` 里记录 `screenArgs`/`queueArgs` 并断言 `{cols:120,rows:30}`、`wrapped.queueFactory === deps.queueFactory`、`calls.queueArgs` 为 `{limit:7}`，用例数不变（改后用 `--amend` 落成 `5c11a60`）。②质量审查列出但按计划范围暂不处理的项：async catch 回调里直接 `log.warn`，若日志 appendFileSync 抛错（磁盘满/权限）会成为未捕获拒绝并把 daemon 打死，建议移植 `src/ipc.js` 的 `reportHandlerError`/`safeWarn` 写法；`stop()` 的 `manager.shutdown()` 与 `ipc.close()` 之间无 `try/finally`，前者抛错则 IPC 永不关闭；停机中第二次 Ctrl+C 被一次性 handler 吞掉且无提示；`started` 在 await 之前就置真，start 失败后无法重试；stop 之后再 start 静默无操作；`probeRunning` 只看 `/health` 不校验是不是本项目的 daemon；端口/超时等数字参数未做范围校验。③覆盖缺口：sweep 定时器分支、未就绪时的 `!manager` 守卫、`probeRunning` 的失败路径、IPC `attach` 分支、`onHookStop` 接线、信号只处理一次，均无断言。

---

## 8. 计划完成状态

- 任务数：28
- 覆盖规格章节：§1–§13 全部（详见 §5 对照表）
- 未覆盖、明确留给 Plan B：Electron 多窗口、xterm.js 渲染、项目选择面板、recent 目录扫描、验收第 4、5 条
- 凭据：本计划所有任务都不需要真实 App ID / Secret / 手机，全部用假件测试；真实凭据只在跑 `npm run setup` 和真机验收时用到







