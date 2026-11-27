const test = require('node:test');
const assert = require('node:assert');
const { createPtySession } = require('../src/session/ptySession');
const { createQueue } = require('../src/session/queue');

function harness(overrides = {}) {
  const written = [];
  const events = [];
  const resized = [];
  const screenResized = [];
  const order = [];
  const launchCalls = [];
  const factoryCalls = [];
  let dataHandler = () => {};
  let exitHandler = () => {};
  let ready = true;
  let clock = 1000;
  let killCalls = 0;

  const pty = {
    pid: 4242,
    onData(fn) { dataHandler = fn; },
    onExit(fn) { exitHandler = fn; },
    write(s) { written.push(s); },
    resize(c, r) { resized.push([c, r]); },
    kill() { killCalls++; exitHandler({ exitCode: 0 }); },
  };

  const screen = {
    write(d) { lastScreen += d; order.push('screen'); },
    isReady: () => ready,
    snapshot: () => 'screen-tail',
    inputLine: () => overrides.inputLine || '输入中的话',
    inInputBox: () => inBox,
    bracketedPaste: (t) => `\x1b[200~${t}\x1b[201~`,
    resize(c, r) { screenResized.push([c, r]); },
    dispose() {},
  };
  let lastScreen = '';
  let inBox = true;

  const session = {
    id: 's1', agent: overrides.agent || 'claude', cwd: 'D:/w', status: 'idle', inputSeq: 0, lastInput: null,
  };

  const ps = createPtySession({
    session,
    launch: (...args) => {
      launchCalls.push(args);
      return { file: 'node', args: ['x.js'], cwd: 'D:/w' };
    },
    ptyFactory: (file, args, opts) => {
      factoryCalls.push({ file, args, opts });
      return pty;
    },
    screenFactory: () => screen,
    queueFactory: createQueue,
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => { events.push(e); order.push('event'); },
    now: () => clock,
  });

  return {
    ps, written, events, resized, screenResized, order, session, launchCalls, factoryCalls,
    get killCalls() { return killCalls; },
    screenText() { return lastScreen; },
    setReady(v) { ready = v; },
    setInBox(v) { inBox = v; },
    setNow(v) { clock = v; },
    emitData(d) { dataHandler(d); },
    emitExit(code) { exitHandler({ exitCode: code }); },
  };
}

test('start 后 PTY 进入 starting，屏幕就绪后转 idle 并派发 ready', () => {
  const h = harness();
  h.ps.start();
  assert.strictEqual(h.ps.status, 'starting');
  h.ps._pollReady(); // 测试直接驱动一次就绪探测
  assert.strictEqual(h.ps.status, 'idle');
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'ready').length, 1);
});

test('idle 时提交：立即以括号粘贴+回车写入，状态转 running', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('你好', 'phone');
  assert.deepStrictEqual(h.written, ['\x1b[200~你好\x1b[201~\r']);
  assert.strictEqual(h.ps.status, 'running');
  assert.strictEqual(h.session.inputSeq, 1);
  assert.strictEqual(h.session.lastInput.origin, 'phone');
  assert.strictEqual(h.session.lastInput.text, '你好');
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-start').length, 1);
});

test('starting 期间提交只缓存，ready 后按顺序写出', () => {
  const h = harness();
  h.ps.start();
  h.ps.submitText('一', 'phone');
  h.ps.submitText('二', 'phone');
  assert.deepStrictEqual(h.written, []);
  h.ps._pollReady();
  assert.deepStrictEqual(h.written, ['\x1b[200~一\x1b[201~\r']);
  h.ps.releaseTurn();
  assert.deepStrictEqual(h.written, ['\x1b[200~一\x1b[201~\r', '\x1b[200~二\x1b[201~\r']);
});

