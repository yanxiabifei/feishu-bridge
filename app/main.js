// Electron 主进程：窗口只是 daemon 的又一个客户端。
// 这里唯一的长连接由主进程持有，按 sessionId 把消息分给对应窗口，窗口之间互不打扰。
const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage,
} = require('electron');
const WebSocket = require('ws');
const { readEndpoint, buildWsUrl } = require('./lib/endpoint');
const { locateEndpointFile, locateStateDir } = require('./lib/endpointFile');
const { parseLaunchArgs } = require('./lib/launchArgs');
const startup = require('./lib/startup');
const { writeJsonAtomic } = require('../src/store');
const { createDaemonClient } = require('./lib/client');
const { createSessionFeed } = require('./lib/sessionFeed');
const { buildPicker } = require('./lib/pickerModel');
const { closeChoices } = require('./lib/closePrompt');
const { pickErrorTarget } = require('./lib/errorRoute');
const { formatTitle, formatSyncLine } = require('./lib/format');

const ACTIVE = (status) => !['closed', 'closing'].includes(status);
const CREATE_TIMEOUT_MS = 60000;

// 启动参数：daemon 拉起窗口时带 --session，开机自启时带 --hidden（只进托盘）。
const launch = parseLaunchArgs(process.argv);

const windows = new Map();        // webContents.id → { win, kind, sessionId, feed, … }
const sessionWindows = new Map(); // sessionId → BrowserWindow
const sessions = new Map();       // sessionId → 最新的会话记录
const knownSessions = new Set();  // 见过 id：只有「新的」会话才自动弹窗
let projects = { aliases: {}, default: null };
let client = null;
let everOpen = false;
let endpointError = null;
let creatingPicker = null;        // 正在等 create 回包的选择器
let createTimer = null;           // create 等太久就报错，别让选择器一直转圈
let tray = null;                  // 关窗后程序还在：托盘是唯一的入口
let quitting = false;             // 只有用户点「退出」才真的走

function entryOf(win) {
  return win && !win.isDestroyed() ? windows.get(win.webContents.id) : null;
}

function sendEffect(entry, effect) {
  if (entry && !entry.win.isDestroyed()) entry.win.webContents.send('bridge:effect', effect);
}

function sendMeta(entry, meta) {
  if (entry && !entry.win.isDestroyed()) entry.win.webContents.send('bridge:meta', meta);
}

function send(msg) {
  return Boolean(client && client.send(msg));
}

function transportState() {
  // 端点文件还没写出来（开机自启比 daemon 早）不算「断开」：重连循环会一直重读，
  // 界面显示「连接中」才符合事实，也不会让人以为要手动处理。
  if (!client) return 'connecting';
  if (client.state === 'open') return 'synced';
  if (client.state === 'closed') return 'closed';
  return everOpen ? 'reconnecting' : 'connecting';
}

function pickerPayload(entry) {
  return {
    type: 'picker',
    picker: buildPicker({ projects, sessions: [...sessions.values()] }),
    transport: transportState(),
    error: endpointError,
    hint: entry && entry.error ? entry.error : null,
  };
}

function pushPicker(entry) {
  if (!entry || entry.kind !== 'picker') return;
  sendMeta(entry, pickerPayload(entry));
}

function pushPickers() {
  for (const entry of windows.values()) if (entry.kind === 'picker') pushPicker(entry);
}

function sessionMeta(entry) {
  const session = sessions.get(entry.sessionId) || entry.feed.getState().selected;
  return {
    type: 'session-meta',
    title: formatTitle(session),
    syncLine: formatSyncLine({ session, state: transportState() }),
    transport: transportState(),
    status: session ? session.status : null,
  };
}

function pushSessionMeta(entry) {
  sendMeta(entry, sessionMeta(entry));
}

function createClient() {
  const file = locateEndpointFile({ appPath: app.getAppPath() });
  // 端点文件可能还不存在（开机自启时 daemon 还没起）。只把原因当提示记下来，
  // 客户端照建：重连循环每次都会重读端点，daemon 一起来就自动接上。
  try {
    readEndpoint({ file });
    endpointError = null;
  } catch (err) {
    endpointError = String((err && err.message) || err);
  }
  client = createDaemonClient({
    WebSocketImpl: WebSocket,
    // daemon 每次重启都会换 token（甚至换端口），端点必须每次（重）连时重读；
    // 启动时读一次就记住，会在 daemon 重启后拿着废 token 一直撞墙。
    url: () => buildWsUrl(readEndpoint({ file })),
    log: console,
    onTransportChange: onTransportChange,
  });
  client.on(onDaemonMessage);
  client.connect();
  return client;
}

