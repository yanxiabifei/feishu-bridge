const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FIXTURE = path.join(__dirname, 'fixtures', 'pty-leak-child.js');
const TIMEOUT_MS = 20000;

test('真实 ConPTY 自然退出后子进程能自行结束（conout Worker 已释放）', async () => {
  const child = spawn(process.execPath, [FIXTURE], { cwd: process.cwd() });
  const result = await new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, timedOut });
    });
  });
  assert.strictEqual(result.timedOut, false,
    `子进程 ${TIMEOUT_MS}ms 内没有退出，说明句柄仍在泄漏；stderr=${result.err}`);
  assert.strictEqual(result.code, 0, `子进程退出码 ${result.code}；stderr=${result.err}`);
  assert.ok(result.out.includes('CHILD_CLOSED'), `没看到 CHILD_CLOSED；stdout=${result.out}`);
});