test('队列满时派发 overflow 事件且不写入', () => {
  const h = harness();
  const ps = createPtySession({
    session: h.session,
    launch: () => ({ file: 'node', args: [], cwd: 'D:/w' }),
    ptyFactory: () => ({ onData() {}, onExit() {}, write() { h.written.push('X'); }, kill() {} }),
    screenFactory: () => ({ write() {}, isReady: () => false, snapshot: () => '', inputLine: () => '', inInputBox: () => true, bracketedPaste: (t) => t, resize() {}, dispose() {} }),
    queueFactory: (o) => createQueue({ ...o, limit: 2 }),
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => h.events.push(e),
  });
  ps.start();
  ps.submitText('一', 'phone');
  ps.submitText('二', 'phone');
  ps.submitText('三', 'phone');
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'overflow').length, 1);
  assert.deepStrictEqual(h.written, []);
});

test('needsConfirm：idle 但画面不在输入框（菜单/弹窗）时为 true', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.setInBox(false);
  assert.strictEqual(h.ps.needsConfirm(), true);
  h.setInBox(true);
  assert.strictEqual(h.ps.needsConfirm(), false);
});

test('画面回到输入框后，pollReady 自动补写积压', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('一', 'phone');   // 立即写出，status 转 running
  h.setInBox(false);
  h.ps.submitText('二', 'phone');   // 排队
  h.ps.releaseTurn();               // 画面不在输入框 → 不盲写
  assert.strictEqual(h.written.length, 1);
  h.setInBox(true);
  h.ps._pollReady();                // 回到输入框后自动补写
  assert.strictEqual(h.written.length, 2);
  assert.strictEqual(h.written[1], '\x1b[200~二\x1b[201~\r');
});

test('force 提交无视输入框判断，直接写入（「仍然发送」用）', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.setInBox(false);
  h.ps.submitText('照样发', 'phone', { force: true });
  assert.strictEqual(h.written.length, 1);
  assert.strictEqual(h.written[0], '\x1b[200~照样发\x1b[201~\r');
  assert.strictEqual(h.session.lastInput.text, '照样发');
});

test('电脑端敲回车时用屏幕输入行记录 lastInput(origin=pc)', () => {
  const h = harness({ inputLine: '电脑上打的' });
  h.ps.start(); h.ps._pollReady();
  h.ps.onPcKeys('\r');
  assert.strictEqual(h.written[0], '\r');
  assert.strictEqual(h.session.lastInput.origin, 'pc');
  assert.strictEqual(h.session.lastInput.text, '电脑上打的');
  assert.strictEqual(h.events.filter((e) => e.type === 'pc-input').length, 1);
});

test('kill 清空积压并派发 exit 事件', () => {
  const h = harness();
  h.ps.start();
  h.ps.submitText('一', 'phone');
  h.ps.kill();
  assert.strictEqual(h.ps.status, 'closed');
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'exit').map((e) => e.code), [0]);
  assert.strictEqual(h.ps._queue.pending(), 0);
});

test('snapshot 只暴露可序列化字段', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  const snap = h.ps.snapshot();
  assert.deepStrictEqual(
    Object.keys(snap).sort(),
    ['agent', 'alias', 'chatId', 'cwd', 'id', 'lastInput', 'pending', 'status'],
  );
});

// ---- 必须补充的用例 ----

function throwingHarness() {
  const written = [];
  const events = [];
  let dataHandler = () => {};
  let exitHandler = () => {};
  let failNextWrite = true;

  const pty = {
    onData(fn) { dataHandler = fn; },
    onExit(fn) { exitHandler = fn; },
    write(s) {
      if (failNextWrite) { failNextWrite = false; throw new Error('pty boom'); }
      written.push(s);
    },
    kill() {},
  };

  const screen = {
    write() {},
    isReady: () => true,
    snapshot: () => '',
    inputLine: () => '',
    inInputBox: () => true,
    bracketedPaste: (t) => `\x1b[200~${t}\x1b[201~`,
    resize() {},
    dispose() {},
  };

  const session = {
    id: 's1', agent: 'claude', cwd: 'D:/w', status: 'idle', inputSeq: 0, lastInput: null,
  };

  const ps = createPtySession({
    session,
    launch: () => ({ file: 'node', args: [], cwd: 'D:/w' }),
    ptyFactory: () => pty,
    screenFactory: () => screen,
    queueFactory: createQueue,
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => events.push(e),
  });

  return { ps, written, events, session, emitExit(code) { exitHandler({ exitCode: code }); } };
}

