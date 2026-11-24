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
    screenArgs: null, queueArgs: null,
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
    screenFactory: (o) => { calls.screenArgs = o; return { fake: true }; },
    queueFactory: (o) => { calls.queueArgs = o; return { fake: true }; },
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
  assert.deepStrictEqual(calls.screenArgs, { cols: 120, rows: 30 });

  assert.strictEqual(wrapped.queueFactory, deps.queueFactory);
  assert.deepStrictEqual(wrapped.queueFactory({ limit: 7 }), { fake: true });
  assert.deepStrictEqual(calls.queueArgs, { limit: 7 });
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
