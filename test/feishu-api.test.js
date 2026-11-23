const test = require('node:test');
const assert = require('node:assert');
const { createApi, FeishuError } = require('../src/feishu/api');

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const out = handler({ url: String(url), method: opts.method || 'GET', body: opts.body });
    if (out && out.__raw !== undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => { throw new Error('not json'); },
        text: async () => '',
        arrayBuffer: async () => out.__raw,
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => out,
      text: async () => JSON.stringify(out),
      arrayBuffer: async () => Buffer.from(''),
    };
  };
  fn.calls = calls;
  return fn;
}

function apiWith(handler) {
  const fetchImpl = fakeFetch(handler);
  let clock = 1_000_000;
  const api = createApi({
    appId: 'cli_x',
    appSecret: 'sec',
    fetchImpl,
    now: () => clock,
    baseUrl: 'https://open.feishu.cn',
  });
  return {
    api,
    fetchImpl,
    advance: (ms) => { clock += ms; },
    calls: fetchImpl.calls,
  };
}

const tokenRoute = (url, body) => {
  if (url.includes('/auth/v3/tenant_access_token/internal')) {
    return { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200, __echo: body };
  }
  return null;
};

test('token 被缓存：两次调用只取一次 token', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  await api.sendText('oc_1', '你好');
  await api.sendText('oc_1', '第二句');
  const tokenCalls = calls.filter((c) => c.url.includes('tenant_access_token'));
  assert.strictEqual(tokenCalls.length, 1);
});

test('token 过期后自动刷新', async () => {
  const { api, calls, advance } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  await api.sendText('oc_1', 'a');
  advance(7200 * 1000 + 1000);
  await api.sendText('oc_1', 'b');
  assert.strictEqual(calls.filter((c) => c.url.includes('tenant_access_token')).length, 2);
});

test('sendText 的 body 形状正确（content 是 JSON 字符串）', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  const id = await api.sendText('oc_1', '你好');
  assert.strictEqual(id, 'om_1');
  const send = calls.find((c) => c.url.includes('/open-apis/im/v1/messages?'));
  assert.ok(send);
  const body = JSON.parse(send.opts.body);
  assert.strictEqual(body.receive_id, 'oc_1');
  assert.strictEqual(body.msg_type, 'text');
  assert.deepStrictEqual(JSON.parse(body.content), { text: '你好' });
});

test('业务错误码抛 FeishuError 并带 code', async () => {
  const { api } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 99991663, msg: 'no scope' }
  ));
  await assert.rejects(
    () => api.sendText('oc_1', 'x'),
    (err) => err instanceof FeishuError && err.code === 99991663 && err.message.includes('no scope'),
  );
});

test('createGroup 传 user_id_list 并返回 chat_id', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { chat_id: 'oc_new' } }
  ));
  const chatId = await api.createGroup('卡牌', ['ou_owner']);
  assert.strictEqual(chatId, 'oc_new');
  const call = calls.find((c) => c.url.includes('/open-apis/im/v1/chats?'));
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.name, '卡牌');
  assert.deepStrictEqual(body.user_id_list, ['ou_owner']);
  assert.strictEqual(body.chat_mode, 'group');
});

test('getChat 遇到 230002（群不存在）返回 null，其他错误照抛', async () => {
  const gone = apiWith(({ url }) => (
    tokenRoute(url) || { code: 230002, msg: 'chat not found' }
  ));
  assert.strictEqual(await gone.api.getChat('oc_gone'), null);

  const other = apiWith(({ url }) => (
    tokenRoute(url) || { code: 99991672, msg: 'forbidden' }
  ));
  await assert.rejects(() => other.api.getChat('oc_x'), (e) => e.code === 99991672);
});

test('downloadResource 返回 Buffer', async () => {
  const { api } = apiWith(({ url }) => (
    tokenRoute(url) || { __raw: Buffer.from('PNGDATA') }
  ));
  const buf = await api.downloadResource('om_1', 'file_key_1', 'image');
  assert.ok(Buffer.isBuffer(buf));
  assert.strictEqual(buf.toString(), 'PNGDATA');
});

test('updateCardEntity 带上 sequence 与 uuid', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: {} }
  ));
  await api.updateCardEntity('card_1', { schema: '2.0' }, 3);
  const call = calls.find((c) => c.url.includes('/cardkit/v1/cards/card_1'));
  assert.strictEqual(call.opts.method, 'PUT');
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.sequence, 3);
  assert.strictEqual(body.card.type, 'card_json');
  assert.deepStrictEqual(JSON.parse(body.card.data), { schema: '2.0' });
  assert.ok(body.uuid);
});

test('getBotInfo 读顶层 bot 字段（该接口没有 data 包装）', async () => {
  const { api } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', bot: { app_name: '飞书桥', open_id: 'ou_bot' } }
  ));
  const info = await api.getBotInfo();
  assert.strictEqual(info.app_name, '飞书桥');
  assert.strictEqual(info.open_id, 'ou_bot');
});

test('公开接口暴露 sendMessage，且按规格 POST 消息', async () => {
  const { api, calls } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_pub' } }
  ));
  assert.strictEqual(typeof api.sendMessage, 'function');

  const id = await api.sendMessage('oc_1', 'text', { text: 'hi' });
  assert.strictEqual(id, 'om_pub');

  const send = calls.find((c) => c.url.includes('/open-apis/im/v1/messages?'));
  assert.ok(send);
  assert.strictEqual(send.opts.method, 'POST');
  assert.ok(send.url.endsWith('/open-apis/im/v1/messages?receive_id_type=chat_id'));
  const body = JSON.parse(send.opts.body);
  assert.deepStrictEqual(body, {
    receive_id: 'oc_1',
    msg_type: 'text',
    content: JSON.stringify({ text: 'hi' }),
  });
  assert.strictEqual(typeof body.content, 'string');
});

test('token 并发合并：3 个方法同时调用只发 1 次 token 请求', async () => {
  let releaseToken;
  const tokenGate = new Promise((resolve) => { releaseToken = resolve; });
  let tokenCalls = 0;
  const businessUrls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v3/tenant_access_token/internal')) {
      tokenCalls += 1;
      await tokenGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }),
        text: async () => '',
        arrayBuffer: async () => Buffer.from(''),
      };
    }
    businessUrls.push(u);
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_c' } }),
      text: async () => '',
      arrayBuffer: async () => Buffer.from(''),
    };
  };
  const api = createApi({ appId: 'cli_x', appSecret: 'sec', fetchImpl, now: () => 1_000_000 });

  const pending = [
    api.sendText('oc_1', 'a'),
    api.getChat('oc_1'),
    api.disbandChat('oc_1'),
  ];
  releaseToken();
  await Promise.all(pending);

  assert.strictEqual(tokenCalls, 1);
  assert.strictEqual(businessUrls.length, 3);
});

test('token 在恰好 tokenExp - 60000 时刷新（边界）', async () => {
  const { api, calls, advance } = apiWith(({ url }) => (
    tokenRoute(url) || { code: 0, msg: 'ok', data: { message_id: 'om_1' } }
  ));
  await api.sendText('oc_1', 'a');
  advance(7200 * 1000 - 60000); // now 恰好等于 tokenExp - 60000
  await api.sendText('oc_1', 'b');
  assert.strictEqual(calls.filter((c) => c.url.includes('tenant_access_token')).length, 2);
});