function ensureClient() {
  return client || createClient();
}

function rebuildClient() {
  if (client) {
    const old = client;
    client = null;
    try { old.close(); } catch { /* 已经断了 */ }
  }
  everOpen = false;
  endpointError = null;
  return ensureClient();
}

function requestLists(entry) {
  const c = ensureClient();
  if (!c || c.state !== 'open') {
    pushPicker(entry);
    return;
  }
  c.send({ type: 'list' });
  c.send({ type: 'projects' });
}

function onTransportChange(state) {
  if (state === 'open') {
    everOpen = true;
    endpointError = null;
    // 先拉一次全量会话：knownSessions 有了底，才不会把「已有会话的更新」
    // 当成新会话又弹一个窗口。常驻（--hidden）模式下没有选择器替我们做这件事。
    send({ type: 'list' });
    for (const entry of windows.values()) {
      if (entry.kind === 'picker') requestLists(entry);
    }
    // 断线期间错过的输出无法逐条补，重新 attach 拿一份整屏快照
    for (const entry of windows.values()) {
      if (entry.kind !== 'session' || !entry.loaded) continue;
      entry.awaiting = 'attach';
      send(entry.feed.select(entry.sessionId));
    }
  }
  for (const entry of windows.values()) {
    if (entry.kind === 'picker') pushPicker(entry);
    else if (entry.kind === 'session') pushSessionMeta(entry);
  }
}

// 把窗口真正拉到用户眼前：Windows 前台锁有时只让窗口在任务栏闪，
// 临时置顶一下再取消是最省事、又不限制用户操作的写法。
function raiseWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.setAlwaysOnTop(false);
}

function openSessionWindow(sessionId) {
  const existing = sessionWindows.get(sessionId);
  if (existing && !existing.isDestroyed()) {
    raiseWindow(existing);
    return existing;
  }
  const session = sessions.get(sessionId);
  const win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 520,
    minHeight: 320,
    show: false,
    backgroundColor: '#12110f',
    title: formatTitle(session),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const entry = {
    win,
    kind: 'session',
    sessionId,
    feed: createSessionFeed(),
    loaded: false,
    awaiting: null,      // 等哪个请求的回包：create / attach / restart
    closingPrompt: false,
    destroying: false,   // 程序主动销毁，close 事件直接放行
    ending: false,       // 已经报过「会话已结束」，3 秒后自毁
    endingTimer: null,
    destroyAfterPrompt: false, // 自毁时间到了但确认框还开着，等框关掉再销毁
  };
  const id = win.webContents.id;
  windows.set(id, entry);
  sessionWindows.set(sessionId, win);

  win.loadFile(path.join(__dirname, 'renderer', 'session.html'));
  win.once('ready-to-show', () => raiseWindow(win));
  win.webContents.on('did-finish-load', () => {
    entry.loaded = true;
    pushSessionMeta(entry);
    if (client && client.state === 'open') {
      entry.awaiting = 'attach';
      client.send(entry.feed.select(sessionId));
    }
  });
  win.on('close', (e) => onSessionClose(entry, e));
  win.on('closed', () => {
    windows.delete(id);
    if (sessionWindows.get(sessionId) === win) sessionWindows.delete(sessionId);
  });
  ensureClient();
  return win;
}