test('PTY 写入抛错时回滚状态、派发 error，随后仍能正常提交', () => {
  const h = throwingHarness();
  h.ps.start(); h.ps._pollReady();

  h.ps.submitText('会失败', 'phone');
  assert.strictEqual(h.events.filter((e) => e.type === 'error').length, 1);
  assert.strictEqual(h.ps.status, 'idle');
  assert.strictEqual(h.session.status, 'idle');

  h.ps.submitText('会成功', 'phone');
  assert.deepStrictEqual(h.written, ['\x1b[200~会成功\x1b[201~\r']);
  assert.strictEqual(h.ps.status, 'running');
});

test('kill 之后 submitText 不再写入并返回 closed', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.kill();
  const before = h.written.length;
  const result = h.ps.submitText('迟到的话', 'phone');
  assert.strictEqual(result, 'closed');
  assert.strictEqual(h.written.length, before);
  const inputEvents = h.events.filter((e) => e.type === 'input');
  assert.strictEqual(inputEvents.length, 1);
  assert.strictEqual(inputEvents[0].queued, false);
});

test('进程退出后提交不写入', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.emitExit(0);
  assert.strictEqual(h.ps.status, 'closed');
  const result = h.ps.submitText('退出后的话', 'phone');
  assert.strictEqual(result, 'closed');
  assert.strictEqual(h.written.length, 0);
  assert.strictEqual(h.events.filter((e) => e.type === 'exit').length, 1);
});

test('agent 自然退出后对原始 pty 调一次 kill（释放 conout Worker）', () => {
  const h = harness();
  h.ps.start();
  h.ps._pollReady();
  assert.strictEqual(h.ps.status, 'idle');
  h.emitExit(0);
  assert.strictEqual(h.ps.status, 'closed');
  assert.strictEqual(h.killCalls, 1, '自然退出后必须补一次 pty.kill()，否则 conout Worker 泄漏');
  assert.strictEqual(h.events.filter((e) => e.type === 'exit').length, 1, 'exit 事件不能重复');
});

// ---- 事件契约对齐用例 ----

test('PTY 输出同时写入屏幕并派发 data 事件', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.emitData('hello world');
  const dataEvents = h.events.filter((e) => e.type === 'data');
  assert.strictEqual(dataEvents.length, 1);
  assert.strictEqual(dataEvents[0].data, 'hello world');
  assert.strictEqual(h.screenText(), 'hello world');
});

test('spawned 事件只带 pid，不带 file/cwd', () => {
  const h = harness();
  h.ps.start();
  const spawned = h.events.filter((e) => e.type === 'spawned');
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].pid, 4242);
  assert.strictEqual('file' in spawned[0], false);
  assert.strictEqual('cwd' in spawned[0], false);
});

test('launch 收到 session，ptyFactory 按 (file, args, opts) 三参调用', () => {
  const h = harness();
  h.ps.start();
  assert.strictEqual(h.launchCalls.length, 1);
  assert.strictEqual(h.launchCalls[0][0], h.session);

  assert.strictEqual(h.factoryCalls.length, 1);
  const { file, args, opts } = h.factoryCalls[0];
  assert.strictEqual(file, 'node');
  assert.deepStrictEqual(args, ['x.js']);
  assert.strictEqual(opts.name, 'xterm-256color');
  assert.strictEqual(opts.cols, 120);
  assert.strictEqual(opts.rows, 30);
  assert.strictEqual(opts.cwd, 'D:/w');
  assert.strictEqual(opts.env.TERM, 'xterm-256color');
  assert.strictEqual(opts.env.FORCE_COLOR, '1');
});

test('非 force 提交派发 input 事件（queued=true，input 为同一 lastInput）', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('你好', 'phone');
  const evs = h.events.filter((e) => e.type === 'input');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].queued, true);
  assert.strictEqual(evs[0].input, h.session.lastInput);
  assert.deepStrictEqual(Object.keys(evs[0].input), ['seq', 'origin', 'text', 'at']);
});

