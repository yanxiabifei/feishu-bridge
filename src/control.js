// src/control.js —— 私聊总控面板：会话列表 / 结束会话 / 改别名。
// 只做「读状态 + 发消息」，不建会话、不碰 PTY（规格 §7、§10.1）。
const { card } = require('./feishu/cards');

const HELP_TEXT = [
  '我是你的电脑终端桥，私聊时是总控面板：',
  '· 发「列表」看所有会话',
  '· 发「结束 <别名>」关掉某个会话',
  '· 发「改名 <旧名> <新名>」改项目别名（也可以点面板上的按钮）',
  '要开工，请在项目群里 @我 说「<别名> 要做什么」。',
].join('\n');

const STATUS_TEXT = {
  starting: '启动中',
  idle: '空闲',
  running: '运行中',
  error: '出错',
  closing: '关闭中',
  closed: '已关闭',
  interrupted: '已中断',
};

const MAX_ALIAS_BUTTONS = 10;
const HELP_ONLY = /^(帮助|help|\?|？)$/i;

function parseControl(text) {
  const t = String(text || '').trim();
  if (!t) return { act: 'help' };
  if (/^(列表|会话|面板|状态)$/.test(t)) return { act: 'list' };
  if (HELP_ONLY.test(t)) return { act: 'help' };
  let m = t.match(/^(?:结束|关闭|关掉)\s+(.+)$/);
  if (m) return { act: 'end', target: m[1].trim() };
  m = t.match(/^改名\s+(\S+)\s+(\S+)$/);
  if (m) return { act: 'rename', from: m[1], to: m[2] };
  return { act: 'help' };
}

function formatSessions(list, aliases = null) {
  if (!Array.isArray(list) || list.length === 0) {
    return '现在没有会话。去项目群里 @我 发一句就能开工。';
  }
  return list.map((s, i) => {
    const current = aliases && typeof aliases === 'object'
      ? Object.keys(aliases).find((k) => aliases[k] === s.cwd)
      : null;
    const alias = current || s.alias;
    const name = alias ? `${alias}（${s.cwd}）` : (s.cwd || s.id);
    const agent = s.agent === 'codex' ? 'Codex' : 'Claude';
    const status = STATUS_TEXT[s.status] || s.status || '未知';
    return `${i + 1}. ${name} · ${agent} · ${status}`;
  }).join('\n');
}

function panelCard({ sessions, aliases }) {
  const names = Object.keys(aliases || {}).slice(0, MAX_ALIAS_BUTTONS);
  const elements = [{ tag: 'markdown', content: formatSessions(sessions, aliases) }];
  if (names.length) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: '**项目别名**（点一行改名）' });
    for (const name of names) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `${name} → ${aliases[name]}` },
        type: 'default',
        behaviors: [{ type: 'callback', value: { act: 'alias-rename', from: name } }],
      });
    }
  }
  return card({ title: '🛰️ 总控面板', template: 'blue', elements });
}

function createControl({ api, listSessions, closeSession, getProjects, renameAlias, ownerOpenId, log }) {
  const pending = new Map(); // chatId -> 待改名的旧别名

  const send = (chatId, text) => api.sendText(chatId, text);

  async function sendPanel(chatId) {
    const { aliases } = getProjects() || {};
    await api.sendCard(chatId, panelCard({ sessions: listSessions(), aliases }));
  }

  async function doRename(chatId, from, to) {
    if (!to || /\s/.test(to)) { await send(chatId, '新别名不能为空、不能带空格。'); return; }
    const r = renameAlias({ from, to });
    if (!r || !r.ok) { await send(chatId, (r && r.message) || '改名失败。'); return; }
    log?.info?.('control.alias_renamed', { from, to });
    await send(chatId, `已把「${from}」改成「${to}」。以后在群里发「${to} 要做什么」就行。`);
  }

  async function onMessage({ chatId, text, senderOpenId }) {
    if (senderOpenId !== ownerOpenId) return;
    const body = String(text || '').trim();

    const pendingFrom = pending.get(chatId);
    if (pendingFrom) {
      pending.delete(chatId);
      const cmd = parseControl(body);
      if (!HELP_ONLY.test(body) && cmd.act === 'help' && body) {
        await doRename(chatId, pendingFrom, body);
        return;
      }
      // 用户改主意发了命令，按命令继续处理
    }

    const cmd = parseControl(body);
    if (cmd.act === 'list') { await sendPanel(chatId); return; }

    if (cmd.act === 'end') {
      const list = listSessions();
      const aliases = (getProjects() || {}).aliases || {};
      const currentCwd = typeof aliases[cmd.target] === 'string' ? aliases[cmd.target] : null;
      // 面板显示的是 projects 里的当前别名，所以以它为准；命中当前别名就不再回退到
      // 会话记录里的旧别名，否则改名后新旧名同存会关错另一个群的会话
      const hit = currentCwd
        ? list.find((s) => s.cwd === currentCwd)
        : list.find((s) => s.id === cmd.target)
          || list.find((s) => s.cwd === cmd.target)
          || list.find((s) => s.alias === cmd.target);
      if (!hit) { await send(chatId, `没找到会话「${cmd.target}」。发「列表」看看有哪些。`); return; }
      await closeSession(hit.id, { reason: '手机总控面板关闭', notify: true });
      log?.info?.('control.session_closed', { sessionId: hit.id });
      await send(chatId, `已结束会话「${hit.alias || hit.cwd || hit.id}」。`);
      return;
    }

    if (cmd.act === 'rename') { await doRename(chatId, cmd.from, cmd.to); return; }

    await send(chatId, HELP_TEXT);
  }

  async function onCardAction({ chatId, openId, action }) {
    if (openId !== ownerOpenId) return;
    if (!action || action.act !== 'alias-rename') return;
    const { aliases } = getProjects() || {};
    if (!action.from || !aliases || aliases[action.from] === undefined) {
      await send(chatId, `别名「${action.from}」已经不在了，发「列表」重新看。`);
      return;
    }
    pending.set(chatId, action.from);
    await send(chatId, `把「${action.from}」改成什么？直接回复新名字（不带空格）。`);
  }

  async function onBotAdded({ chatId, openId }) {
    if (openId !== ownerOpenId) return;
    await api.sendCard(chatId, card({
      title: '👋 我是终端桥',
      template: 'green',
      elements: [{
        tag: 'markdown',
        content: '在这个群里 @我 说「<项目别名> 要做什么」，我会在电脑上开一个会话。\n没有别名也行，直接说要做什么，会在默认目录开工。',
      }],
    }));
  }

  return { onMessage, onCardAction, onBotAdded };
}

module.exports = {
  HELP_TEXT, STATUS_TEXT, MAX_ALIAS_BUTTONS,
  parseControl, formatSessions, panelCard, createControl,
};
