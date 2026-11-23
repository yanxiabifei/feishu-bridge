const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'hook-stop.js');

function runHook(env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--session', 's1'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('exit', resolve);
    child.stdin.end(stdin);
  });
}

test('把 stdin 原样 POST 到 /hook/stop 并带 token，退出码 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, token: req.headers['x-bridge-token'], body });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ipc = path.join(dir, 'ipc.json');
  fs.writeFileSync(ipc, JSON.stringify({ port: server.address().port, token: 'tok-1', pid: 1 }));

  const payload = JSON.stringify({ session_id: 'abc', last_assistant_message: '好的' });
  const code = await runHook({ FEISHU_BRIDGE_IPC: ipc }, payload);
  server.close();

  assert.strictEqual(code, 0);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].url, '/hook/stop?session=s1');
  assert.strictEqual(received[0].token, 'tok-1');
  assert.deepStrictEqual(JSON.parse(received[0].body), JSON.parse(payload));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ipc.json 不存在时立即退出 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const code = await runHook({ FEISHU_BRIDGE_IPC: path.join(dir, 'missing.json') }, '{}');
  assert.strictEqual(code, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('端口无人监听时也退出 0 且不超时太久', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const ipc = path.join(dir, 'ipc.json');
  fs.writeFileSync(ipc, JSON.stringify({ port: 1, token: 'x', pid: 1 }));
  const t0 = Date.now();
  const code = await runHook({ FEISHU_BRIDGE_IPC: ipc }, '{}');
  assert.strictEqual(code, 0);
  assert.ok(Date.now() - t0 < 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});