async function onSessionClose(entry, event) {
  if (entry.destroying) return;
  // 点「退出」时别一个个弹确认框：直接放行
  if (quitting) {
    entry.destroying = true;
    return;
  }
  const session = sessions.get(entry.sessionId);
  const status = session ? session.status : 'closed';
  if (!session || !ACTIVE(status)) {
    entry.destroying = true;
    return;
  }
  event.preventDefault();
  if (entry.closingPrompt) return;
  entry.closingPrompt = true;

  const choice = closeChoices(status);
  const indexOf = (id) => Math.max(0, choice.buttons.findIndex((b) => b.id === id));
  let response = indexOf(choice.cancelId);
  try {
    const res = await dialog.showMessageBox(entry.win, {
      type: 'question',
      noLink: true,
      title: '关闭窗口',
      message: `关闭「${formatTitle(session)}」`,
      detail: '结束会话会解散群；只关窗口手机照常可发。',
      buttons: choice.buttons.map((b) => b.label),
      defaultId: indexOf(choice.defaultId),
      cancelId: indexOf(choice.cancelId),
    });
    response = res.response;
  } catch {
    response = indexOf('cancel');
  }
  entry.closingPrompt = false;
  if (entry.win.isDestroyed()) return;

  // 确认框开着的时候会话自己结束了（群被解散），3 秒自毁计时器把它挂在了这里：
  // 现在框没了，直接销毁，不用再问一次。
  if (entry.destroyAfterPrompt) {
    entry.destroyAfterPrompt = false;
    entry.destroying = true;
    entry.win.destroy();
    return;
  }

  const picked = choice.buttons[response] || { id: 'cancel' };
  if (picked.id === 'cancel') return;
  const sent = send({ type: picked.id === 'close' ? 'close' : 'detach', sessionId: entry.sessionId });
  if (!sent) {
    // 断线时窗口先关掉，daemon 永远收不到「结束会话」，用户却以为群已经解散。
    // 留在原地报错，等连上再关一次。
    sendEffect(entry, { type: 'error', message: '后台连接已断开，这次关闭没有生效，请稍后再试。' });
    return;
  }
  entry.destroying = true;
  entry.win.destroy();
}

function closePicker(entry) {
  if (!entry || entry.win.isDestroyed()) return;
  entry.win.close();
}

function clearCreateWait() {
  if (!createTimer) return;
  clearTimeout(createTimer);
  createTimer = null;
}

// create 是个来回：daemon 不吭声时选择器会一直转圈，看门狗到点就报错。
function startCreateWait(entry) {
  clearCreateWait();
  createTimer = setTimeout(() => {
    createTimer = null;
    if (creatingPicker !== entry || entry.win.isDestroyed()) return;
    creatingPicker = null;
    entry.awaiting = null;
    entry.error = '后台 60 秒没有回应，建会话可能卡住了。看看终端里 npm start 的输出。';
    pushPicker(entry);
  }, CREATE_TIMEOUT_MS);
  if (createTimer.unref) createTimer.unref();
}

function onSessionMessage(session) {
  if (!session || !session.id) return;
  const isNew = !knownSessions.has(session.id);
  knownSessions.add(session.id);
  sessions.set(session.id, session);

  if (isNew && ACTIVE(session.status)) {
    // 手机建群后电脑自动弹窗；电脑自己创建的会话同样走这里
    openSessionWindow(session.id);
    if (creatingPicker) {
      closePicker(creatingPicker);
      creatingPicker = null;
      clearCreateWait();
    }
  }

  const entry = entryOf(sessionWindows.get(session.id));
  if (!entry) return;
  for (const effect of entry.feed.handle({ type: 'session', session })) sendEffect(entry, effect);
  pushSessionMeta(entry);
  if (!ACTIVE(session.status)) {
    if (!entry.ending) {
      entry.ending = true;
      sendEffect(entry, { type: 'ended' });
      entry.endingTimer = setTimeout(() => {
        entry.endingTimer = null;
        if (entry.win.isDestroyed() || !entry.ending) return;
        // 用户正开着「关闭窗口」确认框，别在底下偷偷销毁；等框关掉再说
        if (entry.closingPrompt) {
          entry.destroyAfterPrompt = true;
          return;
        }
        entry.destroying = true;
        entry.win.destroy();
      }, 3000);
    }
  } else if (entry.ending) {
    // 会话又活了（中断后重来成功）：撤掉结束倒计时，否则窗口 3 秒后照旧自毁
    entry.ending = false;
    entry.destroyAfterPrompt = false;
    if (entry.endingTimer) {
      clearTimeout(entry.endingTimer);
      entry.endingTimer = null;
    }
  }
}

function routeToSession(sessionId, msg) {
  const entry = entryOf(sessionWindows.get(sessionId));
  if (!entry) return;
  if (msg.type === 'replay') entry.awaiting = null;
  for (const effect of entry.feed.handle(msg)) sendEffect(entry, effect);
  if (msg.type === 'replay') pushSessionMeta(entry);
}

function routeError(msg) {
  const text = String((msg && msg.message) || '未知错误');
  const target = pickErrorTarget([...windows.values()].filter((e) => e.awaiting), msg);
  if (target) {
    target.awaiting = null;
    if (target.kind === 'picker') {
      if (creatingPicker === target) {
        creatingPicker = null;
        clearCreateWait();
      }
      target.error = text;
      pushPicker(target);
    } else {
      sendEffect(target, { type: 'error', message: text });
    }
    return;
  }
  // 分不清是谁的错时只在选择器上报：往每个会话窗口里塞一条不相干的红字更糟。
  for (const entry of windows.values()) {
    if (entry.kind !== 'picker') continue;
    entry.error = text;
    pushPicker(entry);
  }
  console.warn('bridge.unrouted_error', text);
}

