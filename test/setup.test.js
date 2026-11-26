const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSetup } = require('../src/setup');
const { createApi, FeishuError } = require('../src/feishu/api');
const { loadConfig, saveConfig } = require('../src/config');

const tempDirs = [];

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const P2P = {
  event_id: 'ev_1',
  message: { chat_id: 'oc_p2p', chat_type: 'p2p', content: '{"text":"你好"}' },
  sender: { sender_id: { open_id: 'ou_owner' } },
};

function fakeApi({ failToken, failBotInfo, failCreateGroup, failText, failDisband, failCard } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      getToken: async () => { if (failToken) throw failToken; return 't-1'; },
      getBotInfo: async () => {
        if (failBotInfo) throw failBotInfo;
        return { app_name: '飞书桥' };
      },
      createGroup: async (name, openIds) => {
        calls.push(['createGroup', name, openIds]);
        if (failCreateGroup) throw failCreateGroup;
        return 'oc_group';
      },
      sendText: async (chatId, text) => {
        calls.push(['sendText', chatId, text]);
        if (failText) throw failText;
        return 'om_1';
      },
      sendCard: async (chatId, card) => {
        calls.push(['sendCard', chatId, card]);
        if (failCard) throw failCard;
        return 'om_2';
      },
      disbandChat: async (chatId) => {
        calls.push(['disbandChat', chatId]);
        if (failDisband) throw failDisband;
      },
    },
  };
}

function harness({
  answers,
  api,
  evt = P2P,
  timeoutMs = 100,
  createApi: createApiImpl,
  createWs: createWsImpl,
  projectsPath,
  configPath,
  loadConfigFn,
  saveConfigFn,
  defaultCwd,
} = {}) {
  const saved = [];
  const configs = [];
  const lines = [];
  let apiCreated = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-setup-'));
  tempDirs.push(dir);
  const projectsFile = projectsPath || path.join(dir, 'projects.json');
  const configFile = configPath || path.join(dir, 'config.json');
  const effectiveDefaultCwd = defaultCwd || path.join(dir, 'default-cwd');
  const setup = createSetup({
    prompt: async () => answers.shift(),
    createApi: createApiImpl
      ? (opts) => { apiCreated += 1; return createApiImpl(opts); }
      : () => { apiCreated += 1; return api; },
    createWs: createWsImpl || (({ handlers }) => ({
      start() { setImmediate(() => { if (evt) handlers.onMessage(evt); }); },
      close() { lines.push('ws closed'); },
    })),
    loadConfigFn: loadConfigFn
      || (() => ({ appId: '', queueLimit: 20, defaultCwd: effectiveDefaultCwd })),
    saveConfigFn: saveConfigFn || ((file, config) => configs.push({ file, config })),
    secretStore: { save: (v) => saved.push(v) },
    configPath: configFile,
    projectsPath: projectsFile,
    timeoutMs,
    print: (line) => lines.push(line),
  });
  return {
    setup,
    saved,
    configs,
    lines,
    dir,
    configPath: configFile,
    defaultCwd: effectiveDefaultCwd,
    projectsPath: projectsFile,
    apiCreated: () => apiCreated,
  };
}

test('App ID 格式不对：不创建 API、不写配置', async () => {
  const h = harness({ answers: ['cli_bad', 'sec'], api: fakeApi().api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(h.apiCreated(), 0);
  assert.strictEqual(h.configs.length, 0);
  assert.strictEqual(fs.existsSync(h.projectsPath), false);
  assert.match(res.steps[0].detail, /cli_/);
});

test('getToken 失败：给出「发布版本」提示', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi({ failToken: new FeishuError(99991663, 'no scope', '/x') }).api,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.match(res.steps.find((s) => !s.ok).detail, /版本/);
  assert.strictEqual(fs.existsSync(h.projectsPath), false);
});

test('App Secret 为空：不创建 API、不写配置', async () => {
  const h = harness({ answers: ['cli_0123456789abcdef', '   '], api: fakeApi().api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(h.apiCreated(), 0);
  assert.strictEqual(h.saved.length, 0);
  assert.strictEqual(h.configs.length, 0);
  assert.match(res.steps.at(-1).detail, /不能为空/);
});

test('getBotInfo 失败：返回 ok:false，不写密钥/配置', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi({ failBotInfo: new FeishuError(99991672, 'forbidden', '/open-apis/bot/v3/info') }).api,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.steps.at(-1).name, '读取机器人信息');
  assert.match(res.steps.at(-1).detail, /forbidden/);
  assert.strictEqual(h.saved.length, 0);
  assert.strictEqual(h.configs.length, 0);
});

test('事件缺 chat_id / open_id：提示检查事件订阅，不写配置', async () => {
  for (const evt of [
    { ...P2P, message: { chat_type: 'p2p', content: '{}' } },
    { ...P2P, sender: { sender_id: {} } },
  ]) {
    const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: fakeApi().api, evt });
    const res = await h.setup.run();
    assert.strictEqual(res.ok, false);
    assert.match(res.steps.at(-1).detail, /chat_id \/ open_id/);
    assert.strictEqual(h.saved.length, 0);
    assert.strictEqual(h.configs.length, 0);
  }
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

test('首次 setup 创建 projects.json：默认别名指向 defaultCwd', async () => {
  const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: fakeApi().api });
  const res = await h.setup.run();

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(h.projectsPath, 'utf8')), {
    aliases: { 草稿: h.defaultCwd, 临时草稿: h.defaultCwd },
    default: h.defaultCwd,
  });
  assert.strictEqual(fs.existsSync(h.defaultCwd), true); // 目录必须先建好，否则建会话会被拒
  const step = res.steps.find((s) => s.name === '写入项目别名');
  assert.strictEqual(step.ok, true);
  assert.match(step.detail, /草稿、临时草稿/);
});

