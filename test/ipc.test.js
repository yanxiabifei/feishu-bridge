const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { startIpc } = require('../src/ipc');
const { createLogger } = require('../src/log');

const log = { info() {}, warn() {}, error() {} };

function makeLog() {
  const warns = [];
  return {
    warns,
    info() {},
    warn(event, fields) { warns.push({ event, fields }); },
    error() {},
  };
}

function warnOf(lg, handlerName, needle) {
  return lg.warns.find((w) => w.event === 'ipc.handler_error'
    && w.fields
    && w.fields.handler === handlerName
    && String(w.fields.error).includes(needle));
}

async function waitFor(predicate, label, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时: ${label}`);
}

function hookPost(port, session = 's1') {
  return fetch(`http://127.0.0.1:${port}/hook/stop?session=${session}`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'tok-1', 'content-type': 'application/json' },
    body: '{}',
  });
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
  await waitFor(() => calls.hook.length === 1, 'hook 未分发');
  assert.strictEqual(calls.hook[0].sessionId, 's1');
  assert.strictEqual(calls.hook[0].payload.session_id, 'abc');
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
  t.after(() => good.terminate());
  await new Promise((r) => good.on('open', r));
  good.send(JSON.stringify({ type: 'list' }));
  await waitFor(() => calls.client.length === 1, 'WebSocket 消息未分发');
  assert.deepStrictEqual(calls.client, [{ type: 'list' }]);

  const got = new Promise((r) => good.on('message', (d) => r(JSON.parse(d.toString()))));
  ipc.broadcast({ type: 'sessions', list: [] });
  assert.deepStrictEqual(await got, { type: 'sessions', list: [] });

  good.close();
});

test('写了 ipc.json，close 后删除', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-'));
  const ipcFile = path.join(dir, 'ipc.json');
  const ipc = await startIpc({ port: 0, token: 'tok-1', log, ipcFile, handlers: {}, acl: () => {} });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    const doc = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
    assert.strictEqual(doc.token, 'tok-1');
    assert.strictEqual(doc.port, ipc.port);
    await ipc.close();
    assert.strictEqual(fs.existsSync(ipcFile), false);
  } catch (err) {
    await ipc.close(); // 仅失败路径兜底，close 幂等
    throw err;
  }
});

test('ipc.json 写好后用其绝对路径限制 ACL', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-acl-'));
  const ipcFile = path.join(dir, 'ipc.json');
  const aclCalls = [];
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log,
    ipcFile,
    handlers: {},
    acl: (file) => { aclCalls.push(file); },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    assert.deepStrictEqual(aclCalls, [path.resolve(ipcFile)]);
    assert.strictEqual(path.isAbsolute(aclCalls[0]), true);
  } finally {
    await ipc.close();
  }
});

test('ACL 失败只记 warn，ipc.json 仍写出且 daemon 正常启动', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-acl-fail-'));
  const ipcFile = path.join(dir, 'ipc.json');
  const lg = makeLog();
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    ipcFile,
    handlers: {},
    acl: () => { throw new Error('icacls 不可用'); },
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    assert.ok(ipc, 'ACL 失败不应让 startIpc reject');
    const doc = JSON.parse(fs.readFileSync(ipcFile, 'utf8'));
    assert.strictEqual(doc.token, 'tok-1');
    const warn = lg.warns.find((w) => w.event === 'ipc.acl_failed');
    assert.ok(warn, '未记录 ipc.acl_failed');
    assert.ok(String(warn.fields.error).includes('icacls 不可用'));
    const res = await fetch(`http://127.0.0.1:${ipc.port}/health`);
    assert.strictEqual(res.status, 200);
  } finally {
    await ipc.close();
  }
});

