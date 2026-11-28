const test = require('node:test');
const assert = require('node:assert');
const { createScreen } = require('../src/screen');

// 这些用例使用真实的 @xterm/headless（不注入 terminalFactory），
// 覆盖 escape 序列、宽字符折行、alternate buffer 等假终端无法模拟的行为。
function realScreen(opts = {}) {
  return createScreen({ cols: 120, rows: 30, ...opts });
}

test('真实终端：120 列内长中文草稿折行后 inputLine 拼回完整输入', async () => {
  const screen = realScreen();
  try {
    const draft = '中文输入测试'.repeat(25);
    await screen.write(`❯ ${draft}`);
    assert.strictEqual(screen.inputLine(), draft);
    assert.strictEqual(screen.inInputBox(), true);
  } finally {
    screen.dispose();
  }
});

test('真实终端：CSI ?2004 真实切换 bracketedPasteMode', async () => {
  const screen = realScreen();
  try {
    await screen.write('\x1b[?2004h');
    assert.strictEqual(screen.bracketedPasteMode, true);
    assert.strictEqual(
      screen.bracketedPaste('你好'),
      '\x1b[200~你好\x1b[201~',
    );

    await screen.write('\x1b[?2004l');
    assert.strictEqual(screen.bracketedPasteMode, false);
    assert.strictEqual(screen.bracketedPaste('你好'), '你好');
  } finally {
    screen.dispose();
  }
});

test('真实终端：alt screen 快照包含光标下方内容', async () => {
  const screen = realScreen({ cols: 80, rows: 20 });
  try {
    await screen.write('\x1b[?1049h');
    await screen.write(
      Array.from({ length: 10 }, (_, i) => `LINE${i + 1}`).join('\r\n'),
    );
    // 光标上移 5 行，模拟 alternate buffer 中光标不在底部
    await screen.write('\x1b[5A');

    const text = screen.snapshot();
    assert.match(text, /^LINE1$/m);
    assert.match(text, /^LINE10$/m);
  } finally {
    screen.dispose();
  }
});

test('真实终端：❯ 与 › 两种提示符都识别并剥离', async () => {
  for (const symbol of ['❯', '›']) {
    const screen = realScreen();
    try {
      await screen.write(`${symbol} 手机消息`);
      assert.strictEqual(screen.inInputBox(), true, `提示符 ${symbol}`);
      assert.strictEqual(screen.inputLine(), '手机消息', `提示符 ${symbol}`);
    } finally {
      screen.dispose();
    }
  }
});

test('真实终端：非数字菜单（信任弹窗）不判为输入框', async () => {
  const screen = realScreen();
  try {
    await screen.write('❯ No, exit\r\n   Yes, I trust this folder');
    assert.strictEqual(screen.inInputBox(), false);
  } finally {
    screen.dispose();
  }
});

test('真实终端：状态页脚在输入框下方时仍判为输入框', async () => {
  const screen = realScreen();
  try {
    await screen.write(
      '❯ \r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)   ? for shortcuts',
    );
    assert.strictEqual(screen.inInputBox(), true);
    assert.strictEqual(screen.inputLine(), '');
  } finally {
    screen.dispose();
  }
});

test('真实终端：serialize 还原视口内容与颜色，不带 scrollback', async () => {
  const screen = realScreen({ cols: 40, rows: 6 });
  try {
    const lines = Array.from({ length: 30 }, (_, i) => `LINE${i}`);
    await screen.write(lines.join('\r\n'));
    await screen.write('\r\n\x1b[32mgreen\x1b[0m');
    const ansi = screen.serialize();
    assert.match(ansi, /green/);
    assert.match(ansi, /\x1b\[[0-9;]*32/);
    assert.ok(!ansi.includes('LINE0'), '默认只还原视口，不重放 1000 行 scrollback');
  } finally {
    screen.dispose();
  }
});

test('真实终端：dispose 后 serialize 返回空串', async () => {
  const screen = realScreen();
  await screen.write('x');
  screen.dispose();
  assert.strictEqual(screen.serialize(), '');
});

test('真实终端：正文中出现 ❯ 但未锚定行首时不判为输入框', async () => {
  const screen = realScreen();
  try {
    await screen.write('输出里提到提示符 ❯ 只是文档说明');
    assert.strictEqual(screen.inInputBox(), false);
    assert.strictEqual(screen.inputLine(), '');
  } finally {
    screen.dispose();
  }
});
