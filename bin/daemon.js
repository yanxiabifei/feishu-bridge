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
