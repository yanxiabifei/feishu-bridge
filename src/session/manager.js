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
  let shuttingDown = false;
  const forcePending = new Map();   // chatId -> { text }：被护栏拦下、等「仍然发送」的那句
  const TOOL_SUMMARY_MAX_BYTES = 20 * 1024 * 1024;
  let pendingWork = Promise.resolve();

  function enqueueWork(fn) {
    pendingWork = pendingWork
      .then(fn)
      .catch((err) => log.warn('异步任务失败', { message: String((err && err.message) || err) }));
    return pendingWork;
  }

  // 等到队列真正稳定：任务执行过程中可能又追加新任务，不能只 await 一次快照
  async function drainWork() {
    let prev;
    do {
      prev = pendingWork;
      await prev.catch(() => {});
    } while (prev !== pendingWork);
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
    else if (e.type === 'ready') {
      record.status = 'idle';
      record.resuming = false;   // 起来了就说明 --resume 没失败，崩溃不再走降级重建
    }
    else if (e.type === 'turn-start') record.status = 'running';
    else if (e.type === 'exit' && record.status !== 'closing' && !shuttingDown) record.status = 'error';
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
    if (e.type === 'turn-start') {
      record.turnSeq = (record.turnSeq || 0) + 1;
      // 这里必须当场捕获轮次号：若在闭包里再读 record.turnSeq，Stop 先到并自增后
      // 迟到的建卡任务会误以为自己是当前轮，发出永远定不了稿的过期卡。
      const turn = record.turnSeq;
      enqueueWork(() => startProcessingCard(record, e, turn));
    }
    if (e.type === 'exit' && record.status === 'error' && !shuttingDown) {
      if (record.resuming) enqueueWork(() => retryWithoutResume(record));
      else enqueueWork(() => notifyCrash(record, e));
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
      agent: parsed.agent || agent,
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

  async function startProcessingCard(record, e, turn) {
    if (record.agent !== 'claude') return;      // Codex 不做卡片定稿，走画面推送（任务 20）
    try {
      const cardId = await api.createCardEntity(cards.processingCard({ agent: record.agent, prompt: e.text }));
      // 建卡期间本轮已结束（Stop 先到）：不要再发一张没人收尾的过期卡
      if (record.turnSeq !== turn) return;
      record.pendingCard = { cardId, seq: 0, origin: e.origin, prompt: e.text };
      await api.sendCardEntity(record.chatId, cardId);
    } catch (err) {
      // 卡没发出去，别留着让 Stop 去更新一张不存在的卡
      record.pendingCard = null;
      log.warn('处理中卡片发送失败，Stop 时改为新发一张', { message: String((err && err.message) || err) });
    }
  }

  function toolSummary(record) {
    if (!record.transcriptPath) return '';
    try {
      const st = fsApi.statSync(record.transcriptPath);
      // 超大 transcript 有意静默跳过：每轮都打日志会刷屏
      if (!st || st.size > TOOL_SUMMARY_MAX_BYTES) return '';
      return summarizeToolUse(fsApi.readFileSync(record.transcriptPath, 'utf8'));
    } catch (err) {
      log.warn('读取 transcript 失败', {
        path: record.transcriptPath,
        message: String((err && err.message) || err),
      });
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

  // 提前结束本轮（只回车、无输出）时也要把「处理中」卡片就地定稿，不能留一张永远转圈的卡
  async function finalizePendingCard(record, text) {
    const pending = record.pendingCard;
    if (!pending || !pending.cardId) return;
    record.pendingCard = null;
    try {
      const card = cards.replyCard({ text, agent: record.agent, cwd: record.cwd });
      await api.updateCardEntity(pending.cardId, card, pending.seq + 1);
    } catch (err) {
      log.warn('处理中卡片收尾失败', {
        cardId: pending.cardId, chatId: record.chatId, message: String((err && err.message) || err),
      });
    }
    // 收尾前的 save 仍带着 pendingCard，这里补一次把已清空的状态落盘
    store.save();
  }

  async function onHookStop({ sessionId, payload = {} }) {
    const record = store.get(sessionId) || findByClaudeSessionId(payload.session_id);
    if (!record) {
      log.warn('Stop hook 找不到会话，忽略', { sessionId });
      return;
    }

    // 本轮结束：自增轮次号，让仍在飞行中的建卡任务失效
    record.turnSeq = (record.turnSeq || 0) + 1;
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
    if (input && !String(input.text || '').trim()) {   // 只按了回车，不推
      await finalizePendingCard(record, '本轮只按了回车，没有别的输入。');
      return;
    }

    const reply = String(payload.last_assistant_message || '').trim();
    const interrupted = sawInterrupted(record);
    if (!reply && !interrupted) {
      await finalizePendingCard(record, '本轮没有文字输出。');
      return;
    }

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
        log.warn('卡片定稿失败，改为新发一张', {
          cardId: pending.cardId,
          chatId: record.chatId,
          message: String((err && err.message) || err),
        });
      }
    }
    await api.sendCard(record.chatId, card);
    store.save();
  }

  async function notifyCrash(record, e) {
    const code = typeof e.code === 'number' ? `（code ${e.code}）` : '';
    try {
      await api.sendCard(record.chatId, cards.errorCard({
        title: '进程异常退出',
        text: `会话进程异常退出${code}。\n\n回复「重来」，我用 --resume 接着干。`,
      }));
    } catch (err) {
      log.warn('崩溃通知发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
  }

  async function closeSession(sessionId, { reason = 'closed', notify = false } = {}) {
    const record = store.get(sessionId);
    if (!record) return;

    const ps = sessions.get(sessionId);
    sessions.delete(sessionId);
    record.status = 'closing';        // 先置 closing，kill 出来的 exit 事件不会被当成崩溃
    store.save();
    if (ps) {
      try {
        ps.kill();
      } catch (err) {
        log.warn('结束 PTY 失败', { sessionId, message: String((err && err.message) || err) });
      }
    }

    record.status = 'closed';
    record.closedReason = reason;
    record.closedAt = new Date(now()).toISOString();
    store.save();
    ipc?.broadcast({ type: 'session', session: record });

    if (notify) {
      try {
        await api.sendText(record.chatId, '会话已结束');
      } catch (err) {
        log.warn('会话结束提示发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
      }
    }
    if (config.autoDisband && reason !== 'disbanded' && reason !== 'bot-removed') {
      try {
        await api.disbandChat(record.chatId);
      } catch (err) {
        log.warn('解散群失败', { chatId: record.chatId, message: String((err && err.message) || err) });
      }
    }

    store.remove(sessionId);
    store.save();
  }

  // 崩溃 / 已停的会话原地重启。hook 文件、--settings、信任标记、--resume
  // 都在 launcher.buildLaunch 里按需重写，这里只管状态与目录校验。
  async function revive(record) {
    if (!fsApi.existsSync(record.cwd)) {
      await api.sendCard(record.chatId, cards.errorCard({
        title: '原目录不见了',
        text: `\`${record.cwd}\` 已经不存在，没法恢复这个会话。改个目录重新开一个吧。`,
      }));
      return false;
    }

    record.status = 'starting';
    record.pendingCard = null;
    record.lastActiveAt = new Date(now()).toISOString();
    record.resuming = record.agent === 'claude' && Boolean(record.claudeSessionId);
    store.save();
    spawn(record);
    ipc?.broadcast({ type: 'session', session: record });

    await api.sendText(record.chatId, record.resuming ? '重新开起来了，接着上次的对话。' : '重新开起来了。');
    return true;
  }

  async function onDisbanded({ chatId }) {
    const record = store.getByChat(chatId);
    if (!record) return;
    await closeSession(record.id, { reason: 'disbanded', notify: false });
  }

  async function onBotRemoved({ chatId }) {
    const record = store.getByChat(chatId);
    if (!record) return;
    await closeSession(record.id, { reason: 'bot-removed', notify: false });
  }

  async function onCardAction({ chatId, openId = null, action }) {
    if (config.ownerOpenId && openId && openId !== config.ownerOpenId) {
      log.warn('忽略非主人的卡片操作', { chatId });
      return;
    }
    const act = action && action.act;
    if (act === 'force-send') {
      await onPhoneMessage({ chatId, text: '仍然发送', senderOpenId: openId || config.ownerOpenId });
      return;
    }
    log.warn('未知的卡片操作', { chatId, act });
  }

  // 启动时把 sessions.json 里的旧记录全部标成 interrupted，等用户发话再拉起来。
  async function restoreAll() {
    const records = store.all();
    let restored = 0;
    for (const record of records) {
      if (record.status === 'closed') {
        try {
          store.remove(record.id);
        } catch (err) {
          log.warn('清理旧记录失败', { sessionId: record.id, message: String((err && err.message) || err) });
        }
        continue;
      }
      record.status = 'interrupted';
      record.ptyPid = null;
      restored += 1;
      try {
        await api.sendText(record.chatId, '电脑重启了，回一条消息我就接上。');
      } catch (err) {
        log.warn('重启提示发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
      }
    }
    try {
      store.save();
    } catch (err) {
      log.warn('重启状态落盘失败', { message: String((err && err.message) || err) });
    }
    return restored;
  }

  function onPcKeys({ sessionId, data }) {
    const ps = sessions.get(sessionId);
    if (!ps || typeof data !== 'string' || data === '') return;
    ps.onPcKeys(data);
  }

  function onPcResize({ sessionId, cols, rows }) {
    const ps = sessions.get(sessionId);
    if (!ps || typeof ps.resize !== 'function') return;
    const c = Math.floor(Number(cols));
    const r = Math.floor(Number(rows));
    if (!(c > 0 && r > 0)) return;
    ps.resize(c, r);
  }

  // 窗口连上来时的会话清单：以持久化记录为准，活会话叠加内存里的 pending/lastInput。
  function list() {
    return store.all().map((record) => {
      const ps = sessions.get(record.id);
      const snap = ps && typeof ps.snapshot === 'function' ? ps.snapshot() : {};
      return { ...record, ...snap, status: record.status };
    });
  }

  // 电脑正常退出：只杀进程、标记 interrupted，记录留着给下次启动 restoreAll() 接上。
  async function shutdown() {
    shuttingDown = true;
    for (const id of [...sessions.keys()]) {
      const ps = sessions.get(id);
      const record = store.get(id);
      sessions.delete(id);
      try {
        ps.kill();
      } catch (err) {
        log.warn('结束 PTY 失败', { sessionId: id, message: String((err && err.message) || err) });
      }
      if (record) {
        record.status = 'interrupted';
        record.ptyPid = null;
        record.lastActiveAt = new Date(now()).toISOString();
      }
    }
    try {
      store.save();
    } catch (err) {
      log.warn('停机落盘失败', { message: String((err && err.message) || err) });
    }
  }

  // --resume 起不来（记录被删/版本不对）时的兜底：丢掉旧会话 ID，新开一个。
  async function retryWithoutResume(record) {
    // 排队期间会话可能已被解散/移除，记录不在了就别再拉起新 PTY
    if (store.get(record.id) !== record) return;
    record.resuming = false;
    record.claudeSessionId = null;
    record.transcriptPath = null;
    record.status = 'starting';
    try {
      store.save();
    } catch (err) {
      log.warn('重建状态落盘失败', { sessionId: record.id, message: String((err && err.message) || err) });
    }
    // 先拉起新 PTY 再发提示：await 期间若用户发消息，必须写进新 PTY 而不是已退出的旧 PTY
    spawn(record);
    ipc?.broadcast({ type: 'session', session: record });
    try {
      await api.sendText(record.chatId, '上次的对话记录不在了，改用新会话重建。');
    } catch (err) {
      log.warn('重建提示发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
  }

  // 由 daemon 每 30s 调一次（任务 21 装配时起定时器）：兜住丢失的解散事件。
  async function tick() {
    for (const record of store.all()) {
      if (record.status === 'closed') continue;
      let chat;
      try {
        chat = await api.getChat(record.chatId);
      } catch (err) {
        log.warn('抽检群失败', { chatId: record.chatId, message: String((err && err.message) || err) });
        continue;
      }
      if (!chat) await closeSession(record.id, { reason: 'disbanded', notify: false });
    }
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

    let ps = sessions.get(record.id);
    let payload = String(text == null ? '' : text).trim();

    if (payload === '重来' && (!ps || ['error', 'closed', 'interrupted'].includes(record.status))) {
      await revive(record);
      return;
    }

    // 重启后内存里的 PTY 已经没了，interrupted 必须先于「已停」守卫处理
    if (record.status === 'interrupted' && !ps) {
      const ok = await revive(record);
      if (!ok) return;
      ps = sessions.get(record.id);
    }
    if (!ps || ['error', 'closed', 'closing'].includes(record.status)) {
      await api.sendText(chatId, '这个会话已经停了，回复「重来」重新开一轮。');
      return;
    }

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
    closeSession,
    onDisbanded,
    onBotRemoved,
    onCardAction,
    tick,
    revive,
    restoreAll,
    onPcKeys,
    onPcResize,
    list,
    shutdown,
    _drain: drainWork,
    _sessions: sessions,
  };
}

module.exports = { createManager };