test('ipc.json 写入失败只记 warn，startIpc 仍 resolve 且可关闭', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-write-fail-'));
  const ipcFile = path.join(dir, 'ipc.json');
  fs.mkdirSync(ipcFile);   // 路径是目录 → writeFileSync 抛错
  const lg = makeLog();
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    ipcFile,
    handlers: {},
    acl: () => {},
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    assert.ok(ipc, '写入失败不应让 startIpc 挂起');
    assert.strictEqual(fs.statSync(ipcFile).isDirectory(), true);
    const warn = lg.warns.find((w) => w.event === 'ipc.write_failed');
    assert.ok(warn, '未记录 ipc.write_failed');
    assert.ok(String(warn.fields.error).length > 0);
  } finally {
    await ipc.close();
  }
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
  const res = await hookPost(ipc.port);
  assert.strictEqual(res.status, 200);
  await waitFor(() => warnOf(lg, 'onHookStop', 'async-boom'), 'warn 未记录 rejection');
  assert.strictEqual(warnOf(lg, 'onHookStop', 'async-boom').event, 'ipc.handler_error');
  assert.strictEqual(warnOf(lg, 'onHookStop', 'async-boom').fields.handler, 'onHookStop');
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
  await waitFor(() => warnOf(lg, 'onClientMessage', 'client-boom'), 'warn 未记录 rejection');
  assert.strictEqual(warnOf(lg, 'onClientMessage', 'client-boom').fields.handler, 'onClientMessage');
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
  await waitFor(() => warnOf(lg, 'onClientOpen', 'open-boom'), 'warn 未记录抛错');
  const res = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  assert.strictEqual(res.status, 200);
});

test('连接对象上的 error 事件有监听者，畸形帧不会把 daemon 带崩', async (t) => {
  // 本地任何进程都能连上来；收到无效 UTF-8、超大帧时 ws 会在连接对象上 emit('error')，
  // 没有监听者时 EventEmitter 同步抛错 → uncaughtException，所有会话一起挂
  const lg = makeLog();
  let serverWs = null;
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: { onClientOpen: (ws) => { serverWs = ws; } },
  });
  t.after(() => ipc.close());
  const ws = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  t.after(() => ws.terminate());
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => serverWs !== null, '连接未到达服务端');

  assert.doesNotThrow(() => serverWs.emit('error', new Error('invalid utf-8')));
  const warn = lg.warns.find((w) => w.event === 'ipc.ws_client_error');
  assert.ok(warn, '连接错误未记录 ipc.ws_client_error');
});

test('onHookStop 首次 rejection 后，第二次请求仍 200 且 handler 再次被调用', async (t) => {
  const lg = makeLog();
  let count = 0;
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: { onHookStop: async () => { count += 1; throw new Error(`hook-boom-${count}`); } },
  });
  t.after(() => ipc.close());

  const first = await hookPost(ipc.port, 's1');
  assert.strictEqual(first.status, 200);
  await waitFor(() => count === 1, '首次 handler 未被调用');

  const second = await hookPost(ipc.port, 's2');
  assert.strictEqual(second.status, 200);
  await waitFor(() => count === 2, '第二次 handler 未被调用');

  assert.ok(warnOf(lg, 'onHookStop', 'hook-boom-1'), '首次 rejection 未记录');
  assert.ok(warnOf(lg, 'onHookStop', 'hook-boom-2'), '第二次 rejection 未记录');
  const health = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  assert.strictEqual(health.status, 200);
});

test('onClientOpen 抛错后，客户端后续消息仍被分发', async (t) => {
  const lg = makeLog();
  const received = [];
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: {
      onClientOpen: () => { throw new Error('open-boom'); },
      onClientMessage: (m) => { received.push(m); },
    },
  });
  t.after(() => ipc.close());
  const ws = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  t.after(() => ws.terminate());
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => warnOf(lg, 'onClientOpen', 'open-boom'), 'open 抛错未记录');

  ws.send(JSON.stringify({ type: 'after-open' }));
  await waitFor(() => received.length === 1, 'open 抛错后消息未被分发');
  assert.deepStrictEqual(received[0], { type: 'after-open' });
});