test('真实 saveConfig/loadConfig：projects.json 采用落盘的 defaultCwd', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi().api,
    loadConfigFn: loadConfig,
    saveConfigFn: saveConfig,
  });
  const realCwd = path.join(h.dir, 'real-default-cwd');
  saveConfig(h.configPath, { defaultCwd: realCwd });

  const res = await h.setup.run();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(loadConfig(h.configPath).defaultCwd, realCwd);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(h.projectsPath, 'utf8')), {
    aliases: { 草稿: realCwd, 临时草稿: realCwd },
    default: realCwd,
  });
  assert.strictEqual(fs.existsSync(realCwd), true);
});

test('defaultCwd 目录建不出来：记录失败且不写 projects.json', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi().api,
    loadConfigFn: loadConfig,
    saveConfigFn: saveConfig,
  });
  const blocker = path.join(h.dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const badCwd = path.join(blocker, 'child');
  saveConfig(h.configPath, { defaultCwd: badCwd });

  const res = await h.setup.run();

  assert.strictEqual(res.ok, true);
  const step = res.steps.find((s) => s.name === '写入项目别名');
  assert.strictEqual(step.ok, false);
  assert.strictEqual(fs.existsSync(h.projectsPath), false);
  assert.strictEqual(fs.existsSync(`${h.projectsPath}.tmp`), false);
  assert.strictEqual(loadConfig(h.configPath).defaultCwd, badCwd); // 真实 config 已落盘
});

test('projects.json 已存在：setup 不覆盖用户别名', async () => {
  const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: fakeApi().api });
  const original = { aliases: { 我的: 'D:/x' }, default: 'D:/x' };
  fs.writeFileSync(h.projectsPath, JSON.stringify(original));

  const res = await h.setup.run();

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(h.projectsPath, 'utf8')), original);
  assert.strictEqual(res.steps.some((s) => s.name === '写入项目别名'), false);
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

test('createGroup 失败：返回 ok:false，不写密钥/配置', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi({ failCreateGroup: new FeishuError(99991672, 'forbidden', '/open-apis/im/v1/chats') }).api,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.steps.at(-1).name, '创建测试群');
  assert.strictEqual(h.saved.length, 0);
  assert.strictEqual(h.configs.length, 0);
});

test('sendText 失败：解散测试群并返回 ok:false，不写密钥/配置', async () => {
  const f = fakeApi({ failText: new FeishuError(99991672, 'forbidden', '/open-apis/im/v1/messages') });
  const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: f.api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(f.calls.map((c) => c[0]), ['createGroup', 'sendText', 'disbandChat']);
  assert.strictEqual(h.saved.length, 0);
  assert.strictEqual(h.configs.length, 0);
});

test('disbandChat 失败不阻断，仍写配置', async () => {
  const f = fakeApi({ failDisband: new Error('disband boom') });
  const h = harness({ answers: ['cli_0123456789abcdef', 'sec'], api: f.api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, true);
  const step = res.steps.find((s) => s.name === '解散测试群');
  assert.strictEqual(step.ok, false);
  assert.match(step.detail, /手动删掉/);
  assert.strictEqual(h.configs.length, 1);
});

test('print 输出不包含 App Secret', async () => {
  const secret = 'super-secret-value';
  const h = harness({ answers: ['cli_0123456789abcdef', secret], api: fakeApi().api });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(h.lines.join('\n').includes(secret), false);
  assert.strictEqual(JSON.stringify(res.steps).includes(secret), false);
});

test('长连接启动失败：记录 err.message 并返回 ok:false，不产生未处理拒绝', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi().api,
    createWs: () => ({
      start: () => Promise.reject(new Error('ws connect refused')),
      close: () => Promise.resolve(),
    }),
    timeoutMs: 200,
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, false);
  assert.match(res.steps.at(-1).detail, /ws connect refused/);
});

test('长连接关闭拒绝不影响流程', async () => {
  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    api: fakeApi().api,
    createWs: ({ handlers }) => ({
      start() { setImmediate(() => handlers.onMessage(P2P)); },
      close: () => Promise.reject(new Error('close boom')),
    }),
  });
  const res = await h.setup.run();
  assert.strictEqual(res.ok, true);
});

test('真实 createApi 契约：向导走通 token 与 bot info，最终仅因长连接超时失败', async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }),
        text: async () => '',
        arrayBuffer: async () => Buffer.from(''),
      };
    }
    if (u === 'https://open.feishu.cn/open-apis/bot/v3/info') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: 'ok', bot: { app_name: '飞书桥' } }),
        text: async () => '',
        arrayBuffer: async () => Buffer.from(''),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const h = harness({
    answers: ['cli_0123456789abcdef', 'sec'],
    createApi: ({ appId, appSecret }) => createApi({
      appId, appSecret, fetchImpl, now: () => 1_000_000,
    }),
    evt: null,
    timeoutMs: 20,
  });
  const res = await h.setup.run();

  assert.strictEqual(res.ok, false);
  assert.ok(res.steps.some((s) => s.name === '换取 tenant_access_token' && s.ok));
  assert.ok(res.steps.some((s) => s.name === '读取机器人信息' && s.ok));
  assert.strictEqual(res.steps.at(-1).name, '长连接收到消息');
  assert.match(res.steps.at(-1).detail, /im\.message\.receive_v1/);
  assert.strictEqual(JSON.stringify(res.steps).includes('is not a function'), false);
  assert.deepStrictEqual(fetched, [
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    'https://open.feishu.cn/open-apis/bot/v3/info',
  ]);
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
