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
