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