test('非 force 提交派发 input 事件（队列满 queued=false）', () => {
  const h = harness();
  const ps = createPtySession({
    session: h.session,
    launch: () => ({ file: 'node', args: [], cwd: 'D:/w' }),
    ptyFactory: () => ({ pid: 1, onData() {}, onExit() {}, write(s) { h.written.push(s); }, kill() {} }),
    screenFactory: () => ({ write() {}, isReady: () => false, snapshot: () => '', inputLine: () => '', inInputBox: () => true, bracketedPaste: (t) => t, resize() {}, dispose() {} }),
    queueFactory: (o) => createQueue({ ...o, limit: 1 }),
    log: { info() {}, warn() {}, error() {} },
    onEvent: (e) => h.events.push(e),
  });
  ps.start();
  ps.submitText('一', 'phone');
  const first = h.session.lastInput;
  ps.submitText('二', 'phone');
  const evs = h.events.filter((e) => e.type === 'input');
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].queued, true);
  assert.strictEqual(evs[0].input, first);
  assert.strictEqual(evs[1].queued, false);
  assert.strictEqual(evs[1].input, h.session.lastInput);
});

test('force 提交返回 queued 且派发 input（queued=false, forced=true）', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.setInBox(false);
  const result = h.ps.submitText('照样发', 'phone', { force: true });
  assert.strictEqual(result, 'queued');
  const evs = h.events.filter((e) => e.type === 'input');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].queued, false);
  assert.strictEqual(evs[0].forced, true);
  assert.strictEqual(evs[0].input, h.session.lastInput);
});

test('onPcKeys 收到换行也触发 pc-input，input 是完整 lastInput', () => {
  const h = harness({ inputLine: '换行输入' });
  h.ps.start(); h.ps._pollReady();
  h.ps.onPcKeys('\n');
  assert.strictEqual(h.written[0], '\n');
  const evs = h.events.filter((e) => e.type === 'pc-input');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].input, h.session.lastInput);
  assert.deepStrictEqual(evs[0].input, { seq: 1, origin: 'pc', text: '换行输入', at: 1000 });
  assert.strictEqual(evs[0].text, undefined);
  assert.strictEqual(evs[0].seq, undefined);
});

test('lastInput 键序为 seq,origin,text,at（手机与电脑端一致）', () => {
  const h = harness({ inputLine: 'pc 端' });
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('手机端', 'phone');
  assert.deepStrictEqual(Object.keys(h.session.lastInput), ['seq', 'origin', 'text', 'at']);
  h.ps.onPcKeys('\r');
  assert.deepStrictEqual(Object.keys(h.session.lastInput), ['seq', 'origin', 'text', 'at']);
});

// ---- 关闭态 input 事件契约 ----

test('关闭态提交派发 input 事件保留上一条 lastInput 且标记 rejected', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('第一条', 'phone');
  const valid = h.session.lastInput;
  h.ps.kill();
  const result = h.ps.submitText('迟到的话', 'phone');
  assert.strictEqual(result, 'closed');
  const evs = h.events.filter((e) => e.type === 'input');
  assert.strictEqual(evs.length, 2);
  const rejected = evs[1];
  assert.strictEqual(rejected.input, valid);
  assert.strictEqual(rejected.queued, false);
  assert.strictEqual(rejected.rejected, true);
  assert.strictEqual(rejected.reason, 'closed');
  assert.strictEqual(h.session.lastInput, valid);
});

// ---- starting 期间按键不得推进状态 ----

test('starting 期间 onPcKeys 回车透传但不推进状态，随后仍能 emit 一次 ready', () => {
  const h = harness();
  h.ps.start();
  h.ps.onPcKeys('\r');
  assert.strictEqual(h.ps.status, 'starting');
  assert.deepStrictEqual(h.written, ['\r']);
  assert.strictEqual(h.events.filter((e) => e.type === 'pc-input').length, 0);
  assert.strictEqual(h.session.lastInput, null);
  h.ps._pollReady();
  assert.strictEqual(h.ps.status, 'idle');
  assert.strictEqual(h.events.filter((e) => e.type === 'ready').length, 1);
});

// ---- disposed 后不再派发 data（F4 / 变异 8） ----

test('进程退出后 PTY 再输出不产生 data 事件', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.emitExit(0);
  h.emitData('退出后的输出');
  assert.strictEqual(h.events.filter((e) => e.type === 'data').length, 0);
  assert.strictEqual(h.screenText(), '');
});

