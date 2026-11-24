const test = require('node:test');
const assert = require('node:assert');
const { createScreen } = require('../src/screen');

function fakeTerminal(opts) {
  const t = {
    opts,
    lines: ['line0', 'line1', 'line2', 'line3'],
    wrapped: new Set(),
    writes: [],
    modes: { bracketedPasteMode: true },
    buffer: {
      active: {
        baseY: 0,
        cursorY: 3,
        cursorX: 0,
        length: 4,
        getLine(y) {
          if (y < 0 || y >= t.lines.length) return undefined;
          return {
            isWrapped: t.wrapped.has(y),
            translateToString: () => t.lines[y],
          };
        },
      },
    },
    write(data, cb) {
      t.writes.push(data);
      if (cb) setImmediate(cb);
    },
    resize(c, r) { t.size = [c, r]; },
    dispose() { t.disposed = true; },
  };
  return t;
}

function setup({ quietMs = 400 } = {}) {
  let terminal;
  let clock = 10_000;
  const screen = createScreen({
    quietMs,
    now: () => clock,
    terminalFactory: (opts) => (terminal = fakeTerminal(opts)),
  });
  return { screen, terminal: () => terminal, advance: (ms) => { clock += ms; } };
}

test('构造时传 allowProposedApi，否则 buffer 不可用', () => {
  const { terminal } = setup();
  assert.strictEqual(terminal().opts.allowProposedApi, true);
  assert.strictEqual(terminal().opts.cols, 120);
  assert.strictEqual(terminal().opts.rows, 30);
  assert.strictEqual(terminal().opts.scrollback, 1000);
});

test('write 转发到终端并等解析完成', async () => {
  const { screen, terminal } = setup();
  await screen.write('hello');
  assert.deepStrictEqual(terminal().writes, ['hello']);
});

test('没收到数据前 isReady 为 false；收到后需静默满 quietMs', async () => {
  const { screen, terminal, advance } = setup({ quietMs: 400 });
  assert.strictEqual(screen.isReady(), false);

  await screen.write('x');
  assert.strictEqual(screen.isReady(), false);
  advance(399);
  assert.strictEqual(screen.isReady(), false);
  advance(1);
  assert.strictEqual(screen.isReady(), true);

  await screen.write('y');
  assert.strictEqual(screen.isReady(), false);
  assert.ok(terminal().writes.length === 2);
});

test('bracketedPaste 按终端当前模式包裹', () => {
  const { screen, terminal } = setup();
  assert.strictEqual(screen.bracketedPaste('你好'), '\x1b[200~你好\x1b[201~');

  terminal().modes.bracketedPasteMode = false;
  assert.strictEqual(screen.bracketedPaste('你好'), '你好');
});

test('snapshot 取最近 N 行并去掉尾部空行', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['a', 'b', 'c', 'd', 'e', ''];
  terminal().buffer.active.cursorY = 5;
  // 光标在第 5 行，取最近 3 行即 y=3..5：'d'、'e'、末尾空行（被裁掉）
  const text = screen.snapshot({ lines: 3 });
  assert.strictEqual(text, 'd\ne');
});

test('snapshot 用 baseY + cursorY 定位，不用 cursorY', () => {
  const { screen, terminal } = setup();
  terminal().buffer.active.baseY = 100;
  terminal().buffer.active.cursorY = 2;
  terminal().lines = ['a', 'b', 'c', 'd', 'e'];
  terminal().buffer.active.getLine = (y) => ({
    isWrapped: false,
    translateToString: () => `row${y}`,
  });
  const text = screen.snapshot({ lines: 3 });
  assert.strictEqual(text, 'row100\nrow101\nrow102');
});

test('snapshot 拼接被自动换行的物理行', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['abc', 'def', 'X'];
  terminal().buffer.active.cursorY = 2;
  terminal().wrapped.add(1);
  assert.strictEqual(screen.snapshot({ lines: 3 }), 'abcdef\nX');
});

