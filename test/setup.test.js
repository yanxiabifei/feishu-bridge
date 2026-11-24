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
