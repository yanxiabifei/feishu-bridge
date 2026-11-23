const { Terminal } = require('@xterm/headless');

const BRACKET_OPEN = '\x1b[200~';
const BRACKET_CLOSE = '\x1b[201~';

// 提示符必须锚定行首：Claude Code 用 ❯(U+276F)，Codex 用 ›(U+203A)
const PROMPT_RE = /^\s*[❯›]\s*/;
// 输入框下方的状态栏/页脚形状（页脚允许出现在提示符行下方）
const STATUS_RE = /(shift\+tab|for shortcuts|bypass permissions|esc to interrupt|\bctrl\+[a-z]\b|^\s*[─━]{3,}\s*$)/i;
// 菜单/确认弹窗的提示关键字，出现即不当作输入框
const MENU_RE = /esc to cancel|enter to confirm|enter to select|↑\/↓|to navigate/i;

function createScreen({
  cols = 120,
  rows = 30,
  // scrollback 决定保留多少历史行：每行约 1.4KB（120 列），5000 行约 7MB/会话；
  // snapshot 最多只用 40 行，故默认降到 1000，仍可按需覆盖。
  scrollback = 1000,
  quietMs = 400,
  now = () => Date.now(),
  terminalFactory = (opts) => new Terminal(opts),
} = {}) {
  // allowProposedApi 必须为 true，否则访问 term.buffer 会直接抛错
  const term = terminalFactory({ cols, rows, scrollback, allowProposedApi: true });
  let lastDataAt = 0;
  let pendingWrites = 0;
  let disposed = false;

  // 读取 y <= endRow 的末尾 n 个物理行（保留 isWrapped，供折行拼接/续行判定）
  function readLines(endRow, n) {
    const buf = term.buffer.active;
    const end = Math.max(0, endRow);
    const start = Math.max(0, end - n + 1);
    const out = [];
    for (let y = start; y <= end; y += 1) {
      const line = buf.getLine(y);
      if (line) {
        out.push({
          text: line.translateToString(true),
          wrapped: line.isWrapped,
        });
      }
    }
    return out;
  }

  // 输入检测用的尾部窗口：以视口底部为终点（而不是光标行），
  // 因为 Claude Code 的状态页脚可能渲染在光标所在输入行的下方。
  function inputTail(n) {
    const buf = term.buffer.active;
    const viewportRows = term.rows || buf.cursorY + 1;
    const end = buf.baseY + Math.max(0, viewportRows - 1);
    const out = readLines(end, n);
    while (out.length > 0 && out[out.length - 1].text === '') out.pop();
    return out;
  }

  function lastPromptIndex(lines) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (PROMPT_RE.test(lines[i].text)) return i;
    }
    return -1;
  }

  const screen = {
    write(data) {
      if (disposed) return Promise.resolve();
      pendingWrites += 1;
      lastDataAt = now();
      return new Promise((resolve) => {
        term.write(data, () => {
          pendingWrites -= 1;
          resolve();
        });
      });
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
      // 必须「无待解析写入」且「距最后一次写入静默满 quietMs」
      return (
        !disposed &&
        pendingWrites === 0 &&
        lastDataAt > 0 &&
        now() - lastDataAt >= quietMs
      );
    },

    snapshot({ lines = 40 } = {}) {
      if (disposed) return '';
      const buf = term.buffer.active;
      // alternate buffer 的光标可能不在底部，按整屏取；普通缓冲保持 baseY + cursorY
      const end =
        buf.type === 'alternate'
          ? buf.length - 1
          : buf.baseY + buf.cursorY;
      const physical = readLines(end, lines);
      while (physical.length > 0 && physical[physical.length - 1].text === '') {
        physical.pop();
      }
      const out = [];
      for (const line of physical) {
        if (line.wrapped && out.length > 0) out[out.length - 1] += line.text;
        else out.push(line.text);
      }
      return out.join('\n');
    },

    inputLine() {
      if (disposed) return '';
      const lines = inputTail(30);
      const idx = lastPromptIndex(lines);
      if (idx < 0) return '';
      // 提示符之后的内容，并拼接长草稿自动折行产生的续行
      let out = lines[idx].text.replace(PROMPT_RE, '');
      for (let i = idx + 1; i < lines.length; i += 1) {
        if (!lines[i].wrapped) break;
        out += lines[i].text;
      }
      return out.trim();
    },

    inInputBox() {
      if (disposed) return false;
      const lines = inputTail(30);
      // 菜单/确认弹窗的提示关键字：只要出现在尾部就不当作输入框
      if (lines.some((line) => MENU_RE.test(line.text))) return false;
      const idx = lastPromptIndex(lines);
      if (idx < 0) return false;
      // 提示符之后的每个非空物理行，要么是折行续行，要么是状态页脚；
      // 弹窗选项（"Yes, I trust this folder"）与菜单项（"2. No..."）都不满足。
      for (let i = idx + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.text === '') continue;
        if (line.wrapped) continue;
        if (STATUS_RE.test(line.text)) continue;
        return false;
      }
      return true;
    },

    resize(nextCols, nextRows) {
      if (!disposed) term.resize(nextCols, nextRows);
    },

    // dispose 契约：之后 write() 静默丢弃、isReady() 恒为 false、resize() 无操作
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