// ---- 变异 1：snapshot().pending 必须用 pending() 而非 size() ----

test('snapshot().pending 只统计排队项，不含正在写入的 turn', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('一', 'phone');
  assert.strictEqual(h.ps._queue.inFlight(), true);
  assert.strictEqual(h.ps.snapshot().pending, 0);
  assert.strictEqual(h.ps._queue.size(), 1);
  h.ps.submitText('二', 'phone');
  assert.strictEqual(h.ps.snapshot().pending, 1);
  assert.strictEqual(h.ps._queue.size(), 2);
});

// ---- 变异 2：releaseTurn 的 status !== 'running' 守卫 ----

test('releaseTurn 在非 running 状态不改写队列', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.submitText('一', 'phone');
  h.setInBox(false);
  h.ps.submitText('二', 'phone');
  h.ps.releaseTurn(); // running→idle，但画面不在输入框，不写
  assert.strictEqual(h.ps.status, 'idle');
  assert.strictEqual(h.written.length, 1);
  h.setInBox(true);
  h.ps.releaseTurn(); // idle 状态下调用，守卫应直接返回、不写
  assert.strictEqual(h.written.length, 1);
  assert.strictEqual(h.ps._queue.pending(), 1);
});

// ---- 变异 3：env 必须继承宿主环境变量 ----

test('ptyFactory 的 env 继承宿主 PATH', () => {
  const h = harness();
  h.ps.start();
  assert.strictEqual(h.factoryCalls[0].opts.env.PATH, process.env.PATH);
});

// 先把桥从终端里起一遍就会发现：宿主是 Claude Code 时，环境里的会话标记会让子 claude
// 打出「Transcript saving is off」，输入框判定失败，消息永远卡在队列里。
test('ptyFactory 的 env 剔除宿主 Claude Code 会话标记', () => {
  const markers = [
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'AI_AGENT',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID',
  ];
  const saved = {};
  for (const k of markers) { saved[k] = process.env[k]; process.env[k] = 'x'; }
  try {
    const h = harness();
    h.ps.start();
    const env = h.factoryCalls[0].opts.env;
    for (const k of markers) assert.strictEqual(k in env, false, `${k} 不应传给子进程`);
    assert.strictEqual(env.PATH, process.env.PATH);
    assert.strictEqual(env.TERM, 'xterm-256color');
  } finally {
    for (const k of markers) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---- 变异 4：先写屏幕再派发 data ----

test('PTY 输出先写屏幕再派发 data 事件', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.order.length = 0;
  h.emitData('x');
  assert.deepStrictEqual(h.order, ['screen', 'event']);
});

// ---- 变异 5：无 alias 时 snapshot().alias 严格为 null ----

test('session 无 alias 时 snapshot().alias 严格为 null', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  assert.strictEqual(h.ps.snapshot().alias, null);
});

// ---- 变异 6：普通字符不得触发 pc-input ----

test('onPcKeys 普通字符不产生 pc-input、不改 lastInput', () => {
  const h = harness();
  h.ps.start(); h.ps._pollReady();
  h.ps.onPcKeys('a');
  assert.deepStrictEqual(h.written, ['a']);
  assert.strictEqual(h.events.filter((e) => e.type === 'pc-input').length, 0);
  assert.strictEqual(h.session.lastInput, null);
  assert.strictEqual(h.ps.status, 'idle');
});

// ---- 变异 7：ready 必须先于排队的 turn-start ----

test('就绪时先派发 ready 再写出排队 turn（turn-start 在后）', () => {
  const h = harness();
  h.ps.start();
  h.ps.submitText('一', 'phone');
  h.ps._pollReady();
  const readyIdx = h.events.findIndex((e) => e.type === 'ready');
  const turnIdx = h.events.findIndex((e) => e.type === 'turn-start');
  assert.ok(readyIdx >= 0 && turnIdx >= 0);
  assert.ok(readyIdx < turnIdx, `ready(${readyIdx}) 应在 turn-start(${turnIdx}) 之前`);
});

// ---- Codex 轮次结束判定（无 Stop hook，靠画面静默稳定） ----

test('codex 轮次结束：画面静默稳定后派发 turn-end 并回到 idle', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');

  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0); // 还没过 1.5s

  h.setNow(7000);
  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 1);
  assert.strictEqual(h.ps.status, 'idle');
});

