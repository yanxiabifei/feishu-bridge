const MAX_CARD_CHARS = 8000;
const TAIL_CHARS = 1500;

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

function truncate(text, limit = MAX_CARD_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return { text: value, truncated: false };
  const tailLen = Math.min(TAIL_CHARS, Math.max(0, limit));
  let headEnd = Math.max(0, limit - tailLen);
  let tailStart = value.length - tailLen;
  // 截断点落在代理对中间会留下孤立代理项，卡片里显示成乱码
  if (headEnd > 0 && isHighSurrogate(value.charCodeAt(headEnd - 1))) headEnd -= 1;
  if (tailLen > 0 && isLowSurrogate(value.charCodeAt(tailStart))) tailStart += 1;
  const head = value.slice(0, headEnd);
  const tail = tailLen > 0 ? value.slice(tailStart) : '';
  const omitted = Math.max(0, tailStart - headEnd);
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
