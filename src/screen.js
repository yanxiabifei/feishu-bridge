const { Terminal } = require('@xterm/headless');

const BRACKET_OPEN = '\x1b[200~';
const BRACKET_CLOSE = '\x1b[201~';

function createScreen({
  cols = 120,
  rows = 30,
  scrollback = 5000,
  quietMs = 400,
  now = () => Date.now(),
  terminalFactory = (opts) => new Terminal(opts),
} = {}) {
  // allowProposedApi 必须为 true，否则访问 term.buffer 会直接抛错
  const term = terminalFactory({ cols, rows, scrollback, allowProposedApi: true });
  let lastDataAt = 0;
  let disposed = false;

  // 取末尾 n 个物理行（不拼接换行），去掉尾部空行
  function tailLines(n) {
    const buf = term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const start = Math.max(0, end - n + 1);
    const out = [];
    for (let y = start; y <= end; y += 1) {
      const line = buf.getLine(y);
      if (line) out.push(line.translateToString(true));
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  const screen = {
    write(data) {
      if (disposed) return Promise.resolve();
      lastDataAt = now();
      return new Promise((resolve) => term.write(data, resolve));
    },

    get bracketedPasteMode() {
      return Boolean(term.modes && term.modes.bracketedPasteMode);
    },

    bracketedPaste(text) {
      return screen.bracketedPasteMode
        ? `${BRACKET_OPEN}${text}${BRACKET_CLOSE}`
        : text;
    },

    isReady() {
      return !disposed && lastDataAt > 0 && now() - lastDataAt >= quietMs;
    },

    snapshot({ lines = 40 } = {}) {
      if (disposed) return '';
      const buf = term.buffer.active;
      // 当前光标所在的绝对缓冲区行 = baseY + cursorY
      const end = buf.baseY + buf.cursorY;
      const start = Math.max(0, end - lines + 1);
      const out = [];
      for (let y = start; y <= end; y += 1) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
        else out.push(text);
      }
      while (out.length > 0 && out[out.length - 1] === '') out.pop();
      return out.join('\n');
    },

    inputLine() {
      if (disposed) return '';
      const lines = tailLines(12);
      // 从下往上找最近的 ❯ 提示符，取提示符之后的内容
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const m = lines[i].match(/❯\s*(.*)$/);
        if (m) return m[1].trim();
      }
      // 没有提示符（例如 shell 提示符）时退回最后一行非空文本
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]) return lines[i].trim();
      }
      return '';
    },

    inInputBox() {
      if (disposed) return false;
      const lines = tailLines(15);
      let idx = -1;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].includes('❯')) { idx = i; break; }
      }
      if (idx < 0) return false;
      // 菜单/确认弹窗的光标也是 ❯，但它后面跟着「1. Yes」这类序号
      return !/^❯?\s*\d+[.)]\s/.test(lines[idx].trim());
    },

    resize(nextCols, nextRows) {
      if (!disposed) term.resize(nextCols, nextRows);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },

    get lastDataAt() {
      return lastDataAt;
    },
  };

  return screen;
}

module.exports = { createScreen };
