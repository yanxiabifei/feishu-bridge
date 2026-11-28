const MAX_CARD_CHARS = 8000;
const TAIL_CHARS = 1500;

function truncate(text, limit = MAX_CARD_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return { text: value, truncated: false };
  const tailLen = Math.min(TAIL_CHARS, Math.max(0, limit));
  const head = value.slice(0, Math.max(0, limit - tailLen));
  const tail = tailLen > 0 ? value.slice(-tailLen) : '';
  const omitted = Math.max(0, value.length - limit);
  return {
    text: `${head}\n\n…（已截断 ${omitted} 字，完整内容请到电脑上看）\n\n${tail}`,
    truncated: true,
  };
}

function card({ title, template = 'blue', elements }) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

const escapeText = (s) => String(s ?? '').replace(/</g, '&#60;');
const ZWSP = String.fromCharCode(0x200b);
const neutralizeFences = (text) => String(text).replace(/`{3,}/g, (m) => m[0] + ZWSP + m.slice(1));
const md = (content) => ({ tag: 'markdown', content });
const note = (content) => ({ tag: 'markdown', content: `<font color='grey'>${escapeText(content)}</font>` });

function footer({ agent, cwd }) {
  const bits = [];
  if (agent) bits.push(agent === 'codex' ? 'Codex' : 'Claude');
  if (cwd) bits.push(cwd);
  return bits.length ? note(bits.join(' · ')) : null;
}

const elements = (...items) => items.filter(Boolean);

function processingCard({ agent, prompt }) {
  return card({
    title: '⏳ 正在处理…',
    template: 'blue',
    elements: elements(
      md(truncate(escapeText(prompt || '（无输入）'), 2000).text),
      { tag: 'hr' },
      footer({ agent }),
    ),
  });
}

function replyCard({ text, agent, cwd }) {
  // 先转义再截断：转义会把 < 变成 5 个字符，反过来做会让最终卡片超出长度上限
  const { text: body, truncated } = truncate(escapeText(text || '（空回复）'));
  return card({
    title: truncated ? '✅ 回复（已截断）' : '✅ 回复',
    template: 'green',
    elements: elements(
      md(body),
      truncated ? note('内容过长已截断，完整输出请到电脑上看。') : null,
      footer({ agent, cwd }),
    ),
  });
}

function screenCard({ text, reason }) {
  const why = reason === 'not-ready'
    ? '会话当前不在可输入状态，下面是你手机屏幕上的内容：'
    : '最近一次会话画面：';
  return card({
    title: '🖥 当前画面',
    template: 'orange',
    elements: elements(
      md(why),
      { tag: 'hr' },
      md('```\n' + neutralizeFences(truncate(escapeText(text || '（无画面）'), 6000).text) + '\n```'),
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '仍然发送' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: { act: 'force-send' } }],
      },
      note('也可以直接回复「仍然发送」四个字。'),
    ),
  });
}

function noticeCard({ title, text, template = 'grey' }) {
  return card({
    title,
    template,
    elements: elements(text ? md(truncate(escapeText(text)).text) : null),
  });
}

function errorCard({ title, text }) {
  return card({
    title,
    template: 'red',
    elements: elements(text ? md(truncate(escapeText(text)).text) : null),
  });
}

function screenOutputCard({ lead, text, agent, cwd }) {
  return card({
    title: '🖥 Codex 输出',
    template: 'turquoise',
    elements: elements(
      lead ? md(escapeText(lead)) : null,
      md('```\n' + neutralizeFences(truncate(escapeText(text || '（无画面）'), 6000).text) + '\n```'),
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '查看完整画面' },
        type: 'default',
        behaviors: [{ type: 'callback', value: { act: 'full-screen', lines: 200 } }],
      },
      footer({ agent, cwd }),
    ),
  });
}

function fullScreenCard({ text, lines }) {
  return card({
    title: `🖥 最近 ${lines} 行`,
    template: 'turquoise',
    elements: elements(md('```\n' + neutralizeFences(truncate(escapeText(text || '（无画面）'), 6000).text) + '\n```')),
  });
}

module.exports = {
  MAX_CARD_CHARS,
  card,
  truncate,
  processingCard,
  replyCard,
  screenCard,
  screenOutputCard,
  fullScreenCard,
  noticeCard,
  errorCard,
};