test('codex 还在刷屏时不判结束', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');
  h.setReady(false);

  h.setNow(9000);
  for (let i = 0; i < 10; i += 1) h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);
  assert.strictEqual(h.ps.status, 'running');
});

test('codex 画面停在菜单（不在输入框）时不判结束', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');
  h.setInBox(false);

  h.setNow(9000);
  for (let i = 0; i < 10; i += 1) h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);
});

test('claude 会话不会误发 turn-end（它走 Stop hook）', () => {
  const h = harness({ agent: 'claude' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('你好', 'phone');

  h.setNow(9000);
  for (let i = 0; i < 10; i += 1) h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);
  assert.strictEqual(h.ps.status, 'running');
});

test('codex 电脑端手打 Enter 进入 running 后同样计时判定结束', () => {
  const h = harness({ agent: 'codex', inputLine: 'abc' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.onPcKeys('abc\r');
  assert.strictEqual(h.ps.status, 'running');

  h.setNow(6000); // 距写入仅 1000ms，未满 1.5s
  for (let i = 0; i < 5; i += 1) h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0);

  h.setNow(7000); // 距写入 2000ms，满 1.5s
  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();

  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 1);
  assert.strictEqual(h.ps.status, 'idle');
});

// ---- 任务20 修复：turn-end 必须先于下一条 turn-start ----

test('codex 连发两条时先发 turn-end 再泵出队列里的下一条 turn-start', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('先写 A', 'phone');
  h.ps.submitText('再写 B', 'phone');
  assert.strictEqual(h.ps._queue.pending(), 1); // B 在队列里等 A 结束

  h.setNow(7000); // 距 A 开始 2000ms，满 1.5s
  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();

  const types = h.events.map((e) => e.type);
  const endIdx = types.indexOf('turn-end');
  const nextStartIdx = types.indexOf('turn-start', endIdx + 1);
  assert.ok(endIdx >= 0, '应派发 turn-end');
  assert.ok(
    nextStartIdx > endIdx,
    `下一条 turn-start(${nextStartIdx}) 必须在 turn-end(${endIdx}) 之后`,
  );
  assert.deepStrictEqual(types.slice(-2), ['turn-end', 'turn-start']);
  assert.strictEqual(h.ps.status, 'running'); // B 已被泵出，会话继续运行
});

test('codex 稳定性必须连续：中途一次不稳定会重置计数', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');

  h.setNow(7000);
  h.ps._pollReady();
  h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 0); // 才 2 次稳定

  h.setInBox(false);
  h.ps._pollReady(); // 不稳定，计数清零
  h.setInBox(true);

  h.ps._pollReady();
  h.ps._pollReady();
  assert.strictEqual(
    h.events.filter((e) => e.type === 'turn-end').length,
    0,
    '重置后仅 2 次稳定不应结束',
  );
  assert.strictEqual(h.ps.status, 'running');

  h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 1);
  assert.strictEqual(h.ps.status, 'idle');
});

test('codex 回到 idle 后继续轮询不会重复派发 turn-end（running 守卫）', () => {
  const h = harness({ agent: 'codex' });
  h.ps.start(); h.ps._pollReady();
  h.setNow(5000);
  h.ps.submitText('写个快排', 'phone');

  h.setNow(7000);
  h.ps._pollReady();
  h.ps._pollReady();
  h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 1);
  assert.strictEqual(h.ps.status, 'idle');

  h.setNow(9000);
  for (let i = 0; i < 5; i += 1) h.ps._pollReady();
  assert.strictEqual(h.events.filter((e) => e.type === 'turn-end').length, 1);
});

test('resize：合法尺寸转发给屏幕与 PTY，非法尺寸忽略', () => {
  const h = harness();
  h.ps.start();
  h.ps.resize(100, 30);
  h.ps.resize(0, 30);
  h.ps.resize(100, -1);
  assert.deepStrictEqual(h.resized, [[100, 30]]);
  assert.deepStrictEqual(h.screenResized, [[100, 30]]);
});
