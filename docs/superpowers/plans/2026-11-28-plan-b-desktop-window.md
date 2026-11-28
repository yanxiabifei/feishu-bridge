# Plan B 电脑端镜像窗口 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 双击图标选目录和 agent，弹出一个贴着群名的终端窗口，与手机群共享同一个会话；关窗口不结束会话，结束会话先确认。

**架构：** 守护进程保持不变，只在本地 IPC 上补 `restart` / `detach` 两条消息；Electron 单进程多窗口持有唯一的 WebSocket 客户端，按 `sessionId` 把消息分发给各窗口的 `sessionFeed`；窗口渲染用 xterm.js，渲染进程开 `contextIsolation` + `sandbox`，只通过 preload 的窄接口与主进程通信。

**技术栈：** Electron 45、`@xterm/xterm` 6、`@xterm/addon-fit` 0.11、ws 8、Node ≥22（CommonJS）、`node --test`。

---

## 范围与前置

规格见 `docs/superpowers/specs/2026-11-28-plan-b-desktop-window-design.md`。

已完成（不要重做）：

- `app/lib/endpoint.js`、`client.js`、`sessionFeed.js`、`format.js`、`pickerModel.js` 已有并有测试。
- `package.json` 已加入 `electron@45.5.0`、`@xterm/xterm@6.0.0`、`@xterm/addon-fit@0.11.0`，`package.json` / `package-lock.json` 已提交。
- 守护进程的 `list` / `projects` / `attach` / `input` / `resize` / `create` / `close` 已可用。

本计划不做：多标签页、群管理、断开 10 分钟回收 PTY、自动更新。

## 文件结构

```
app/
├─ main.js                 Electron 主进程：单实例、窗口管理、消息分发、关闭确认
├─ preload.js              contextBridge 窄接口
├─ lib/
│  ├─ endpointFile.js      （新）按 FEISHU_BRIDGE_IPC → cwd → exe/appPath 向上找 ipc.json
│  ├─ pickerModel.js       （改）新增 resumable 列表
│  ├─ closePrompt.js       （新）按状态给出关闭按钮与默认项
│  └─ …                    已有
└─ renderer/
   ├─ picker.html/.css/.js 选择器窗口
   └─ session.html/.css/.js 会话窗口（xterm）
test/
├─ app-lib.test.js         新增 endpointFile / closePrompt / resumable 用例
├─ manager.test.js         新增 restartSession / notifyDetached 用例
└─ daemon.test.js          新增 restart / detach IPC 用例
```

---

### 任务 1：`app/lib/endpointFile.js`（找到 ipc.json）

**文件：**
- 创建：`app/lib/endpointFile.js`
- 测试：`test/app-lib.test.js`

- [ ] **步骤 1：写失败的测试**

```js
const { locateEndpointFile, listCandidates } = require('../app/lib/endpointFile');

test('endpointFile：优先环境变量，其次 cwd/state，再沿 exe 与 app 目录向上找', (t) => {
  const root = tmpDir(t);
  const cwd = path.join(root, 'work');
  const bin = path.join(root, 'dist', 'app', 'resources', 'app');
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const stateFile = path.join(root, 'state', 'ipc.json');
  fs.writeFileSync(stateFile, '{}');

  const cands = listCandidates({ env: {}, cwd, execPath: path.join(root, 'dist', 'exe', 'a.exe'), appPath: bin });
  assert.deepStrictEqual(cands.slice(0, 2), [
    path.join(cwd, 'state', 'ipc.json'),
    path.join(root, 'dist', 'exe', 'state', 'ipc.json'),
  ]);
  // 打包后从 resources/app 向上 4 层能回到 dist，再上一层才是仓库根：cwd 命中优先
  assert.strictEqual(locateEndpointFile({ env: {}, cwd, execPath: path.join(root, 'dist', 'exe', 'a.exe'), appPath: bin, fsApi: fs }), stateFile);

  const custom = path.join(root, 'custom.json');
  fs.writeFileSync(custom, '{}');
  assert.strictEqual(
    locateEndpointFile({ env: { FEISHU_BRIDGE_IPC: custom }, cwd, execPath: bin, appPath: bin, fsApi: fs }),
    custom,
  );
});

test('endpointFile：都不存在时返回第一个候选，交给 readEndpoint 报「先运行 npm start」', (t) => {
  const root = tmpDir(t);
  const first = path.join(root, 'state', 'ipc.json');
  assert.strictEqual(
    locateEndpointFile({ env: {}, cwd: root, execPath: path.join(root, 'a.exe'), appPath: root, fsApi: fs }),
    first,
  );
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/app-lib.test.js`
预期：FAIL，`locateEndpointFile is not a function`。

