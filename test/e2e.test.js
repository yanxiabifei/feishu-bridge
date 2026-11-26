const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const pty = require('node-pty');
const { createPtySession } = require('../src/session/ptySession');
const { createScreen } = require('../src/screen');
const { createQueue } = require('../src/session/queue');

const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-agent.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10000, step = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}

function makeSession(onEvent) {
  const session = {
    id: 'e2e', chatId: 'oc_e2e', agent: 'fake', cwd: process.cwd(),
    status: 'idle', inputSeq: 0, lastInput: null,
  };
  let raw = null;
  const ps = createPtySession({
    session,
    launch: () => ({ file: process.execPath, args: [FAKE_AGENT], cwd: process.cwd() }),
    ptyFactory: (file, args, opts) => {
      raw = pty.spawn(file, args, opts);
      return raw;
    },
    screenFactory: createScreen,
    queueFactory: createQueue,
    onEvent,
  });
  // 任务 29 起 onExit 会自己 pty.kill()；这里保留 raw.kill() 作双保险，
  // 防止将来有人回退修复时整个测试轮挂死。
  return {
    ps,
    killRaw: () => { try { raw && raw.kill(); } catch { /* 已退出 */ } },
  };
}

test('真实 ConPTY：就绪 → 写入 → 回显 → 连发两条按序执行', async () => {
  const events = [];
  const { ps, killRaw } = makeSession((e) => events.push(e));
  try {
    ps.start();
    assert.ok(
      await waitFor(() => ps.status === 'idle'),
      `10 秒内未就绪；最后事件：${JSON.stringify(events.slice(-3))}`,
    );
    assert.ok(
      await waitFor(() => ps.screen.snapshot().includes('FAKE_AGENT_READY'), { timeout: 5000 }),
      `未等到 FAKE_AGENT_READY；屏幕尾部：${JSON.stringify(ps.screen.snapshot().slice(-500))}`,
    );

    assert.strictEqual(ps.submitText('ping-1', 'phone'), 'queued');
    // 第二条应排队（第一条还在跑），不能立刻写进终端
    assert.strictEqual(ps.submitText('ping-2', 'phone'), 'queued');
    assert.ok(
      await waitFor(() => ps.screen.snapshot().includes('ECHO:ping-1')),
      `未等到 ECHO:ping-1；status=${ps.status}；屏幕尾部：`
        + `${JSON.stringify(ps.screen.snapshot().slice(-500))}；最后事件：${JSON.stringify(events.slice(-3))}`,
    );

    ps.releaseTurn();
    assert.ok(
      await waitFor(() => ps.screen.snapshot().includes('ECHO:ping-2')),
      `未等到 ECHO:ping-2；status=${ps.status}；屏幕尾部：`
        + `${JSON.stringify(ps.screen.snapshot().slice(-500))}；最后事件：${JSON.stringify(events.slice(-3))}`,
    );
    const text = ps.screen.snapshot();
    assert.ok(text.indexOf('ECHO:ping-1') < text.indexOf('ECHO:ping-2'), '输出顺序被打乱');
  } finally {
    killRaw();
  }
});

test('agent 自己退出：状态转 closed 并发出 exit 事件', async () => {
  const events = [];
  const { ps, killRaw } = makeSession((e) => events.push(e));
  try {
    ps.start();
    assert.ok(
      await waitFor(() => ps.status === 'idle'),
      `10 秒内未就绪；status=${ps.status}；屏幕尾部：`
        + `${JSON.stringify(ps.screen.snapshot().slice(-500))}；最后事件：${JSON.stringify(events.slice(-3))}`,
    );
    ps.submitText('/exit', 'phone');
    assert.ok(
      await waitFor(() => ps.status === 'closed'),
      `退出后状态没有转 closed；status=${ps.status}；屏幕尾部：`
        + `${JSON.stringify(ps.screen.snapshot().slice(-500))}；最后事件：${JSON.stringify(events.slice(-3))}`,
    );
    assert.ok(events.some((e) => e.type === 'exit'), '没有 exit 事件');
  } finally {
    killRaw();
  }
});
