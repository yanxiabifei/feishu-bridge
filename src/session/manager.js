const fs = require('node:fs');
const path = require('node:path');
const { parseFirstMessage } = require('./router');
const { loadProjects } = require('../projects');
const paths = require('../paths');
const cards = require('../feishu/cards');
const { summarizeToolUse } = require('../agent/tools');

// 这些事件才值得写盘和广播，'data' 是高频字节流，绝不能每条都存
const PERSIST_EVENTS = new Set(['spawned', 'ready', 'turn-start', 'exit', 'input', 'pc-input', 'overflow']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(ms) {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function errMessage(err) {
  return String((err && err.message) || err);
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
  mediaRoot = paths.MEDIA,
}) {
  const sessions = new Map();
  const forcePending = new Map();   // chatId -> { text }：被护栏拦下、等「仍然发送」的那句
  const TOOL_SUMMARY_MAX_BYTES = 20 * 1024 * 1024;
  let pendingWork = Promise.resolve();

  function enqueueWork(fn) {
    pendingWork = pendingWork
      .then(fn)
      .catch((err) => log.warn('异步任务失败', { message: String((err && err.message) || err) }));
    return pendingWork;
  }
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
      try {
        store.save();
      } catch (err) {
        // 磁盘异常不能沿 PTY emit 链击穿，至少把状态广播出去
        log.warn('落盘失败', { sessionId: e.sessionId, message: errMessage(err) });
      }
      if (ipc && ipc.broadcast) ipc.broadcast({ type: 'session', session: record });
    }
    if (e.type === 'turn-start') enqueueWork(() => startProcessingCard(record, e));
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
      try {
        fsApi.mkdirSync(parsed.cwd, { recursive: true });
      } catch (err) {
        log.error('目录创建失败', { cwd: parsed.cwd, message: errMessage(err) });
        await api.sendCard(chatId, cards.errorCard({
          title: '目录创建失败',
          text: `没能创建默认目录：\n\`${parsed.cwd}\`\n\n${errMessage(err)}`,
        }));
        return null;
      }
    }

    const record = newRecord({
      chatId,
      chatName: chatName || parsed.alias || path.basename(parsed.cwd),
      cwd: parsed.cwd,
      alias: parsed.alias,
      agent,
    });
    store.upsert(record);
    try {
      spawn(record);
    } catch (err) {
      sessions.delete(record.id);
      store.remove(record.id);
      log.error('会话启动失败', { sessionId: record.id, message: errMessage(err) });
      await api.sendCard(chatId, cards.errorCard({
        title: '启动失败',
        text: `没能把终端拉起来：\n\`${errMessage(err)}\`\n\n再发一次试试。`,
      }));
      return null;
    }

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
    try {
      spawn(record);
    } catch (err) {
      sessions.delete(record.id);
      store.remove(record.id);
      const message = errMessage(err);
      log.error('会话启动失败', { sessionId: record.id, message });
      try {
        await api.disbandChat(chatId);
      } catch (e) {
        // 解散空群失败不掩盖原始错误
        log.warn('解散空群失败', { chatId, message: errMessage(e) });
      }
      throw new Error(`会话启动失败：${message}`);
    }
    await api.sendText(chatId, '会话已创建，可以从手机说话了。');
    return record;
  }

  async function startProcessingCard(record, e) {
    if (record.agent !== 'claude') return;      // Codex 不做卡片定稿，走画面推送（任务 20）
    try {
      const cardId = await api.createCardEntity(cards.processingCard({ agent: record.agent, prompt: e.text }));
      await api.sendCardEntity(record.chatId, cardId);
      record.pendingCard = { cardId, seq: 0, origin: e.origin, prompt: e.text };
      store.save();
    } catch (err) {
      log.warn('处理中卡片发送失败，Stop 时改为新发一张', { message: String((err && err.message) || err) });
    }
  }

  function toolSummary(record) {
    if (!record.transcriptPath) return '';
    try {
      const st = fsApi.statSync(record.transcriptPath);
      if (!st || st.size > TOOL_SUMMARY_MAX_BYTES) return '';
      return summarizeToolUse(fsApi.readFileSync(record.transcriptPath, 'utf8'));
    } catch {
      return '';
    }
  }

  function sawInterrupted(record) {
    const ps = sessions.get(record.id);
    if (!ps || !ps.screen) return false;
    try {
      return ps.screen.snapshot({ lines: 12 }).includes('Interrupted');
    } catch {
      return false;
    }
  }

  function findByClaudeSessionId(claudeSessionId) {
    if (!claudeSessionId) return null;
    return store.all().find((s) => s.claudeSessionId === claudeSessionId) || null;
  }

  async function onHookStop({ sessionId, payload = {} }) {
    const record = store.get(sessionId) || findByClaudeSessionId(payload.session_id);
    if (!record) {
      log.warn('Stop hook 找不到会话，忽略', { sessionId });
      return;
    }

    // 回填 Claude 自己的会话信息：重启后 --resume 靠它（任务 19）
    if (payload.session_id) record.claudeSessionId = payload.session_id;
    if (payload.transcript_path) record.transcriptPath = payload.transcript_path;
    if (!['error', 'closed', 'closing'].includes(record.status)) record.status = 'idle';
    // ptySession 内部状态也要回到 idle，否则 canWrite 永远为 false，队列里的手机消息再也写不进去
    const stoppedPs = sessions.get(record.id);
    if (stoppedPs) stoppedPs.releaseTurn();
    record.lastActiveAt = new Date(now()).toISOString();
    store.save();
    ipc?.broadcast({ type: 'session', session: record });

    const input = record.lastInput;
    if (input && !String(input.text || '').trim()) return;   // 只按了回车，不推

    const reply = String(payload.last_assistant_message || '').trim();
    const interrupted = sawInterrupted(record);
    if (!reply && !interrupted) return;

    const parts = [];
    if (input && input.origin === 'pc' && input.text) parts.push(`🖥 你刚在电脑上问：${input.text}`);
    parts.push(interrupted && !reply ? '（已打断）' : reply);
    const tools = toolSummary(record);
    if (tools) parts.push(tools);

    const card = cards.replyCard({ text: parts.join('\n\n'), agent: record.agent, cwd: record.cwd });
    const pending = record.pendingCard;
    record.pendingCard = null;

    if (pending && pending.cardId) {
      try {
        await api.updateCardEntity(pending.cardId, card, pending.seq + 1);
        store.save();
        return;
      } catch (err) {
        log.warn('卡片定稿失败，改为新发一张', { message: String((err && err.message) || err) });
      }
    }
    await api.sendCard(record.chatId, card);
    store.save();
  }

  // 文件名只留安全字符，截断到 120 字符以内（Windows 路径上限）
  function safeName(name) {
    const base = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').trim();
    return base.slice(-120) || 'file';
  }

  async function attachMedia(chatId, text, media) {
    try {
      const buf = await api.downloadResource(media.messageId, media.fileKey, media.type);
      const dir = path.join(mediaRoot, chatId);
      fsApi.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, safeName(media.fileName));
      fsApi.writeFileSync(abs, buf);
      return text ? `${text}\n\n[附件] ${abs}` : `[附件] ${abs}`;
    } catch (err) {
      log.warn('附件下载失败', { chatId, message: String((err && err.message) || err) });
      await api.sendText(chatId, '附件下载失败了，把内容直接打出来吧。');
      return text;
    }
  }

  async function onPhoneMessage({
    chatId, text, media = null, senderOpenId = null,
  }) {
    if (config.ownerOpenId && senderOpenId && senderOpenId !== config.ownerOpenId) {
      log.warn('忽略非主人的消息', { chatId });
      return;
    }

    const record = store.getByChat(chatId);
    if (!record) {
      // 没登记过的群：首句即建会话指令（ws 层只把 @机器人 的消息转发到这里）
      await createFromPhone({ chatId, chatName: null, text, agent: config.defaultAgent || 'claude' });
      return;
    }

    const ps = sessions.get(record.id);
    if (!ps || ['error', 'closed', 'closing'].includes(record.status)) {
      await api.sendText(chatId, '这个会话已经停了，回复「重来」重新开一轮。');
      return;
    }
    if (record.status === 'interrupted') {
      await api.sendText(chatId, '电脑重启过，这个会话还没接上。再发一次，我就用 --resume 接着干。');
      return;
    }

    let payload = String(text == null ? '' : text).trim();

    const pending = forcePending.get(chatId);
    if (pending && payload === '仍然发送') {
      forcePending.delete(chatId);
      ps.submitText(pending.text, 'phone', { force: true });
      return;
    }
    forcePending.delete(chatId);

    if (media) payload = await attachMedia(chatId, payload, media);
    if (!payload) return;

    if (ps.needsConfirm()) {
      forcePending.set(chatId, { text: payload });
      await api.sendCard(chatId, cards.screenCard({
        text: ps.screen.snapshot({ lines: 40 }),
        reason: 'not-ready',
      }));
      return;
    }

    const result = ps.submitText(payload, 'phone');
    if (result === 'full') {
      await api.sendText(chatId, `积压了 ${config.queueLimit} 条还没处理完，稍后再发。`);
    }
  }

  return {
    createFromPhone,
    createFromPc,
    onPhoneMessage,
    onHookStop,
    _drain: () => pendingWork,
    _sessions: sessions,
  };
}

module.exports = { createManager };
