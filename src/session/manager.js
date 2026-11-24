const fs = require('node:fs');
const path = require('node:path');
const { parseFirstMessage } = require('./router');
const { loadProjects } = require('../projects');
const paths = require('../paths');
const cards = require('../feishu/cards');

// 这些事件才值得写盘和广播，'data' 是高频字节流，绝不能每条都存
const PERSIST_EVENTS = new Set(['spawned', 'ready', 'turn-start', 'exit', 'input', 'pc-input', 'overflow']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(ms) {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function createManager({
  config,
  api,
  store,
  log,
  createPtySession,
  ipc = null,
  now = () => Date.now(),
  rand = () => Math.random(),
  fsApi = fs,
  getProjects = null,
}) {
  const sessions = new Map();
  const loadProjectsFn = getProjects
    || (() => loadProjects({ file: paths.PROJECTS, defaultCwd: config.defaultCwd }));

  function newId() {
    return `s${now().toString(36)}${Math.floor(rand() * 46656).toString(36).padStart(3, '0')}`;
  }

  function labelOf(record) {
    return record.alias || path.basename(record.cwd) || record.agent;
  }

  function onEvent(e) {
    const record = store.get(e.sessionId);
    if (!record) return;
    if (e.type === 'spawned') record.ptyPid = e.pid || null;
    else if (e.type === 'ready') record.status = 'idle';
    else if (e.type === 'turn-start') record.status = 'running';
    else if (e.type === 'exit') record.status = 'error';
    if (e.type === 'input' || e.type === 'pc-input') record.lastInput = e.input || null;

    if (e.type === 'data') {
      if (ipc && ipc.broadcast) {
        ipc.broadcast({ type: 'data', sessionId: e.sessionId, data: e.data });
      }
      return;
    }
    if (PERSIST_EVENTS.has(e.type)) {
      record.lastActiveAt = new Date(now()).toISOString();
      store.save();
      if (ipc && ipc.broadcast) ipc.broadcast({ type: 'session', session: record });
    }
    if (e.type === 'error') log.warn('会话出错', { sessionId: e.sessionId, message: e.message });
    if (e.type === 'overflow') log.warn('队列已满', { sessionId: e.sessionId });
  }

  function spawn(record) {
    const ps = createPtySession({
      session: record,
      onEvent,
      queueLimit: config.queueLimit,
      now,
    });
    sessions.set(record.id, ps);
    ps.start();
    return ps;
  }

  function newRecord({ chatId, chatName, cwd, alias, agent }) {
    const at = new Date(now()).toISOString();
    return {
      id: newId(),
      agent: agent === 'codex' ? 'codex' : 'claude',
      cwd,
      alias: alias || null,
      chatId,
      chatName,
      claudeSessionId: null,
      transcriptPath: null,
      ptyPid: null,
      status: 'starting',
      createdAt: at,
      lastActiveAt: at,
      inputSeq: 0,
      lastInput: null,
    };
  }

  async function createFromPhone({ chatId, chatName, text, agent = 'claude' }) {
    if (store.getByChat(chatId)) {
      throw new Error('这个群已经有会话了，直接在群里发消息就行');
    }

    const projects = loadProjectsFn();
    const parsed = parseFirstMessage(text, {
      aliases: projects.aliases,
      defaultCwd: projects.default || config.defaultCwd,
      exists: (p) => fsApi.existsSync(p),
    });

    if (parsed.source === 'path-missing') {
      await api.sendCard(chatId, cards.errorCard({
        title: '目录不存在',
        text: `你说的路径在本机不存在：\n\`${parsed.prompt.split(/\s+/)[0]}\`\n\n换一个目录，或者直接说要做的事（会落到默认目录 \`${config.defaultCwd}\`）。`,
      }));
      return null;
    }

    if (!fsApi.existsSync(parsed.cwd)) {
      if (parsed.source !== 'default') {
        await api.sendCard(chatId, cards.errorCard({
          title: '目录不存在',
          text: `别名「${parsed.alias}」指向的目录不存在：\n\`${parsed.cwd}\``,
        }));
        return null;
      }
      fsApi.mkdirSync(parsed.cwd, { recursive: true });
    }

    const record = newRecord({
      chatId,
      chatName: chatName || parsed.alias || path.basename(parsed.cwd),
      cwd: parsed.cwd,
      alias: parsed.alias,
      agent,
    });
    store.upsert(record);
    spawn(record);

    await api.sendCard(chatId, cards.noticeCard({
      title: '✅ 已开工',
      template: 'green',
      text: `${labelOf(record)} · \`${record.cwd}\`\n\n${parsed.prompt ? '第一条已进队，处理中…' : '可以直接说话。'}`,
    }));
    if (parsed.prompt) sessions.get(record.id).submitText(parsed.prompt, 'phone');
    return record;
  }

  async function createFromPc({ cwd, agent = 'claude', alias = null }) {
    if (!fsApi.existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
    const label = alias || path.basename(cwd);
    const chatName = `${label} · ${stamp(now())}`;
    const chatId = await api.createGroup(chatName, [config.ownerOpenId]);
    const record = newRecord({ chatId, chatName, cwd, alias, agent });
    store.upsert(record);
    spawn(record);
    await api.sendText(chatId, '会话已创建，可以从手机说话了。');
    return record;
  }

  return {
    createFromPhone,
    createFromPc,
    _sessions: sessions,
  };
}

module.exports = { createManager };