test('onClientMessage 抛错后，下一条消息仍被分发', async (t) => {
  const lg = makeLog();
  const received = [];
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: {
      onClientMessage: (m) => {
        received.push(m);
        throw new Error(`msg-boom-${received.length}`);
      },
    },
  });
  t.after(() => ipc.close());
  const ws = new WebSocket(`ws://127.0.0.1:${ipc.port}/?token=tok-1`);
  t.after(() => ws.terminate());
  await new Promise((r) => ws.on('open', r));

  ws.send(JSON.stringify({ type: 'first' }));
  await waitFor(() => received.length === 1, '第一条消息未被分发');
  ws.send(JSON.stringify({ type: 'second' }));
  await waitFor(() => received.length === 2, '第二条消息未被分发');

  assert.deepStrictEqual(received.map((m) => m.type), ['first', 'second']);
  assert.ok(warnOf(lg, 'onClientMessage', 'msg-boom-1'), '第一条消息抛错未记录');
  assert.ok(warnOf(lg, 'onClientMessage', 'msg-boom-2'), '第二条消息抛错未记录');
  const health = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  assert.strictEqual(health.status, 200);
});

test('onHookStop 真正同步抛错只记 warn，不崩 daemon', async (t) => {
  const lg = makeLog();
  let called = false;
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: {
      onHookStop: () => { called = true; throw new Error('sync-boom'); },
    },
  });
  t.after(() => ipc.close());
  const res = await hookPost(ipc.port);
  assert.strictEqual(res.status, 200);
  await waitFor(() => called, '同步抛错的 handler 未被调用');
  await waitFor(() => warnOf(lg, 'onHookStop', 'sync-boom'), '同步抛错未记录');
  const health = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  assert.strictEqual(health.status, 200);
});

test('不传 log 时 handler 抛错不崩，/health 仍 200', async (t) => {
  let called = false;
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    handlers: {
      onHookStop: () => { called = true; throw new Error('no-log-boom'); },
    },
  });
  t.after(() => ipc.close());
  const res = await hookPost(ipc.port);
  assert.strictEqual(res.status, 200);
  await waitFor(() => called, 'handler 未被调用');
  const health = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  assert.strictEqual(health.status, 200);
});

test('handler 错误日志走结构化字段，真实 createLogger 落盘后不含 token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ipc-redact-'));
  const secret = 'tok-SECRET-987654';
  const lg = createLogger({ dir });
  lg.redactor.add(secret);
  const ipc = await startIpc({
    port: 0,
    token: 'tok-1',
    log: lg,
    handlers: {
      onHookStop: () => { throw new Error(`boom token=${secret}`); },
    },
  });
  t.after(() => ipc.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const res = await hookPost(ipc.port);
  assert.strictEqual(res.status, 200);
  await waitFor(
    () => fs.readdirSync(dir).some((f) => f.endsWith('.jsonl')),
    '日志文件未写出',
  );

  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.jsonl')));
  const raw = fs.readFileSync(file, 'utf8');
  assert.strictEqual(raw.includes(secret), false, `日志中泄漏 token: ${raw}`);
  const rec = JSON.parse(raw.trim().split('\n')[0]);
  assert.strictEqual(rec.event, 'ipc.handler_error');
  assert.strictEqual(rec.level, 'warn');
  assert.strictEqual(rec.handler, 'onHookStop');
  assert.ok(String(rec.error).includes('***'), `error 字段未脱敏: ${rec.error}`);
  assert.strictEqual(String(rec.error).includes(secret), false);
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

test('hook 请求体超过上限返回 413 且不触发回调', async (t) => {
  const { ipc, calls } = await boot();
  t.after(() => ipc.close());
  const big = 'x'.repeat(300 * 1024);
  const res = await fetch(`http://127.0.0.1:${ipc.port}/hook/stop?session=s1`, {
    method: 'POST',
    headers: { 'x-bridge-token': 'tok-1', 'content-type': 'application/json' },
    body: big,
  }).catch((err) => ({ status: 0, err }));
  // 服务端在超限时直接断开，客户端可能收到 413，也可能拿到连接重置——都不能当作成功
  assert.notStrictEqual(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(calls.hook.length, 0);
});

test('同一端口重复启动时第二次 reject 而不是崩溃', async (t) => {
  const { ipc } = await boot();
  t.after(() => ipc.close());
  const log2 = makeLog();
  await assert.rejects(
    startIpc({ port: ipc.port, token: 'tok-2', log: log2, handlers: {} }),
    (err) => err && err.code === 'EADDRINUSE',
  );
  // 原实例不受影响
  const res = await fetch(`http://127.0.0.1:${ipc.port}/health`);
  assert.strictEqual(res.status, 200);
});