test('inputLine 取最近一行 ❯ 提示符后面的内容', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['前一屏输出', '❯ 现在几点了'];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inputLine(), '现在几点了');

  terminal().lines = ['❯ 旧输入', '输出', '❯ '];
  terminal().buffer.active.cursorY = 2;
  assert.strictEqual(screen.inputLine(), '');
});

test('inInputBox：有 ❯ 输入框为 true，菜单光标/无提示符为 false', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['输出', '❯ '];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), true);

  terminal().lines = ['Do you want to proceed?', '❯ 1. Yes', '  2. No, tell Claude what to do differently'];
  terminal().buffer.active.cursorY = 2;
  assert.strictEqual(screen.inInputBox(), false);

  terminal().lines = ['PS D:\\feishu-workspace> '];
  terminal().buffer.active.cursorY = 0;
  assert.strictEqual(screen.inInputBox(), false);
});

test('inputLine / inInputBox 支持 Codex 的 › 提示符', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['› 你好，Codex'];
  terminal().buffer.active.cursorY = 0;
  assert.strictEqual(screen.inInputBox(), true);
  assert.strictEqual(screen.inputLine(), '你好，Codex');
});

test('inInputBox 不把信任弹窗与正文中出现的提示符误判为输入框', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['❯ No, exit', '   Yes, I trust this folder'];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), false);

  terminal().lines = ['输出里提到提示符 ❯ 只是文档说明'];
  terminal().buffer.active.cursorY = 0;
  assert.strictEqual(screen.inInputBox(), false);
});

test('inInputBox 允许状态页脚位于提示符行下方', () => {
  const { screen, terminal } = setup();
  terminal().lines = [
    '❯ ',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)   ? for shortcuts',
  ];
  terminal().rows = 2;
  terminal().buffer.active.cursorY = 0;
  assert.strictEqual(screen.inInputBox(), true);
});

test('inInputBox：草稿中提及菜单关键字不被误判', () => {
  const { screen, terminal } = setup();
  terminal().lines = [
    '❯ please explain "enter to confirm"',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)   ? for shortcuts',
  ];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), true);
});

test('inInputBox：草稿折行续行含菜单关键字不被误判', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['❯ 第一行', 'esc to cancel 只是草稿的自动折行续行'];
  terminal().wrapped.add(1);
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), true);
});

test('inInputBox：真实菜单页脚被识别为菜单', () => {
  const { screen, terminal } = setup();
  terminal().lines = ['❯ 1. Yes', 'Press enter to confirm or esc to cancel'];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), false);
});

test('inInputBox：菜单页脚同时带快捷键提示仍识别为菜单', () => {
  const { screen, terminal } = setup();
  terminal().lines = [
    '❯ 1. Yes',
    '  ↑/↓ to navigate · enter to select · esc to cancel · ctrl+c to exit',
  ];
  terminal().buffer.active.cursorY = 1;
  assert.strictEqual(screen.inInputBox(), false);
});

test('write 未解析完成时 isReady 为 false', () => {
  let finish;
  let clock = 10_000;
  let terminal;
  const screen = createScreen({
    quietMs: 400,
    now: () => clock,
    terminalFactory: (opts) => {
      terminal = fakeTerminal(opts);
      terminal.write = (data, cb) => {
        terminal.writes.push(data);
        finish = cb;
      };
      return terminal;
    },
  });

  screen.write('x');
  clock += 1000; // 即使早已超过静默阈值，仍有待解析写入
  assert.strictEqual(screen.isReady(), false);
  finish();
  assert.strictEqual(screen.isReady(), true);
});

test('resize / dispose 透传', () => {
  const { screen, terminal } = setup();
  screen.resize(100, 20);
  assert.deepStrictEqual(terminal().size, [100, 20]);
  screen.dispose();
  assert.strictEqual(terminal().disposed, true);
  assert.strictEqual(screen.isReady(), false);
});
