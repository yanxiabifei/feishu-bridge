const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { startIpc } = require('../src/ipc');

const log = { info() {}, warn() {}, error() {} };

function makeLog() {
  const warns = [];
  return {
    warns,
    info() {},
    warn(...args) { warns.push(args.map(String).join(' ')); },
    error() {},
  };
}

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

test('onHookStop 异步 rejection 只记 warn，不崩 daemon', async (t) => {
  const lg = makeLog();
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: { onHookStop: async () => { throw new Error('async-boom'); } },
  });
  t.after(() => ipc.close());
  const res = await fetch(`http://127.0.0.1:${ipc.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'tok-1', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(res.status, 200);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(lg.warns.some((w) => w.includes('async-boom')), `warn 未记录 rejection: ${lg.warns.join(' | ')}`);
  await ipc.close();
});

test('onClientMessage 异步 rejection 只记 warn，不崩 daemon', async (t) => {
  const lg = makeLog();
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: { onClientMessage: async () => { throw new Error('client-boom'); } },
  });
  t.after(() => ipc.close());
  const ws = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  t.after(() => ws.terminate());
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'list' }));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(lg.warns.some((w) => w.includes('client-boom')), `warn 未记录 rejection: ${lg.warns.join(' | ')}`);
  await ipc.close();
});

test('onClientOpen 同步抛错只记 warn，不崩 daemon', async (t) => {
  const lg = makeLog();
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: { onClientOpen: () => { throw new Error('open-boom'); } },
  });
  t.after(() => ipc.close());
  const ws = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  t.after(() => ws.terminate());
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(lg.warns.some((w) => w.includes('open-boom')), `warn 未记录抛错: ${lg.warns.join(' | ')}`);
  await ipc.close();
});

test('handler 同步阻塞时响应仍先返回，且 handler 不在响应分发栈内同步执行', async (t) => {
  const ipcPath = path.resolve(__dirname, '../src/ipc.js');
  const script = `
    const http = require('node:http');
    let inResponseTick = false;
    const origEnd = http.ServerResponse.prototype.end;
    http.ServerResponse.prototype.end = function (...args) {
      inResponseTick = true;
      const ret = origEnd.apply(this, args);
      process.nextTick(() => { inResponseTick = false; });
      return ret;
    };
    const { startIpc } = require(${JSON.stringify(ipcPath)});
    const log = { info() {}, warn() {}, error() {} };
    startIpc({
      port: 0,
      token: 'tok-timing',
      log,
      handlers: {
        onHookStop: () => {
          const synchronous = inResponseTick;
          const start = Date.now();
          process.stdout.write(JSON.stringify({ ev: 'handler-start', t: start, synchronous }) + '\\n');
          while (Date.now() - start < 800) { /* 同步阻塞事件循环 */ }
          process.stdout.write(JSON.stringify({ ev: 'handler-end', t: Date.now() }) + '\\n');
        },
      },
    }).then((ipc) => {
      process.stdout.write(JSON.stringify({ ev: 'listening', port: ipc.port, t: Date.now() }) + '\\n');
      setInterval(() => {}, 1000);
    });
  `;

  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d.toString(); });

  const events = [];
  let stdoutBuf = '';
  const listeners = [];
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      ev.recvAt = Date.now();
      events.push(ev);
      for (const l of listeners.splice(0)) l(ev);
    }
  });

  function waitEvent(name, timeoutMs) {
    const found = events.find((e) => e.ev === name);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${name} 超时; stderr=${childErr}`)), timeoutMs);
      const listener = (ev) => {
        if (ev.ev === name) {
          clearTimeout(timer);
          resolve(ev);
        } else {
          listeners.push(listener);
        }
      };
      listeners.push(listener);
    });
  }

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const listening = await waitEvent('listening', 5000);
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${listening.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'tok-timing', 'content-type': 'application/json' },
    body: '{}',
  });
  const elapsed = performance.now() - t0;
  const responseAt = Date.now();
  assert.strictEqual(res.status, 200);
  assert.ok(elapsed < 700, `响应耗时 ${elapsed.toFixed(1)}ms，handler 阻塞拖住了响应`);

  const startEv = await waitEvent('handler-start', 3000);
  const endEv = await waitEvent('handler-end', 3000);
  assert.strictEqual(startEv.synchronous, false, 'handler 必须在响应分发之后异步执行，不能同步调用');
  assert.ok(responseAt < endEv.t, '响应必须在 handler 结束前返回');
});
