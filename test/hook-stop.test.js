const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'hook-stop.js');

function runHook(env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--session', 's1'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const t0 = Date.now();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, 5000);
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, killed, elapsed: Date.now() - t0, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function assertSilent(r, token) {
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  if (token) {
    assert.ok(!r.stdout.includes(token), 'stdout 泄漏了 token');
    assert.ok(!r.stderr.includes(token), 'stderr 泄漏了 token');
  }
}

function makeIpc(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ipc = path.join(dir, 'ipc.json');
  if (data) fs.writeFileSync(ipc, JSON.stringify(data));
  return ipc;
}

function listen(t, server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        server.closeAllConnections?.();
        server.close();
      });
      resolve(server.address().port);
    });
  });
}

test('把 stdin 原样 POST 到 /hook/stop 并带 token，退出码 0', { timeout: 5000 }, async (t) => {
  const received = [];
  const token = 'tok-secret-happy';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, token: req.headers['x-bridge-token'], body });
      res.end('{}');
    });
  });
  const port = await listen(t, server);
  const ipc = makeIpc(t, { port, token, pid: 1 });

  const payload = JSON.stringify({ session_id: 'abc', last_assistant_message: '好的' });
  const r = await runHook({ FEISHU_BRIDGE_IPC: ipc }, payload);

  assert.strictEqual(r.killed, false);
  assert.strictEqual(r.code, 0);
  assert.ok(r.elapsed < 2500, `耗时 ${r.elapsed}ms 超过 2500ms`);
  assertSilent(r, token);

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].url, '/hook/stop?session=s1');
  assert.strictEqual(received[0].token, token);
  assert.deepStrictEqual(JSON.parse(received[0].body), JSON.parse(payload));
});

test('ipc.json 不存在时立即退出 0', { timeout: 5000 }, async (t) => {
  const ipc = makeIpc(t, null);
  const t0 = Date.now();
  const r = await runHook({ FEISHU_BRIDGE_IPC: ipc }, '{}');
  assert.strictEqual(r.killed, false);
  assert.strictEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 1000, `耗时 ${Date.now() - t0}ms 超过 1000ms`);
  assertSilent(r);
});

test('端口无人监听时也退出 0 且不超时太久', { timeout: 5000 }, async (t) => {
  const ipc = makeIpc(t, { port: 1, token: 'tok-secret-refused', pid: 1 });
  const r = await runHook({ FEISHU_BRIDGE_IPC: ipc }, '{}');
  assert.strictEqual(r.killed, false);
  assert.strictEqual(r.code, 0);
  assert.ok(r.elapsed < 2500, `耗时 ${r.elapsed}ms 超过 2500ms`);
  assertSilent(r, 'tok-secret-refused');
});

test('服务端接受连接但永不响应时仍退出 0 且不超时太久', { timeout: 5000 }, async (t) => {
  const token = 'tok-secret-silent';
  const server = http.createServer((req) => {
    req.resume();
    // 故意不响应
  });
  const port = await listen(t, server);
  const ipc = makeIpc(t, { port, token, pid: 1 });
  const r = await runHook({ FEISHU_BRIDGE_IPC: ipc }, '{}');
  assert.strictEqual(r.killed, false);
  assert.strictEqual(r.code, 0);
  assert.ok(r.elapsed < 2500, `耗时 ${r.elapsed}ms 超过 2500ms`);
  assertSilent(r, token);
});

test('发完响应头后慢速滴字节时仍退出 0 且不超时太久', { timeout: 5000 }, async (t) => {
  const token = 'tok-secret-drip';
  let drip;
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    drip = setInterval(() => res.write(' '), 100);
    res.on('close', () => clearInterval(drip));
  });
  const port = await listen(t, server);
  t.after(() => clearInterval(drip));
  const ipc = makeIpc(t, { port, token, pid: 1 });
  const r = await runHook({ FEISHU_BRIDGE_IPC: ipc }, '{}');
  assert.strictEqual(r.killed, false);
  assert.strictEqual(r.code, 0);
  assert.ok(r.elapsed < 2500, `耗时 ${r.elapsed}ms 超过 2500ms`);
  assertSilent(r, token);
});
