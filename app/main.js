// Electron 主进程：窗口只是 daemon 的又一个客户端。
// 这里唯一的长连接由主进程持有，按 sessionId 把消息分给对应窗口，窗口之间互不打扰。
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const WebSocket = require('ws');
const { readEndpoint, buildWsUrl } = require('./lib/endpoint');
const { locateEndpointFile } = require('./lib/endpointFile');
const { createDaemonClient } = require('./lib/client');
const { createSessionFeed } = require('./lib/sessionFeed');
const { buildPicker } = require('./lib/pickerModel');
const { closeChoices } = require('./lib/closePrompt');
const { pickErrorTarget } = require('./lib/errorRoute');
const { formatTitle, formatSyncLine } = require('./lib/format');

const ACTIVE = (status) => !['closed', 'closing'].includes(status);

const windows = new Map();        // webContents.id → { win, kind, sessionId, feed, … }
const sessionWindows = new Map(); // sessionId → BrowserWindow
const sessions = new Map();       // sessionId → 最新的会话记录
const knownSessions = new Set();  // 见过 id：只有「新的」会话才自动弹窗
let projects = { aliases: {}, default: null };
let client = null;
let everOpen = false;
let endpointError = null;
let creatingPicker = null;        // 正在等 create 回包的选择器

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
  if (endpointError) return 'closed';
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
  let endpoint;
  try {
    const file = locateEndpointFile({ appPath: app.getAppPath() });
    endpoint = readEndpoint({ file });
    endpointError = null;
  } catch (err) {
    endpointError = String((err && err.message) || err);
    pushPickers();
    return null;
  }
  client = createDaemonClient({
    WebSocketImpl: WebSocket,
    url: buildWsUrl(endpoint),
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

function openSessionWindow(sessionId) {
  const existing = sessionWindows.get(sessionId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
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
    ending: false,
  };
  const id = win.webContents.id;
  windows.set(id, entry);
  sessionWindows.set(sessionId, win);

  win.loadFile(path.join(__dirname, 'renderer', 'session.html'));
  win.once('ready-to-show', () => win.show());
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

  const picked = choice.buttons[response] || { id: 'cancel' };
  if (picked.id === 'cancel' || entry.win.isDestroyed()) return;
  entry.destroying = true;
  send({ type: picked.id === 'close' ? 'close' : 'detach', sessionId: entry.sessionId });
  entry.win.destroy();
}

function closePicker(entry) {
  if (!entry || entry.win.isDestroyed()) return;
  entry.win.close();
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
    }
  }

  const entry = entryOf(sessionWindows.get(session.id));
  if (!entry) return;
  for (const effect of entry.feed.handle({ type: 'session', session })) sendEffect(entry, effect);
  pushSessionMeta(entry);
  if (!ACTIVE(session.status) && !entry.ending) {
    entry.ending = true;
    sendEffect(entry, { type: 'ended' });
    if (!entry.closingPrompt) {
      setTimeout(() => {
        if (!entry.win.isDestroyed()) {
          entry.destroying = true;
          entry.win.destroy();
        }
      }, 3000);
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
      if (creatingPicker === target) creatingPicker = null;
      target.error = text;
      pushPicker(target);
    } else {
      sendEffect(target, { type: 'error', message: text });
    }
    return;
  }
  for (const entry of windows.values()) {
    if (entry.kind === 'picker') {
      entry.error = text;
      pushPicker(entry);
    } else {
      sendEffect(entry, { type: 'error', message: text });
    }
  }
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
    if (creatingPicker === entry) creatingPicker = null;
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) openPicker();
  });
  app.whenReady().then(() => openPicker());
  // Windows 上关掉所有窗口就是退出；没有托盘常驻的语义
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (client) {
      const c = client;
      client = null;
      try { c.close(); } catch { /* 已经断了 */ }
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openPicker();
  });
}
