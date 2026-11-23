const test = require('node:test');
const assert = require('node:assert');
const { createPtySession } = require('../src/session/ptySession');
const { createQueue } = require('../src/session/queue');

function harness(overrides = {}) {
  const written = [];
  const events = [];
  const launchCalls = [];
  const factoryCalls = [];
  let dataHandler = () => {};
  let exitHandler = () => {};
  let ready = true;

  const pty = {
    pid: 4242,
    onData(fn) { dataHandler = fn; },
    onExit(fn) { exitHandler = fn; },
    write(s) { written.push(s); },
    kill() { exitHandler({ exitCode: 0 }); },
  };

  const screen = {
    write(d) { lastScreen += d; },
    isReady: () => ready,
    snapshot: () => 'screen-tail',
    inputLine: () => overrides.inputLine || '输入中的话',
    inInputBox: () => inBox,
    bracketedPaste: (t) => `\x1b[200~${t}\x1b[201~`,
    resize() {},
    dispose() {},
  };
  let lastScreen = '';
  let inBox = true;

  const session = {
    id: 's1', agent: 'claude', cwd: 'D:/w', status: 'idle', inputSeq: 0, lastInput: null,
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
    onEvent: (e) => events.push(e),
    now: () => 1000,
  });

  return {
    ps, written, events, session, launchCalls, factoryCalls,
    screenText() { return lastScreen; },
    setReady(v) { ready = v; },
    setInBox(v) { inBox = v; },
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
