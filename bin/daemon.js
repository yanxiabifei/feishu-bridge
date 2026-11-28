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
const { loadProjects, renameAlias } = require('../src/projects');
const { createControl } = require('../src/control');
const { createApi } = require('../src/feishu/api');
const { createFeishuWs } = require('../src/feishu/ws');
const { parseMessage, parseCardAction, parseChatId } = require('../src/feishu/events');
const { buildLaunch } = require('../src/agent/launcher');
const { createScreen } = require('../src/screen');
const { createQueue } = require('../src/session/queue');
const { createPtySession } = require('../src/session/ptySession');
const { createManager } = require('../src/session/manager');
const { startIpc } = require('../src/ipc');
const { createWindowLauncher } = require('../src/windowLaunch');

const DEFAULT_PORT = 47831;
const DEFAULT_SWEEP_MS = 30000;
const DEFAULT_DEGRADED_SWEEP_MS = 5000;

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
  const controlFactory = deps.controlFactory || createControl;
  const ptySessionFactory = deps.ptySessionFactory || createPtySession;
  const screenFactory = deps.screenFactory || createScreen;
  const queueFactory = deps.queueFactory || createQueue;
  const windowLauncherFactory = deps.windowLauncherFactory || createWindowLauncher;
  const launchFn = deps.launchFn || buildLaunch;
  const ptyModule = deps.ptyModule || pty;
  const randomToken = deps.randomToken || (() => crypto.randomBytes(16).toString('hex'));

  pathsApi.ensureDirs();
  const log = deps.log || logger({ dir: pathsApi.LOGS });

  const config = loadConfigFn(pathsApi.CONFIG);
  const secretStore = secretStoreFactory({ file: pathsApi.SECRET, log });
  const appSecret = secretStore.load();
  if (!config.appId || !appSecret) throw new Error('缺少飞书凭据：先运行 npm run setup');
  // ownerOpenId 空着时，manager/control 的守卫没法分辨「谁是你」，群里的任何人都能指挥本机。
  // 宁可起不来，也不能悄悄对所有人开放。
  if (!config.ownerOpenId) {
    throw new Error('缺少 ownerOpenId：没有它分不清消息是不是你发的，先运行 npm run setup 补齐配置');
  }
  log.redactor?.add(appSecret);

  const startedAt = Date.now();

  const getProjectsFn = deps.getProjectsFn
    || (() => loadProjects({ file: pathsApi.PROJECTS, defaultCwd: config.defaultCwd }));

  const store = storeFactory({ file: pathsApi.SESSIONS, log });
  store.load();
  const api = apiFactory({ appId: config.appId, appSecret, fetchImpl: deps.fetchImpl });

  // 窗口离线时的兜底：手机建群直接拉起窗口并接进该会话。在线时走 IPC 广播，这里不插手。
  const windowLauncher = windowLauncherFactory({ config, root: pathsApi.ROOT, log });

  let manager = null;

  function handleClientMessage(msg, ws) {
    const type = msg && msg.type;
    if (type === 'ping') { ipc.send(ws, { type: 'pong' }); return; }
    if (!manager) { ipc.send(ws, { type: 'error', message: '会话管理器未就绪' }); return; }
    if (type === 'list') { ipc.send(ws, { type: 'sessions', list: manager.list() }); return; }
    if (type === 'projects') {
      // 项目选择器的「最近使用」：别名表 + 默认目录
      let projects = { aliases: {}, default: null };
      try {
        projects = getProjectsFn() || projects;
      } catch (err) {
        log.warn('读取项目表失败', { message: errText(err) });
      }
      ipc.send(ws, { type: 'projects', projects });
      return;
    }
    if (type === 'attach') {
      const found = manager.list().find((s) => s.id === msg.sessionId);
      if (!found) {
        ipc.send(ws, { type: 'error', message: '会话不存在', sessionId: msg.sessionId, replyTo: 'attach' });
        return;
      }
      // 先回记录、再回画面快照。客户端在收到 replay 之前收到的实时 data 一律丢弃，
      // 之后到达的 data 在 replay 之后，顺序上不会重放。
      ipc.send(ws, { type: 'session', session: found });
      ipc.send(ws, { type: 'replay', sessionId: msg.sessionId, data: manager.replayFor(msg.sessionId) });
      return;
    }
    if (type === 'input') { manager.onPcKeys({ sessionId: msg.sessionId, data: msg.data }); return; }
    if (type === 'resize') { manager.onPcResize({ sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows }); return; }
    if (type === 'create') {
      manager.createFromPc({ cwd: msg.cwd, agent: msg.agent })
        .then((record) => ipc.send(ws, { type: 'session', session: record }))
        .catch((err) => ipc.send(ws, { type: 'error', message: errText(err), replyTo: 'create' }));
      return;
    }
    if (type === 'close') {
      manager.closeSession(msg.sessionId, { reason: '窗口关闭', notify: true })
        .catch((err) => log.warn('关闭会话失败', { sessionId: msg.sessionId, message: errText(err) }));
      return;
    }
    if (type === 'restart') {
      manager.restartSession(msg.sessionId)
        .then((res) => {
          if (res && res.error) {
            ipc.send(ws, { type: 'error', message: res.error, sessionId: msg.sessionId, replyTo: 'restart' });
          } else {
            ipc.send(ws, { type: 'restarted', sessionId: msg.sessionId, ok: Boolean(res && res.ok) });
          }
        })
        .catch((err) => ipc.send(ws, {
          type: 'error', message: errText(err), sessionId: msg.sessionId, replyTo: 'restart',
        }));
      return;
    }
    if (type === 'detach') {
      manager.notifyDetached(msg.sessionId)
        .catch((err) => log.warn('窗口关闭告知失败', { sessionId: msg.sessionId, message: errText(err) }))
        .finally(() => ipc.send(ws, { type: 'detached', sessionId: msg.sessionId }));
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
      onClientClose: () => {
        log.info('window.closed', { clients: ipc.clientCount() });
      },
    },
  });

  manager = managerFactory({
    config,
    api,
    store,
    log,
    ipc,
    hooksDir: pathsApi.HOOKS,
    getProjects: getProjectsFn,
    // 窗口在线时 Ipc 广播已经会让它自己弹出来；只有离线才需要 daemon 亲自拉起进程。
    onSessionCreated: (record) => windowLauncher.launch(record.id, ipc.clientCount()),
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

  const control = controlFactory({
    api,
    listSessions: () => manager.list(),
    closeSession: (id, opts) => manager.closeSession(id, opts),
    getProjects: getProjectsFn,
    renameAlias: (args) => renameAlias({ file: pathsApi.PROJECTS, ...args }),
    // ws 在后面声明，但闭包只在收到「状态」时才执行，那时已经初始化完毕
    getHealth: () => ({
      startedAt,
      now: Date.now(),
      pid: process.pid,
      ipcPort: ipc.port,
      ws: typeof ws.status === 'function' ? ws.status() : null,
      sessions: manager.list(),
    }),
    ownerOpenId: config.ownerOpenId,
    log,
  });

  const ws = wsFactory({
    appId: config.appId,
    appSecret,
    log,
    handlers: {
      onMessage: (evt) => {
        const m = parseMessage(evt);
        if (!m) return;                                        // 机器人自己发的，防回环
        // 群里没 @ 就当闲聊；但图片/文件本身带不了 @，只看 @ 会把群里发的截图全丢掉
        if (m.chatType !== 'p2p' && !m.mentioned && !m.media) return;
        if (m.unsupported) {
          api.sendText(m.chatId, `暂不支持 ${m.unsupported} 类型的消息，发文字、图片或文件吧。`)
            .catch((err) => log.warn('类型提示发送失败', { chatId: m.chatId, message: errText(err) }));
          return;
        }
        if (m.chatType === 'p2p') {                            // 私聊 = 总控面板，绝不建会话
          // 面板只认文字指令；附件悄悄丢掉会让人以为桥坏了
          if (m.media) {
            api.sendText(m.chatId, '私聊只用于总控面板。图片/文件发到对应的会话群，不用 @ 我。')
              .catch((err) => log.warn('附件提示发送失败', { chatId: m.chatId, message: errText(err) }));
            return;
          }
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
    // 长连接进了终态就不会再自己重连，手机发来的消息再也进不来。
    // HTTP 通道通常还活着，主动推一条，免得「以为桥还在，其实没人听」。
    onTerminal: async (err) => {
      if (!config.ownerChatId) return;
      try {
        await api.sendText(
          config.ownerChatId,
          `⚠️ 飞书长连接已断开且不再自动重连：${errText(err)}\n在本机重新运行 npm start 恢复。`,
        );
      } catch (sendErr) {
        log.warn('断线通知发送失败', { message: errText(sendErr) });
      }
    },
  });

  let timer = null;
  let alive = false;

  // 长连接正常时解散事件即时到达，巡检只是「事件丢了」的保险，30 秒一次就够；
  // 断线/重连时事件收不到，巡检是唯一手段，降到 5 秒。
  // 延时在每轮巡检结束后重新算，所以断线后最多再等一轮才提速。
  function sweepDelay() {
    const sweepMs = config.sweepIntervalMs === undefined ? DEFAULT_SWEEP_MS : config.sweepIntervalMs;
    const degradedMs = config.sweepDegradedIntervalMs === undefined
      ? DEFAULT_DEGRADED_SWEEP_MS
      : config.sweepDegradedIntervalMs;
    let state = null;
    try {
      const s = typeof ws.status === 'function' ? ws.status() : null;
      state = s && s.state;
    } catch (err) {
      log.warn('读取长连接状态失败', { message: errText(err) });
    }
    return state && state !== 'connected' && degradedMs > 0 ? Math.min(degradedMs, sweepMs) : sweepMs;
  }

  // 上一轮跑完再排下一轮：断网时 tick() 卡住也不会堆出重叠的巡检
  function scheduleSweep() {
    timer = setTimeout(async () => {
      timer = null;
      try {
        await manager.tick();
      } catch (err) {
        log.warn('巡检失败', { message: errText(err) });
      }
      if (alive) scheduleSweep();
    }, sweepDelay());
    if (timer.unref) timer.unref();
  }

  async function start() {
    if (alive) return;
    alive = true;
    await manager.restoreAll();
    await ws.start();
    const sweepMs = config.sweepIntervalMs === undefined ? DEFAULT_SWEEP_MS : config.sweepIntervalMs;
    if (sweepMs > 0) scheduleSweep();
    log.info('daemon.started', { port: ipc.port, pid: process.pid });
  }

  async function stop() {
    alive = false;
    if (timer) { clearTimeout(timer); timer = null; }
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
  // 不预删 ipc.json：startIpc 绑定成功后会自己覆写，绑定失败则保留原文件。
  // 预删会让「输掉端口竞争的实例」把正在运行的实例的 ipc.json 删掉。
  let daemon;
  try {
    daemon = await createDaemon({ deps: { ...deps, log } });
    await daemon.start();
  } catch (err) {
    // 两个实例同时起来时，第二个会在 bind 时拿到 EADDRINUSE；
    // 此时再探活一次，对方已经在跑就当「已有实例」收摊，而不是报错崩掉。
    if (err && err.code === 'EADDRINUSE') {
      const other = await probeRunning({ ipcFile: pathsApi.IPC, fsApi, fetchImpl });
      if (other) {
        log.info('daemon.already_running', { pid: other.pid, port: other.port });
        return { started: false, pid: other.pid, port: other.port };
      }
    }
    throw err;
  }

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
