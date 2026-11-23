const MAX_CARD_CHARS = 8000;
const TAIL_CHARS = 1500;

function truncate(text, limit = MAX_CARD_CHARS) {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, Math.max(0, limit - TAIL_CHARS));
  const tail = text.slice(-TAIL_CHARS);
  const omitted = Math.max(0, text.length - limit);
  return {
    text: `${head}\n\n…（已截断 ${omitted} 字，完整内容见附件）\n\n${tail}`,
    truncated: true,
  };
}

function card({ title, template = 'blue', elements }) {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

const md = (content) => ({ tag: 'markdown', content });
const note = (content) => ({ tag: 'markdown', content: `<font color='grey'>${content}</font>` });

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
      md(truncate(prompt || '（无输入）', 2000).text),
      { tag: 'hr' },
      footer({ agent }),
    ),
  });
}

function replyCard({ text, agent, cwd }) {
  const { text: body, truncated } = truncate(text || '（空回复）');
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
      md('```\n' + truncate(text || '（无画面）', 6000).text + '\n```'),
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
    elements: elements(text ? md(truncate(text).text) : null),
  });
}

function errorCard({ title, text }) {
  return card({
    title,
    template: 'red',
    elements: elements(text ? md(truncate(text).text) : null),
  });
}

module.exports = {
  MAX_CARD_CHARS,
  card,
  truncate,
  processingCard,
  replyCard,
  screenCard,
  noticeCard,
  errorCard,
};
