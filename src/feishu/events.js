function parseContent(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function postToText(post) {
  const blocks = Array.isArray(post && post.content) ? post.content : [];
  const lines = blocks.map((line) => (Array.isArray(line) ? line : []).map((el) => {
    if (!el) return '';
    if (el.tag === 'text') return String(el.text || '');
    if (el.tag === 'a') return String(el.text || '') || String(el.href || '');
    if (el.tag === 'at') return el.user_name ? `@${el.user_name}` : '';
    return '';
  }).join(''));
  const body = lines.filter((l) => l !== '').join('\n');
  const title = post && post.title ? String(post.title) : '';
  if (!title) return body;
  return body ? `${title}\n${body}` : title;
}

function stripMentions(text, mentions) {
  let out = String(text || '');
  for (const m of mentions || []) {
    if (m && m.key) out = out.split(m.key).join('');
  }
  out = out.replace(/@_user_\d+/g, '');
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
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
    base.text = stripMentions(postToText(content), mentions);
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
