function parseContent(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  } catch {
    return {};
  }
}

function postToText(post) {
  const blocks = Array.isArray(post && post.content) ? post.content : [];
  const rawCode = [];
  const lines = blocks.map((line) => (Array.isArray(line) ? line : []).map((el) => {
    if (!el) return '';
    if (el.tag === 'text') return String(el.text || '');
    if (el.tag === 'a') return String(el.text || '') || String(el.href || '');
    if (el.tag === 'at') return el.user_name ? `@${el.user_name}` : '';
    if (el.tag === 'code_block') {
      // 代码块保留原文：用占位符绕过 stripMentions 的 @ 剥离
      const parts = Array.isArray(el.text) ? el.text : [el.text];
      const code = parts.map((p) => String((p && typeof p === 'object' ? p.text : p) || '')).join('');
      if (!code) return '';
      rawCode.push(code);
      return `${rawCode.length - 1}`;
    }
    if (el.tag === 'md') {
      const parts = Array.isArray(el.text) ? el.text : [el.text];
      return parts.map((p) => String((p && typeof p === 'object' ? p.text : p) || '')).join('');
    }
    if (el.tag === 'img') return '[图片]';
    if (el.tag === 'hr') return '---';
    return '';
  }).join(''));
  const body = lines.filter((l) => l !== '').join('\n');
  const title = post && post.title ? String(post.title) : '';
  const text = title ? (body ? `${title}\n${body}` : title) : body;
  return { text, rawCode };
}

// 先标出要删的 @，只收拾它周围的空白。正文里的缩进、空行是用户手打的内容，不能整体压平
const MENTION_MARK = '\uF000'; // 私用区字符，正文里不会出现

function stripMentions(text, mentions) {
  let out = String(text || '');
  for (const m of mentions || []) {
    if (m && m.key) out = out.split(m.key).join(MENTION_MARK);
  }
  out = out.replace(/@_user_\d+/g, MENTION_MARK);
  // 独占一行的 @（群里先 @机器人 再换行写正文很常见）整行删掉，不留空行
  out = out.replace(/^[ \t]*\uF000[ \t]*\r?\n/gm, '');
  // 行内的 @ 连同两侧空白收成一个空格
  out = out.replace(/[ \t]*\uF000[ \t]*/g, ' ');
  out = out.replace(/\uF000/g, '');
  return out.trim();
}

function parseMessage(evt) {
  const msg = evt && evt.message;
  if (!msg || !msg.chat_id) return null;
  const sender = evt.sender || {};
  const senderType = sender.sender_type || 'user';
  if (senderType === 'app' || senderType === 'bot') return null;   // 防回环

  const type = msg.message_type || 'text';
  const content = parseContent(msg.content);
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const base = {
    chatId: String(msg.chat_id),
    chatType: msg.chat_type || 'p2p',
    messageId: msg.message_id || '',
    openId: (sender.sender_id && sender.sender_id.open_id) || '',
    senderType,
    text: '',
    media: null,
    mentioned: mentions.length > 0,
    unsupported: null,
  };

  if (type === 'text') {
    base.text = stripMentions(content.text, mentions);
    return base;
  }
  if (type === 'post') {
    const { text, rawCode } = postToText(content);
    base.text = stripMentions(text, mentions)
      .replace(/\uE000(\d+)\uE001/g, (token, i) => (rawCode[i] === undefined ? token : rawCode[i]));
    return base;
  }
  if (type === 'image' && content.image_key) {
    base.media = { messageId: base.messageId, fileKey: content.image_key, type: 'image', fileName: `${base.messageId || 'image'}.png` };
    return base;
  }
  if (type === 'file' && content.file_key) {
    base.media = { messageId: base.messageId, fileKey: content.file_key, type: 'file', fileName: content.file_name || `${base.messageId}.bin` };
    return base;
  }
  base.unsupported = type;
  return base;
}

function parseCardAction(evt) {
  const ctx = (evt && evt.context) || {};
  const chatId = evt && (evt.open_chat_id || ctx.open_chat_id);
  const action = evt && evt.action && evt.action.value;
  if (!chatId || !action || !action.act) return null;
  return { chatId: String(chatId), openId: (evt.operator && evt.operator.open_id) || '', action };
}

function parseChatId(evt) {
  if (!evt) return '';
  return String(evt.chat_id || (evt.chat && evt.chat.chat_id) || (evt.message && evt.message.chat_id) || '');
}

module.exports = { parseMessage, parseCardAction, parseChatId };
