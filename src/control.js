// src/control.js —— 私聊总控面板：会话列表 / 结束会话 / 改别名。
// 只做「读状态 + 发消息」，不建会话、不碰 PTY（规格 §7、§10.1）。
const { card } = require('./feishu/cards');

const HELP_TEXT = [
  '我是你的电脑终端桥，私聊时是总控面板：',
  '· 发「列表」看所有会话',
  '· 发「状态」看守护进程、长连接和会话健康',
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
// 点了改名按钮两分钟没回新名字，就当没点过：否则一条迟早会来的闲聊会被当成新别名
const PENDING_TTL_MS = 120000;
const CANCEL_WORDS = /^(取消|算了|不改了|不用了|取消改名)$/;

function parseControl(text) {
  const t = String(text || '').trim();
  if (!t) return { act: 'help' };
  if (/^(列表|会话|面板)$/.test(t)) return { act: 'list' };
  if (t === '状态') return { act: 'status' };
  if (HELP_ONLY.test(t)) return { act: 'help' };
  let m = t.match(/^(?:结束|关闭|关掉)\s+(.+)$/);
  if (m) return { act: 'end', target: m[1].trim() };
  m = t.match(/^改名\s+(\S+)\s+(\S+)$/);
  if (m) return { act: 'rename', from: m[1], to: m[2] };
  return { act: 'help' };
}

const WS_TEXT = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  failed: '连接失败',
};

function aliasOfSession(s, aliases) {
  const current = aliases && typeof aliases === 'object'
    ? Object.keys(aliases).find((k) => aliases[k] === s.cwd)
    : null;
  return current || s.alias || null;
}

function formatSessions(list, aliases = null) {
  if (!Array.isArray(list) || list.length === 0) {
    return '现在没有会话。去项目群里 @我 发一句就能开工。';
  }
  return list.map((s, i) => {
    const alias = aliasOfSession(s, aliases);
    const name = alias ? `${alias}（${s.cwd}）` : (s.cwd || s.id);
    const agent = s.agent === 'codex' ? 'Codex' : 'Claude';
    const status = STATUS_TEXT[s.status] || s.status || '未知';
    return `${i + 1}. ${name} · ${agent} · ${status}`;
  }).join('\n');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 60000) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 60000) return '不到 1 分钟';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function formatWs(ws) {
  if (!ws || !ws.state) return '未知';
  let text = WS_TEXT[ws.state] || ws.state;
  if (ws.state === 'reconnecting' && ws.reconnectAttempts) {
    text += `（第 ${ws.reconnectAttempts} 次）`;
  }
  if (Number.isFinite(ws.lastConnectTime) && ws.lastConnectTime > 0) {
    const d = new Date(ws.lastConnectTime);
    text += ` · ${pad2(d.getHours())}:${pad2(d.getMinutes())} 握手`;
  }
  return text;
}

// 守护进程 / 长连接 / 会话的健康快照；纯文本，手机上不占一屏卡片
function formatHealth({
  startedAt, now = Date.now(), pid = null, ipcPort = null,
  ws = null, sessions = [], aliases = null,
} = {}) {
  const lines = ['🩺 桥接状态'];
  lines.push(`守护进程：运行 ${formatUptime(now - Number(startedAt))}${pid ? ` · PID ${pid}` : ''}`);
  lines.push(`飞书长连接：${formatWs(ws)}`);
  if (ipcPort) lines.push(`IPC：127.0.0.1:${ipcPort}`);
  const list = Array.isArray(sessions) ? sessions : [];
  if (list.length === 0) {
    lines.push('会话：0 个。去项目群里 @我 发一句就能开工。');
    return lines.join('\n');
  }
  lines.push(`会话：${list.length} 个`);
  list.forEach((s, i) => {
    const alias = aliasOfSession(s, aliases);
    const name = alias ? `${alias}（${s.cwd}）` : (s.cwd || s.id);
    const agent = s.agent === 'codex' ? 'Codex' : 'Claude';
    const status = STATUS_TEXT[s.status] || s.status || '未知';
    let line = `${i + 1}. ${name} · ${agent} · ${status}`;
    const at = Date.parse(s.lastActiveAt || '');
    if (Number.isFinite(at)) line += ` · ${formatAgo(now - at)}`;
    lines.push(line);
  });
  return lines.join('\n');
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

function createControl({ api, listSessions, closeSession, getProjects, renameAlias, getHealth, ownerOpenId, log }) {
  const pending = new Map(); // chatId -> { from: 待改名的旧别名, at: 点按钮的时间 }

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
    if (!ownerOpenId || senderOpenId !== ownerOpenId) return;
    const body = String(text || '').trim();

    const p = pending.get(chatId);
    if (p) {
      pending.delete(chatId);
      if (Date.now() - p.at > PENDING_TTL_MS) {
        // 太久了，八成早忘了这回事；这条消息照常当普通消息处理
      } else if (CANCEL_WORDS.test(body)) {
        await send(chatId, '已取消改名，别名没动。');
        return;
      } else {
        const cmd = parseControl(body);
        if (!HELP_ONLY.test(body) && cmd.act === 'help' && body) {
          await doRename(chatId, p.from, body);
          return;
        }
        // 用户改主意发了命令，按命令继续处理
      }
    }

    const cmd = parseControl(body);
    if (cmd.act === 'list') { await sendPanel(chatId); return; }

    if (cmd.act === 'status') {
      let health = null;
      try { health = typeof getHealth === 'function' ? getHealth() : null; } catch { health = null; }
      if (!health) {
        await send(chatId, '状态信息取不到了，看看守护进程是不是还在跑（发「列表」也能看看会话）。');
        return;
      }
      const aliases = (getProjects() || {}).aliases;
      await send(chatId, formatHealth({ ...health, aliases }));
      return;
    }

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
    if (!ownerOpenId || openId !== ownerOpenId) return;
    if (!action || action.act !== 'alias-rename') return;
    const { aliases } = getProjects() || {};
    if (!action.from || !aliases || aliases[action.from] === undefined) {
      await send(chatId, `别名「${action.from}」已经不在了，发「列表」重新看。`);
      return;
    }
    pending.set(chatId, { from: action.from, at: Date.now() });
    await send(chatId, `把「${action.from}」改成什么？直接回复新名字（不带空格），发「取消」就算了。`);
  }

  async function onBotAdded({ chatId, openId }) {
    if (!ownerOpenId || openId !== ownerOpenId) return;
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
  parseControl, formatSessions, formatHealth, panelCard, createControl,
};