- [ ] **步骤 3：实现**

```js
const path = require('node:path');
const fs = require('node:fs');

// 打包后的 exe 不在仓库目录里，`__dirname/..` 算不出 state/ipc.json。
// 顺序：显式环境变量 → 当前目录 → exe 所在目录及其上 4 层 → app.getAppPath() 及其上 4 层。
function addUpward(out, startDir) {
  let dir = startDir;
  for (let i = 0; i <= 4; i += 1) {
    out.push(path.join(dir, 'state', 'ipc.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function listCandidates({ env = process.env, cwd = process.cwd(), execPath = process.execPath, appPath } = {}) {
  const out = [];
  if (env.FEISHU_BRIDGE_IPC) out.push(path.resolve(env.FEISHU_BRIDGE_IPC));
  out.push(path.join(cwd, 'state', 'ipc.json'));
  addUpward(out, path.dirname(execPath));
  if (appPath) addUpward(out, appPath);
  return [...new Set(out)];
}

function locateEndpointFile(opts = {}) {
  const fsApi = opts.fsApi || fs;
  const candidates = listCandidates(opts);
  return candidates.find((file) => fsApi.existsSync(file)) || candidates[0];
}

module.exports = { listCandidates, locateEndpointFile };
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/app-lib.test.js`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add app/lib/endpointFile.js test/app-lib.test.js
git commit -m "feat: 窗口侧按环境变量、当前目录与安装位置定位 ipc.json"
```

---

### 任务 2：`pickerModel` 的 `resumable` 列表

**文件：**
- 修改：`app/lib/pickerModel.js`
- 测试：`test/app-lib.test.js`

- [ ] **步骤 1：写失败的测试**

```js
test('picker：可接回的会话只留未结束的，按最后活动倒序并带状态', () => {
  const out = buildPicker({
    projects: {},
    sessions: [
      { id: 'a', cwd: 'D:/a', alias: '旧', agent: 'claude', status: 'closed', createdAt: 50 },
      { id: 'b', cwd: 'D:/b', alias: '跑着', agent: 'claude', status: 'running', createdAt: 10, lastActiveAt: 40 },
      { id: 'c', cwd: 'D:/c', alias: '空闲', agent: 'codex', status: 'idle', createdAt: 20 },
      { id: 'd', cwd: 'D:/d', status: 'error', createdAt: 30 },
    ],
  });
  assert.deepStrictEqual(out.resumable.map((s) => s.id), ['b', 'd', 'c']);
  assert.strictEqual(out.resumable[0].status, 'running');
  assert.strictEqual(out.resumable[1].alias, 'd'); // 没别名时用目录名兜底
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/app-lib.test.js`
预期：FAIL，`out.resumable` 为 `undefined`。

- [ ] **步骤 3：实现**

在 `buildPicker` 里、`return` 之前加：

```js
  const resumable = sessions
    .filter((s) => s && s.id && s.status !== 'closed' && s.status !== 'closing')
    .map((s) => ({
      id: s.id,
      alias: aliasByCwd.get(s.cwd) || s.alias || dirName(s.cwd),
      cwd: s.cwd || '',
      agent: s.agent || null,
      status: s.status || 'idle',
      at: toMs(s.lastActiveAt || s.createdAt || 0),
    }))
    .sort((a, b) => b.at - a.at);
```

`return { recent, resumable, aliases, defaultCwd, agents }`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/app-lib.test.js`
预期：PASS（原有用例不受影响）。

- [ ] **步骤 5：Commit**

```bash
git add app/lib/pickerModel.js test/app-lib.test.js
git commit -m "feat: 选择器列出可接回的未结束会话"
```

---

### 任务 3：`app/lib/closePrompt.js`（关闭窗口的按钮与默认项）

**文件：**
- 创建：`app/lib/closePrompt.js`
- 测试：`test/app-lib.test.js`

- [ ] **步骤 1：写失败的测试**

```js
const { closeChoices } = require('../app/lib/closePrompt');

test('closePrompt：正忙时默认取消，空闲时默认结束；取消永远是 Esc', () => {
  assert.deepStrictEqual(closeChoices('running').buttons.map((b) => b.id), ['cancel', 'detach', 'close']);
  assert.strictEqual(closeChoices('starting').defaultId, 'cancel');
  assert.strictEqual(closeChoices('running').cancelId, 'cancel');

  const idle = closeChoices('idle');
  assert.deepStrictEqual(idle.buttons.map((b) => b.id), ['close', 'detach', 'cancel']);
  assert.strictEqual(idle.defaultId, 'close');
  assert.strictEqual(idle.cancelId, 'cancel');
  assert.strictEqual(idle.buttons.find((b) => b.id === 'close').label, '结束会话');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/app-lib.test.js`
预期：FAIL，`closeChoices is not a function`。

- [ ] **步骤 3：实现**

```js
// 关闭窗口时的三选一。顺序按 Windows 习惯「肯定在主操作右边」，
// 默认项跟会话忙不忙走：正忙时最容易点是误点，默认取消。
const BUSY = new Set(['starting', 'running']);

function closeChoices(status) {
  const buttons = [
    { id: 'close', label: '结束会话' },
    { id: 'detach', label: '只关窗口' },
    { id: 'cancel', label: '取消' },
  ];
  if (BUSY.has(status)) {
    return {
      buttons: [buttons[2], buttons[1], buttons[0]],
      defaultId: 'cancel',
      cancelId: 'cancel',
      busy: true,
    };
  }
  return { buttons, defaultId: 'close', cancelId: 'cancel', busy: false };
}

module.exports = { closeChoices };
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/app-lib.test.js`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add app/lib/closePrompt.js test/app-lib.test.js
git commit -m "feat: 关窗口的三选一按会话状态给默认项"
```

---

### 任务 4：`manager.restartSession` / `manager.notifyDetached`

**文件：**
- 修改：`src/session/manager.js`（`return` 之前新增两个函数，并导出）
- 测试：`test/manager.test.js`

- [ ] **步骤 1：写失败的测试**

```js
test('restartSession：记录不存在报会话不存在；活着的会话不重复拉 PTY', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPc({ cwd: 'D:/card', agent: 'claude' });
  assert.strictEqual(spawned.length, 1);

  assert.deepStrictEqual(await manager.restartSession('nope'), { ok: false, error: '会话不存在' });
  assert.deepStrictEqual(await manager.restartSession(rec.id), { ok: true });
  assert.strictEqual(spawned.length, 1);
});

test('restartSession：崩溃的会话原地重来，成功回 ok，失败回 ok:false', async () => {
  const { manager, spawned } = setup();
  const rec = await manager.createFromPc({ cwd: 'D:/card', agent: 'claude' });
  rec.status = 'error';
  spawned[0].emit({ type: 'exit', code: 1 });
  const res = await manager.restartSession(rec.id);
  assert.deepStrictEqual(res, { ok: true });
  assert.strictEqual(spawned.length, 2);
});

test('notifyDetached：活着的会话才往群里发一句，已结束的静默', async () => {
  const { manager, calls } = setup();
  const rec = await manager.createFromPc({ cwd: 'D:/card', agent: 'claude' });
  assert.deepStrictEqual(await manager.notifyDetached(rec.id), { ok: true });
  assert.deepStrictEqual(calls.at(-1), ['sendText', rec.chatId, '电脑窗口已关，手机照常可发']);

  await manager.closeSession(rec.id, { notify: false });
  const before = calls.length;
  assert.deepStrictEqual(await manager.notifyDetached(rec.id), { ok: true });
  assert.strictEqual(calls.length, before);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/manager.test.js`
预期：FAIL，`manager.restartSession is not a function`。

- [ ] **步骤 3：实现**

在 `return` 之前加：

```js
  // 窗口的「重来」按钮：进程还活着就什么都不做（别为一次误点多拉一个 PTY），
  // 记录没了就明说；错误/中断态走 revive。
  async function restartSession(sessionId) {
    const record = store.get(sessionId);
    if (!record) return { ok: false, error: '会话不存在' };
    const alive = sessions.has(sessionId) && !['error', 'interrupted', 'closed', 'closing'].includes(record.status);
    if (alive) return { ok: true };
    const ok = await revive(record);
    return { ok: Boolean(ok) };
  }

  // 「只关窗口」：窗口已经要销毁了，这里的失败不值得再报回窗口，只留日志。
  async function notifyDetached(sessionId) {
    const record = store.get(sessionId);
    if (!record || !sessions.has(sessionId) || ['closed', 'closing', 'error', 'interrupted'].includes(record.status)) {
      return { ok: true };
    }
    try {
      await api.sendText(record.chatId, '电脑窗口已关，手机照常可发');
    } catch (err) {
      log.warn('窗口关闭提示发送失败', { chatId: record.chatId, message: errMessage(err) });
    }
    return { ok: true };
  }
```

加入导出：`restartSession, notifyDetached`。

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/manager.test.js`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/session/manager.js test/manager.test.js
git commit -m "feat: 会话管理器支持窗口重来与只关窗口的告知"
```

---

### 任务 5：本地 IPC 的 `restart` / `detach`

**文件：**
- 修改：`bin/daemon.js:72-114`
- 测试：`test/daemon.test.js`

- [ ] **步骤 1：写失败的测试**

```js
test('IPC restart / detach：错误转成 error，成功回 restarted / detached', async () => {
  const h = makeDeps();
  await createDaemon({ deps: h.deps });
  h.manager.restartSession = async (id) => (
    id === 'gone' ? { ok: false, error: '会话不存在' }
      : id === 'bad' ? { ok: false }
        : { ok: true });
  h.manager.notifyDetached = async () => ({ ok: true });
  const ws = { fake: true };

  h.ipc.handlers.onClientMessage({ type: 'restart', sessionId: 's1' }, ws);
  h.ipc.handlers.onClientMessage({ type: 'restart', sessionId: 'gone' }, ws);
  h.ipc.handlers.onClientMessage({ type: 'restart', sessionId: 'bad' }, ws);
  h.ipc.handlers.onClientMessage({ type: 'detach', sessionId: 's1' }, ws);
  await new Promise((r) => setImmediate(r));

  const sent = h.calls.sent.map((s) => s.obj);
  assert.deepStrictEqual(sent[0], { type: 'restarted', sessionId: 's1', ok: true });
  assert.deepStrictEqual(sent[1], { type: 'error', message: '会话不存在' });
  assert.deepStrictEqual(sent[2], { type: 'restarted', sessionId: 'bad', ok: false });
  assert.deepStrictEqual(sent[3], { type: 'detached', sessionId: 's1' });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/daemon.test.js`
预期：FAIL，收到 `未知的消息类型：restart`。

- [ ] **步骤 3：实现**

`handleClientMessage` 里 `close` 分支之后加：

```js
    if (type === 'restart') {
      manager.restartSession(msg.sessionId)
        .then((res) => {
          if (res && res.error) ipc.send(ws, { type: 'error', message: res.error });
          else ipc.send(ws, { type: 'restarted', sessionId: msg.sessionId, ok: Boolean(res && res.ok) });
        })
        .catch((err) => ipc.send(ws, { type: 'error', message: errText(err) }));
      return;
    }
    if (type === 'detach') {
      manager.notifyDetached(msg.sessionId)
        .catch((err) => log.warn('窗口关闭告知失败', { sessionId: msg.sessionId, message: errText(err) }))
        .finally(() => ipc.send(ws, { type: 'detached', sessionId: msg.sessionId }));
      return;
    }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --test test/daemon.test.js`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add bin/daemon.js test/daemon.test.js
git commit -m "feat: 本地通道新增 restart 与 detach 两条消息"
```

---

### 任务 6：Electron 主进程与 preload

**文件：**
- 创建：`app/main.js`、`app/preload.js`
- 修改：`package.json`（`main` 改为 `app/main.js`，新增 `window` 脚本）

- [ ] **步骤 1：写 preload（先定接口，再写主进程）**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  input: (data) => ipcRenderer.send('bridge:input', data),
  resize: (cols, rows) => ipcRenderer.send('bridge:resize', { cols, rows }),
  restart: () => ipcRenderer.send('bridge:restart'),
  detach: () => ipcRenderer.send('bridge:detach'),
  closeSession: () => ipcRenderer.send('bridge:close-session'),
  pickerAction: (item) => ipcRenderer.send('bridge:picker', item),
  chooseDir: () => ipcRenderer.invoke('bridge:choose-dir'),
  reconnect: () => ipcRenderer.send('bridge:reconnect'),
  onEffect: (cb) => { ipcRenderer.on('bridge:effect', (_e, eff) => cb(eff)); },
  onMeta: (cb) => { ipcRenderer.on('bridge:meta', (_e, meta) => cb(meta)); },
});
```

- [ ] **步骤 2：写主进程**

要点（完整实现见文件）：

- `app.requestSingleInstanceLock()`；拿不到锁立即 `app.quit()`；`second-instance` 时再开一个选择器。
- `windows = new Map()`：`webContents.id → { win, kind, sessionId, feed }`；`sessionWindows = new Map()`：`sessionId → BrowserWindow`。
- 懒连接：`connect()` 读 `locateEndpointFile()` → `readEndpoint()` → `createDaemonClient({ WebSocketImpl: require('ws'), url: buildWsUrl(...) })`；失败时把错误发给所有窗口，选择器显示「先运行 npm start」+ 重试。
- 打开选择器后收到 `open` 发 `{type:'list'}` 与 `{type:'projects'}`；把 `sessions` + `projects` 合成 `buildPicker({projects, sessions})` 推给选择器（`bridge:meta`，`{type:'picker'}`）。
- 选「最近目录」或「其他目录」+ agent → 发 `create`；等 `session` 消息后用返回的 id 开窗口（并关掉发起它的选择器）。
- 选「接回」→ `openSessionWindow(id)`，窗口加载完发 `attach`。
- 广播 `{type:'session', session}`：未知 id 且状态不在 `closed`/`closing` → 自动开窗（手机建群后电脑自动弹窗）；已开窗则转发给该窗口。
- `data` / `replay` 按 `sessionId` 只发给对应窗口的 feed；`sessions` / `projects` 只发给选择器。
- `bridge:input` / `resize` / `close-session` / `restart` / `detach` 转成同名 IPC 消息发出（带窗口的 sessionId）。
- 关窗：`win.on('close', e => …)`；若会话状态是 `closed`/`closing` 或窗口是被程序销毁的，直接放行；否则 `preventDefault`，`dialog.showMessageBox` 用 `closeChoices(status)`（`noLink: true`，文案：「结束会话会解散群；只关窗口手机照常可发。」），按选择发 `close` / `detach` 后再 `destroy()`。
- 收到某窗口对应会话 `status === 'closed'` → 转发「会话已结束」覆盖层，3 秒后 `destroy()`（`destroying` 标记避免再弹确认）。
- 窗口加载 `session.html`，全部窗口关完自动退出（`window-all-closed` → `app.quit()`，Windows）。

- [ ] **步骤 3：改 `package.json`**

```json
"main": "app/main.js",
"scripts": {
  "start": "node bin/daemon.js",
  "window": "electron .",
  …
}
```

- [ ] **步骤 4：验证**

运行：`npm test`（守护进程不受影响）
预期：PASS。
运行：`npm start`（另开一个终端，若守护进程没在跑）后 `npm run window`，选择器应列出最近目录；选中后弹出会话窗口，能看到终端画面并输入。人工确认后关掉窗口。

- [ ] **步骤 5：Commit**

```bash
git add app/main.js app/preload.js package.json package-lock.json
git commit -m "feat: Electron 主进程按会话分窗并接入本地通道"
```

---

### 任务 7：选择器与会话窗口界面

**文件：**
- 创建：`app/renderer/picker.html`、`picker.css`、`picker.js`、`session.html`、`session.css`、`session.js`

- [ ] **步骤 1：先加载 frontend-design 技能**，再写样式；风格要克制、像桌面工具，不堆渐变和圆角卡片。
- [ ] **步骤 2：选择器**
  - 三段：`最近使用`（`picker.recent`）、`接回正在跑的会话`（`picker.resumable`）、底部 `[其他目录…]` + `claude` / `codex` 按钮。
  - `↑`/`↓` 移动高亮（跨分组连续），`Enter` 激活，`Esc` 调 `window.close()`（preload 未暴露 close，用 `window.close()` 在渲染进程即可关闭自己的窗口）。
  - 激活最近目录行 → `bridge.pickerAction({action:'create', cwd, agent})`；接回行 → `{action:'attach', sessionId}`；其他目录 → `bridge.chooseDir()` 后记住路径，再点 agent 按钮 `{action:'create', cwd, agent}`。
  - 收到 `bridge:meta` 的 `{type:'error'}` 就在顶部红条显示；`{type:'picker'}` 重绘列表。
- [ ] **步骤 3：会话窗口**
  - 加载 `node_modules/@xterm/xterm/lib/xterm.js`、`css/xterm.css`、`node_modules/@xterm/addon-fit/lib/addon-fit.js`（相对 `app/renderer/` 的路径）。
  - `new Terminal({fontFamily:'Consolas, monospace', fontSize:14, cursorBlink:true})`，`FitAddon`，`term.onData(d => bridge.input(d))`，`ResizeObserver` → `fit()` → `bridge.resize(cols, rows)`。
  - `bridge.onEffect`：`reset` → `term.reset()`；`write` → `term.write(data)`；`session` → 更新标题 `formatTitle` 与状态栏；`error` → 状态栏红字；`transport` → `formatSyncLine`（状态映射 `open→同步`、`connecting→连接中`、`reconnecting→重连中`、`closed→已断开`）。
  - `session.status` 变 `closed` → 全屏半透明覆盖「会话已结束」；`error`/`interrupted` → 覆盖层 + 「重来」按钮 → `bridge.restart()`；收到 `restarted ok` → 清覆盖层（主进程随后补 `attach`）。
  - CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`。
- [ ] **步骤 4：验证**

运行：`npm run window`，逐项手动核对：新建、接回、手机建群自动弹窗、只关窗口后群里收到提示、结束会话解散群、进程崩溃后「重来」、会话被手机结束后窗口 3 秒自动关闭。

- [ ] **步骤 5：Commit**

```bash
git add app/renderer
git commit -m "feat: 选择器窗口与 xterm 会话窗口"
```

---

### 任务 8：打包脚本与发布 0.3.0

**文件：**
- 修改：`package.json`、`CHANGELOG.md`

- [ ] **步骤 1：安装打包器**

运行：`npm install --save-dev @electron/packager`
预期：`package.json` 出现 `@electron/packager`，`npm test` 仍全绿。

- [ ] **步骤 2：加 `pack` 脚本**

```json
"pack": "electron-packager . feishu-bridge-window --platform=win32 --arch=x64 --out=dist --overwrite --ignore=\"^/(src|test|docs|scripts|logs|state|dist)$\""
```

- [ ] **步骤 3：打包并冒烟**

运行：`npm run pack`
预期：生成 `dist/feishu-bridge-window-win32-x64/feishu-bridge-window.exe`；双击（或命令行启动）能连上正在运行的守护进程、正常开窗。

- [ ] **步骤 4：更新 CHANGELOG 与版本**

新增 `## [0.3.0] - 2026-11-28`，写清：电脑端镜像窗口（选择器、xterm、接回会话、关闭确认、重来）、IPC 新增 `restart` / `detach`、打包脚本；已知限制保留「窗口断开 10 分钟回收 PTY 未做」。`package.json` 版本改 `0.3.0`。

- [ ] **步骤 5：全量验证 + 发布**

运行：`npm test` 与 `npm run test:e2e`
预期：全绿，测试数在 533 基础上增加本计划的用例。
提交、打 `v0.3.0` 注释标签，按仓库既有方式推送（见 CLAUDE.md 的 GitHub 推送方法）。

---

## 验收对照

| 验收条目 | 本计划落点 |
|---|---|
| 双击图标 → 选择器 | 任务 6/7 |
| 选目录 + agent → 同群窗口 | 任务 6/7 |
| 手机建群 → 电脑自动弹窗 | 任务 6（未知 sessionId 自动开窗） |
| 接回已有会话 | 任务 2/6/7 |
| 只关窗口 → 群里收到提示 | 任务 4/5/6 |
| 结束会话先确认 | 任务 3/6 |
| 崩溃 → 重来 | 任务 4/5/7 |
| 强杀窗口不杀 PTY | 任务 6（窗口与 PTY 无生命周期绑定） |
