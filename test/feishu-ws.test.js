const test = require('node:test');
const assert = require('node:assert');
const { createFeishuWs, createDedup } = require('../src/feishu/ws');

function makeSdk() {
  const registered = {};
  const state = { clientOpts: null, dispatcherOpts: null, startArgs: null, closed: false };
  class EventDispatcher {
    constructor(opts) { state.dispatcherOpts = opts; }
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

test('EventDispatcher 也使用 fatal 级别静默日志', () => {
  const { state } = setup();
  assert.ok(state.dispatcherOpts);
  assert.strictEqual(state.dispatcherOpts.loggerLevel, 0);
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

test('createDedup max 是硬上限，全新鲜时按插入顺序淘汰最老', () => {
  const dedup = createDedup({ ttl: 600000, max: 3, now: () => 0 });
  for (let i = 0; i < 10; i++) dedup.isDuplicate(`ev_${i}`);
  assert.strictEqual(dedup.size(), 3);
  // 最老的 ev_0..ev_6 已被淘汰，重新出现不算重复
  assert.strictEqual(dedup.isDuplicate('ev_0'), false);
  assert.strictEqual(dedup.size(), 3);
  // 最近的 ev_9 仍在窗口内
  assert.strictEqual(dedup.isDuplicate('ev_9'), true);
});

test('createDedup max=1 与 max=0 不崩且语义合理', () => {
  const one = createDedup({ ttl: 600000, max: 1, now: () => 0 });
  assert.strictEqual(one.isDuplicate('a'), false);
  assert.strictEqual(one.isDuplicate('b'), false);
  assert.strictEqual(one.size(), 1);
  assert.strictEqual(one.isDuplicate('b'), true);
  assert.strictEqual(one.isDuplicate('a'), false);

  const zero = createDedup({ ttl: 600000, max: 0, now: () => 0 });
  assert.strictEqual(zero.isDuplicate('a'), false);
  assert.strictEqual(zero.isDuplicate('a'), false);
  assert.strictEqual(zero.size(), 0);
});

test('dedup 传 null 时退化为默认去重而非吞事件', async () => {
  const { registered, calls } = setup({ dedup: null });
  const payload = { event_id: 'ev_null_dedup', message: { chat_id: 'oc_1' } };
  await registered['im.message.receive_v1'](payload);
  await registered['im.message.receive_v1'](payload);
  assert.strictEqual(calls.message.length, 1);
});

test('domain 传 null 时回落到默认 Feishu', async () => {
  const { ws, state } = setup({ domain: null });
  await ws.start();
  assert.strictEqual(state.clientOpts.domain, 0);
});

test('非 Error 拒绝/抛出值的日志可读', async () => {
  const s = setup({
    handlers: {
      onMessage: async () => { throw 'plain async boom'; },
      onBotAdded: () => { throw { code: 42 }; },
    },
  });
  await s.registered['im.message.receive_v1']({ event_id: 'e_plain_async' });
  await new Promise((r) => setImmediate(r));
  await s.registered['im.chat.member.bot.added_v1']({ event_id: 'e_plain_sync' });
  assert.ok(s.logs.some((m) => m.includes('plain async boom')));
  assert.ok(s.logs.some((m) => m.includes('[object Object]')));
});
