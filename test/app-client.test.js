const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startIpc } = require('../src/ipc');
const { createDaemonClient } = require('../app/lib/client');

const log = { info() {}, warn() {}, error() {}, debug() {} };
const waitFor = async (fn, what, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`超时：${what}`);
};

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-appclient-'));
  const calls = { client: [] };
  const ipc = await startIpc({
    port: 0,
    token: 'tok-app',
    log,
    ipcFile: path.join(dir, 'ipc.json'),
    acl: () => {},
    handlers: { onClientMessage: (msg) => calls.client.push(msg) },
  });
  t.after(async () => {
    await ipc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ipc, calls };
}

test('client：连上后能发消息、能收到广播，监听者抛错不影响别人', async (t) => {
  const { ipc, calls } = await boot(t);
  const client = createDaemonClient({ WebSocketImpl: WebSocket, url: `ws://127.0.0.1:${ipc.port}/?token=tok-app`, log });
  t.after(() => client.close());

  const got = [];
  client.on(() => { throw new Error('监听者自己炸了'); });
  client.on((m) => got.push(m));

  client.connect();
  await waitFor(() => client.state === 'open', '没连上');
  assert.strictEqual(client.send({ type: 'list' }), true);
  await waitFor(() => calls.client.length === 1, 'list 没送到 daemon');
  assert.deepStrictEqual(calls.client[0], { type: 'list' });

  ipc.broadcast({ type: 'sessions', list: [{ id: 's1' }] });
  await waitFor(() => got.some((m) => m.type === 'sessions'), '没收到广播');
  assert.deepStrictEqual(got.find((m) => m.type === 'sessions').list, [{ id: 's1' }]);
});

test('client：daemon 断开后自动重连并再次可用', async (t) => {
  const { ipc, calls } = await boot(t);
  const states = [];
  const sockets = [];
  class TrackedWs extends WebSocket {
    constructor(...args) {
      super(...args);
      sockets.push(this);
    }
  }
  const client = createDaemonClient({
    WebSocketImpl: TrackedWs,
    url: `ws://127.0.0.1:${ipc.port}/?token=tok-app`,
    log,
    minBackoffMs: 20,
    maxBackoffMs: 100,
    onTransportChange: (s) => states.push(s),
  });
  t.after(() => client.close());
  client.on((m) => { if (m.type === 'transport') states.push(m.state); });
  client.connect();
  await waitFor(() => client.state === 'open', '首次没连上');

  // 手动掐断这条连接，客户端应当自己回来
  sockets[0].terminate();
  await waitFor(() => states.includes('closed'), '没观察到断开');
  await waitFor(() => client.state === 'open' && sockets.length >= 2, '没有重连回来');

  const before = calls.client.length;
  assert.strictEqual(client.send({ type: 'list' }), true);
  await waitFor(() => calls.client.length === before + 1, '重连后消息发不出去');
});

test('client：close() 之后不再重连，send 返回 false', async (t) => {
  const { ipc, calls } = await boot(t);
  const client = createDaemonClient({
    WebSocketImpl: WebSocket,
    url: `ws://127.0.0.1:${ipc.port}/?token=tok-app`,
    log,
    minBackoffMs: 20,
    maxBackoffMs: 40,
  });
  client.connect();
  await waitFor(() => client.state === 'open', '没连上');
  client.close();
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(client.state, 'closed');
  assert.strictEqual(client.send({ type: 'list' }), false);
  assert.strictEqual(calls.client.length, 0);
});

test('client：reconnect 关闭时 daemon 断开直接落到 closed，不会卡在 connecting', async (t) => {
  const { ipc } = await boot(t);
  const states = [];
  const client = createDaemonClient({
    WebSocketImpl: WebSocket,
    url: `ws://127.0.0.1:${ipc.port}/?token=tok-app`,
    log,
    reconnect: false,
    minBackoffMs: 20,
    maxBackoffMs: 40,
    onTransportChange: (s) => states.push(s),
  });
  t.after(() => client.close());
  client.connect();
  await waitFor(() => client.state === 'open', '没连上');

  // 关掉 daemon 这一侧，模拟对端消失
  await ipc.close();
  await waitFor(() => client.state === 'closed', '断开后状态没落到 closed');
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(client.state, 'closed');
  assert.ok(!states.includes('connecting') || states.lastIndexOf('closed') > states.lastIndexOf('connecting'));
});

test('client：url 传函数时每次重连重新解析，daemon 换 token / 换端口后能自己连回来', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-appclient-'));
  const ipcFile = path.join(dir, 'ipc.json');
  let ipc = await startIpc({
    port: 0,
    token: 'tok-old',
    log,
    ipcFile,
    acl: () => {},
    handlers: { onClientMessage() {} },
  });
  t.after(async () => {
    try { await ipc.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let reads = 0;
  const client = createDaemonClient({
    WebSocketImpl: WebSocket,
    // 模拟 main.js：每次（重）连都重新读 state/ipc.json，而不是只在启动时读一次
    url: () => {
      reads += 1;
      const endpoint = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
      return `ws://127.0.0.1:${endpoint.port}/?token=${endpoint.token}`;
    },
    log,
    minBackoffMs: 20,
    maxBackoffMs: 60,
  });
  t.after(() => client.close());

  client.connect();
  await waitFor(() => client.state === 'open', '没连上旧 daemon');

  // daemon 重启：旧 token 作废，ipc.json 被删掉后再写新的
  await ipc.close();
  await waitFor(() => client.state !== 'open', '旧 daemon 关了，客户端还显示已连接');
  ipc = await startIpc({
    port: 0,
    token: 'tok-new',
    log,
    ipcFile,
    acl: () => {},
    handlers: { onClientMessage() {} },
  });
  await waitFor(() => client.state === 'open', 'daemon 换 token 后没有自己连回来');
  assert.ok(reads >= 2, `url 只解析了 ${reads} 次，说明还在用启动时读到的旧端点`);
});

test('client：端点文件暂时读不到时不死掉，等文件出现再连上', async (t) => {
  const { ipc } = await boot(t);
  let attempts = 0;
  const client = createDaemonClient({
    WebSocketImpl: WebSocket,
    url: () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('state/ipc.json 还不存在');
      return `ws://127.0.0.1:${ipc.port}/?token=tok-app`;
    },
    log,
    minBackoffMs: 20,
    maxBackoffMs: 40,
  });
  t.after(() => client.close());

  client.connect();
  await waitFor(() => client.state === 'open', '文件出现后没连上');
  assert.ok(attempts >= 3);
});
