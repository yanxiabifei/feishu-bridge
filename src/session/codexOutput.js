// Codex TUI 的输入框是屏幕最后一条以 › 开头的行（空框显示占位符
// "› Ask Codex to do anything"），框下只剩 model/目录和 "? for shortcuts" 页脚。
// 取最近 40 行当「Codex 输出」时这些尾巴会一起进卡片，推送前把它们切掉。
const PROMPT_RE = /^\s*[❯›]/;

function cleanCodexSnapshot(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');

  let keep = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (PROMPT_RE.test(lines[i])) { keep = i; break; }
  }

  const out = [];
  for (const line of lines.slice(0, keep)) {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(trimmed);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

module.exports = { cleanCodexSnapshot };