function onDaemonMessage(msg) {
  const type = msg && msg.type;
  if (!type || type === 'transport') return;
  if (type === 'sessions') {
    sessions.clear();
    for (const s of Array.isArray(msg.list) ? msg.list : []) {
      if (!s || !s.id) continue;
      sessions.set(s.id, s);
      knownSessions.add(s.id);
    }
    pushPickers();
    return;
  }
  if (type === 'projects') {
    projects = msg.projects || projects;
    pushPickers();
    return;
  }
  if (type === 'session') { onSessionMessage(msg.session); return; }
  if (type === 'replay' || type === 'data') { routeToSession(msg.sessionId, msg); return; }
  if (type === 'restarted') {
    const entry = entryOf(sessionWindows.get(msg.sessionId));
    if (!entry) return;
    entry.awaiting = null;
    if (msg.ok && client && client.state === 'open') {
      entry.awaiting = 'attach';
      client.send(entry.feed.select(msg.sessionId));
    }
    sendEffect(entry, { type: 'restarted', ok: Boolean(msg.ok) });
    return;
  }
  if (type === 'detached') {
    const entry = entryOf(sessionWindows.get(msg.sessionId));
    if (entry) entry.destroying = true;
    return;
  }
  if (type === 'error') { routeError(msg); return; }
}

function openPicker() {
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 420,
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const entry = { win, kind: 'picker', sessionId: null, feed: null, error: null };
  const id = win.webContents.id;
  windows.set(id, entry);
  win.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  win.webContents.on('did-finish-load', () => {
    pushPicker(entry);
    requestLists(entry);
  });
  win.on('closed', () => {
    windows.delete(id);
    if (creatingPicker === entry) {
      creatingPicker = null;
      clearCreateWait();
    }
  });
  return win;
}

ipcMain.on('bridge:input', (event, data) => {
  const entry = windows.get(event.sender.id);
  if (!entry || entry.kind !== 'session' || typeof data !== 'string') return;
  send({ type: 'input', sessionId: entry.sessionId, data });
});

