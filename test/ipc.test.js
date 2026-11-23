const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startIpc } = require('../src/ipc');

const log = { info() {}, warn() {}, error() {} };

async function boot() {
  const calls = { hook: [], client: [] };
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log,
    handlers: {
      onHookStop: (x) => calls.hook.push(x),
      onClientMessage: (m, ws) => calls.client.push(m),
    },
  });
  return { ipc, calls };
}

test('/health 返回 ok 与 pid', async (t) => {
  const { ipc } = await boot();
  t.after(() => ipc.close());
  const res = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.pid, 'number');
  await ipc.close();
});

test('token 错误的 hook 请求被拒绝且不触发回调', async (t) => {
  const { ipc, calls } = await boot();
  t.after(() => ipc.close());
  const res = await fetch(`http://127.0.0.1:${ipc.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'wrong' },
    body: '{}',
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(calls.hook.length, 0);
  await ipc.close();
});

test('token 正确的 hook 请求先回 200 再异步分发', async (t) => {
  const { ipc, calls } = await boot();
  t.after(() => ipc.close());
  const res = await fetch(`http://127.0.0.1:${ipc.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'tok-1', 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'abc', last_assistant_message: '好' }),
  });
  assert.strictEqual(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(calls.hook.length, 1);
  assert.strictEqual(calls.hook[0].sessionId, 's1');
  assert.strictEqual(calls.hook[0].payload.session_id, 'abc');
  await ipc.close();
});

test('WebSocket：token 错误被断开，正确可收发与广播', async (t) => {
  const { ipc, calls } = await boot();
  t.after(() => ipc.close());

  const bad = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=wrong`);
  const badClosed = await new Promise((resolve) => {
    bad.on('close', () => resolve(true));
    bad.on('error', () => resolve(true));
  });
  assert.strictEqual(badClosed, true);

  const good = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  await new Promise((r) => good.on('open', r));
  good.send(JSON.stringify({ type: 'list' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(calls.client, [{ type: 'list' }]);

  const got = new Promise((r) => good.on('message', (d) => r(JSON.parse(d.toString()))));
  ipc.broadcast({ type: 'sessions', list: [] });
  assert.deepStrictEqual(await got, { type: 'sessions', list: [] });

  good.close();
  await ipc.close();
});

test('写了 ipc.json，close 后删除', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-'));
  const ipcFile = path.join(dir, 'ipc.json');
  const ipc = await startIpc({ port: 0, token: 'tok-1', log, ipcFile, handlers: {} });
  t.after(() => ipc.close());
  const doc = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
  assert.strictEqual(doc.token, 'tok-1');
  assert.strictEqual(doc.port, ipc.port);
  await ipc.close();
  assert.strictEqual(fs.existsSync(ipcFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