ipcMain.on('bridge:resize', (event, payload) => {
  const entry = windows.get(event.sender.id);
  if (!entry || entry.kind !== 'session') return;
  const cols = Number(payload && payload.cols);
  const rows = Number(payload && payload.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
  send({ type: 'resize', sessionId: entry.sessionId, cols, rows });
});

ipcMain.on('bridge:restart', (event) => {
  const entry = windows.get(event.sender.id);
  if (!entry || entry.kind !== 'session') return;
  entry.awaiting = 'restart';
  if (!send({ type: 'restart', sessionId: entry.sessionId })) entry.awaiting = null;
});

ipcMain.on('bridge:detach', (event) => {
  const entry = windows.get(event.sender.id);
  if (!entry || entry.kind !== 'session') return;
  send({ type: 'detach', sessionId: entry.sessionId });
});

ipcMain.on('bridge:close-session', (event) => {
  const entry = windows.get(event.sender.id);
  if (!entry || entry.kind !== 'session') return;
  send({ type: 'close', sessionId: entry.sessionId });
});

ipcMain.on('bridge:picker', (event, item) => {
  const entry = windows.get(event.sender.id);
  if (!entry || entry.kind !== 'picker' || !item || typeof item !== 'object') return;
  if (item.action === 'attach' && item.sessionId) {
    openSessionWindow(String(item.sessionId));
    closePicker(entry);
    return;
  }
  if (item.action === 'create' && typeof item.cwd === 'string' && item.cwd) {
    entry.awaiting = 'create';
    entry.error = null;
    creatingPicker = entry;
    const ok = send({ type: 'create', cwd: item.cwd, agent: item.agent === 'codex' ? 'codex' : 'claude' });
    if (!ok) {
      entry.awaiting = null;
      entry.error = endpointError || (client ? '后台守护进程尚未连接' : '先运行 npm start 启动后台守护进程');
      creatingPicker = null;
      pushPicker(entry);
    } else {
      startCreateWait(entry);
    }
  }
});

ipcMain.handle('bridge:choose-dir', async (event) => {
  const entry = windows.get(event.sender.id);
  if (!entry) return null;
  const res = await dialog.showOpenDialog(entry.win, {
    title: '选择会话目录',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.on('bridge:reconnect', (event) => {
  const entry = windows.get(event.sender.id);
  rebuildClient();
  if (entry) {
    entry.error = null;
    pushPicker(entry);
    requestLists(entry);
  }
});

// ---- 常驻与开机启动 ------------------------------------------------------
// 窗口和 daemon 共用 state/config.json：这里只增改自己那几个键，别把 daemon 的配置覆盖掉。

function stateConfigFile() {
  return path.join(locateStateDir({ appPath: app.getAppPath() }), 'config.json');
}

function readStateConfig() {
  const file = stateConfigFile();
  if (!fs.existsSync(file)) return {};
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('config.json 不是 JSON 对象');
  return obj;
}

function updateStateConfig(patch) {
  try {
    writeJsonAtomic(stateConfigFile(), { ...readStateConfig(), ...patch });
  } catch (err) {
    // 配置坏了/写不进去都不能挡住窗口启动：开机自启只是锦上添花
    console.warn('app.config_write_failed', String((err && err.message) || err));
  }
}

// 打包版每次启动都登记一遍（幂等）：装到别的目录、注册表被清理都能自愈。
// 用户取消过（windowAutostart=false）就不再补登记，尊重选择。
function initPrefs() {
  if (!app.isPackaged) return;
  let cfg;
  try {
    cfg = readStateConfig();
  } catch (err) {
    console.warn('app.config_read_failed', String((err && err.message) || err));
    return;
  }
  updateStateConfig({ windowExe: process.execPath });
  if (cfg.windowAutostart !== false && !startup.isEnabled()) {
    startup.setEnabled({ exePath: process.execPath, enabled: true });
  }
}

function onToggleAutostart(checked) {
  const actual = startup.setEnabled({ exePath: process.execPath, enabled: checked });
  // 记下用户的选择本身，而不只是注册表状态：否则下次启动又会「贴心地」补登记
  updateStateConfig({ windowAutostart: actual });
  refreshTrayMenu();
  if (actual !== checked) {
    dialog.showMessageBox({
      type: 'warning',
      message: checked ? '开机启动没能打开' : '开机启动没能关闭',
      detail: '注册表写入被拒绝了，可能是权限或安全软件拦截。',
    }).catch(() => {});
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const supported = app.isPackaged; // 开发模式不碰注册表
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开选择器', click: () => showPicker() },
    { type: 'separator' },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: supported && startup.isEnabled(),
      enabled: supported,
      click: (item) => onToggleAutostart(Boolean(item.checked)),
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]));
}

function createTray() {
  if (tray) return tray;
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (icon.isEmpty()) icon = nativeImage.createEmpty(); // 图标丢了也要能起来，菜单还在
  tray = new Tray(icon);
  tray.setToolTip('飞书桥');
  tray.on('click', () => showPicker());
  tray.on('double-click', () => showPicker());
  refreshTrayMenu();
  return tray;
}

function showPicker() {
  const existing = [...windows.values()].find((e) => e.kind === 'picker' && !e.win.isDestroyed());
  if (existing) {
    raiseWindow(existing.win);
    return existing.win;
  }
  return openPicker();
}

function quitApp() {
  quitting = true;
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 第二次启动（开机自启时用户又点了图标、或 daemon 拉起窗口时已有实例）不再新开进程：
  // 带着 --session 就把那个会话窗口拉起来，否则把选择器拉到前面。
  app.on('second-instance', (event, argv) => {
    if (!app.isReady()) return;
    const args = parseLaunchArgs(Array.isArray(argv) ? argv : []);
    if (args.sessionId) {
      openSessionWindow(args.sessionId);
      return;
    }
    showPicker();
  });
  app.whenReady().then(() => {
    initPrefs();
    createTray();
    // 常驻进程先连上：daemon 靠连接数判断窗口在不在线，在线就不会重复拉起
    ensureClient();
    if (launch.sessionId) openSessionWindow(launch.sessionId);
    else if (!launch.hidden) showPicker();
  });
  // 关窗 ≠ 退出：收进托盘常驻，手机建群还能弹窗。真正退出走托盘菜单。
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (client) {
      const c = client;
      client = null;
      try { c.close(); } catch { /* 已经断了 */ }
    }
  });
  app.on('activate', () => showPicker());
}
