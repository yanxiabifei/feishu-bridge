const fs = require('node:fs');
const path = require('node:path');
const { decide, runIntakeCli } = require('./intake');
const { cleanCodexSnapshot } = require('./codexOutput');
const { loadProjects } = require('../projects');
const paths = require('../paths');
const cards = require('../feishu/cards');
const { summarizeToolUse } = require('../agent/tools');

// 这些事件才值得写盘和广播，'data' 是高频字节流，绝不能每条都存
const PERSIST_EVENTS = new Set(['spawned', 'ready', 'turn-start', 'turn-end', 'exit', 'input', 'pc-input', 'overflow']);

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
  runIntake = null,
}) {
  const sessions = new Map();
  const booting = new Map();        // chatId -> 无头接待期间收到的后续消息，建好会话后补投
  let shuttingDown = false;
  const forcePending = new Map();   // chatId -> { text, sessionId }：被护栏拦下、等「仍然发送」的那句
  const chatChains = new Map();     // chatId -> 该群上一条消息的处理链，同群消息严格串行
  const turnInputs = new Map();     // sessionId -> 本轮真正发起的那条输入（lastInput 可能被中途覆盖）
  const TOOL_SUMMARY_MAX_BYTES = 20 * 1024 * 1024;
  let pendingWork = Promise.resolve();

  function enqueueWork(fn) {
    pendingWork = pendingWork
      .then(fn)
      .catch((err) => log.warn('异步任务失败', { message: String((err && err.message) || err) }));
    return pendingWork;
  }

  // 落盘失败只该留下日志：磁盘抖一下不能让回复发不出去，
  // 更不能让 Stop 的卡片重试分支把「存盘失败」当成「定稿失败」再发一张重复卡。
  function saveSession(record) {
    try {
      store.save();
    } catch (err) {
      log.warn('落盘失败', { sessionId: record && record.id, message: errMessage(err) });
    }
  }

  // 新会话记录落盘失败只影响重启后能不能恢复，不能把建会话流程整个掀翻：
  // 内存里已经有了，PTY 该起还得起，首条消息该写还得写。
  function upsertSession(record) {
    try {
      store.upsert(record);
    } catch (err) {
      log.warn('落盘失败', { sessionId: record && record.id, message: errMessage(err) });
    }
  }

  // 回滚一条没建成的会话记录：落盘失败只影响重启后丢一条残留记录，
  // 不能把「启动失败」的提示和空群清理一起吞掉。
  function removeSession(id) {
    try {
      store.remove(id);
    } catch (err) {
      log.warn('落盘失败', { sessionId: id, message: errMessage(err) });
    }
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

  function displayName(record) {
    return record.groupName || labelOf(record);
  }

  const runIntakeFn = runIntake || (({ prompt, timeoutMs }) => runIntakeCli({
    prompt,
    timeoutMs,
    exe: config.claudeExe,
    cwd: config.defaultCwd,
  }));

  function onEvent(e) {
    const record = store.get(e.sessionId);
    if (!record) return;
    if (e.type === 'spawned') record.ptyPid = e.pid || null;
    else if (e.type === 'ready') {
      record.status = 'idle';
      record.resuming = false;   // 起来了就说明 --resume 没失败，崩溃不再走降级重建
    }
    else if (e.type === 'turn-start' || e.type === 'pc-input') record.status = 'running';
    else if (e.type === 'turn-end' && record.status === 'running') record.status = 'idle';
    else if (e.type === 'exit' && record.status !== 'closing' && !shuttingDown) record.status = 'error';
    if (e.type === 'input' || e.type === 'pc-input') record.lastInput = e.input || null;
    // 一轮的「发起输入」以 turn-start / pc-input 为准：排队中的下一条或者中途在电脑上
    // 敲的字都会改写 lastInput，拿它给本轮定稿会把回复挂到错误的提问上。
    if (e.type === 'turn-start') turnInputs.set(record.id, { seq: e.seq, origin: e.origin, text: e.text });
    if (e.type === 'pc-input') turnInputs.set(record.id, e.input || null);

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
    if (e.type === 'turn-end') enqueueWork(() => pushScreenOutput(record));
    if (e.type === 'turn-end' && e.guard === 'idle') {
      // 看门狗兜底：Stop 一直不来，处理中卡片就地收尾，别让它永远转圈。
      // 自增轮次号让仍在飞行中的建卡任务失效，否则它会在收尾之后再发一张废卡。
      record.turnSeq = (record.turnSeq || 0) + 1;
      enqueueWork(() => finalizePendingCard(record, '没等到结束信号，按画面判断这一轮已经回到输入框。'));
    }
    if (e.type === 'error') log.warn('会话出错', { sessionId: e.sessionId, message: e.message });
    if (e.type === 'overflow') log.warn('队列已满', { sessionId: e.sessionId });
    if (e.type === 'queue-dropped' && !shuttingDown) {
      const dropped = Array.isArray(e.items) ? e.items : [];
      if (dropped.length) {
        // 会话进程退出时还排在队列里的消息没人再写了，手机那边必须知道，
        // 否则它只见过「已排队」，以为发出去了。
        enqueueWork(() => api.sendText(record.chatId, `排队里的 ${dropped.length} 条消息没能送进去（会话进程退出了），重新发一次吧。`)
          .catch((err) => log.warn('排队丢失提示发送失败', { chatId: record.chatId, message: errMessage(err) })));
      }
    }
  }

  function spawn(record) {
    const ps = createPtySession({
      session: record,
      onEvent,
      queueLimit: config.queueLimit,
      now,
    });
    sessions.set(record.id, ps);
    try {
      ps.start();
    } catch (err) {
      // 起不来就把半成品从表里摘掉：否则后续消息会写进一个没有 PTY 的会话，
      // 永远等不到 ready，手机那边只会看到消息石沉大海。
      sessions.delete(record.id);
      record.status = 'error';
      throw err;
    }
    return ps;
  }

  function newRecord({ chatId, chatName, cwd, alias, agent, groupName = null }) {
    const at = new Date(now()).toISOString();
    return {
      id: newId(),
      agent: agent === 'codex' ? 'codex' : 'claude',
      cwd,
      alias: alias || null,
      groupName: groupName || null,
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

  // 新群首次绑定只自动改名一次，名字取别名/目录名；之后用户手改的不再覆盖
  async function renameGroupOnce(record) {
    if (record.groupRenamed) return;
    const name = displayName(record);
    if (!name) return;
    try {
      await api.renameChat(record.chatId, name);
      record.groupRenamed = true;
      record.chatName = name;
      store.upsert(record);
      log.info?.('chat.auto_renamed', { chatId: record.chatId, name });
    } catch (err) {
      // 没 im:chat 权限之类的情况不阻断建会话
      log.warn('自动改群名失败', { chatId: record.chatId, message: errMessage(err) });
    }
  }

  async function createFromPhone({ chatId, chatName, text, media = null, agent = 'claude' }) {
    if (store.getByChat(chatId)) {
      throw new Error('这个群已经有会话了，直接在群里发消息就行');
    }
    // 无头接待要跑几秒，这段时间里连发的消息先攒着，建好会话后补投
    if (booting.has(chatId)) {
      booting.get(chatId).texts.push({ text, media });
      return null;
    }
    booting.set(chatId, { texts: [] });

    try {
      return await createFromPhoneInner({ chatId, chatName, text, agent });
    } finally {
      const { texts } = booting.get(chatId) || { texts: [] };
      booting.delete(chatId);
      const record = store.getByChat(chatId);
      const ps = record && sessions.get(record.id);
      const extras = texts.filter((extra) => extra && (extra.text || extra.media));
      if (ps) {
        for (const extra of extras) {
          // 接待期间发来的附件也得下载落盘再补投，否则会话只收到一句正文，图就丢了
          const withMedia = extra.media ? await attachMedia(chatId, extra.text || '', extra.media) : extra.text;
          if (withMedia) ps.submitText(withMedia, 'phone');
        }
      } else if (extras.length) {
        // 会话没建起来（路径不对、启动失败），攒下的消息无处可去：得说一声，不能悄悄吞掉
        try {
          await api.sendText(chatId, `会话没建起来，刚才连发的 ${extras.length} 条消息没能送进去，重新发一次吧。`);
        } catch (err) {
          log.warn('补投失败提示发不出去', { chatId, message: errMessage(err) });
        }
      }
    }
  }

  async function createFromPhoneInner({ chatId, chatName, text, agent }) {
    const projects = loadProjectsFn();
    const plan = await decide({
      text,
      projects,
      defaultCwd: config.defaultCwd,
      exists: (p) => fsApi.existsSync(p),
      enabled: config.intakeEnabled !== false,
      timeoutMs: config.intakeTimeoutMs,
      runIntake: runIntakeFn,
    });

    if (plan.source === 'path-missing') {
      await api.sendCard(chatId, cards.errorCard({
        title: '目录不存在',
        text: `你说的路径在本机不存在：\n\`${String(plan.rawPrompt || '').split(/\s+/)[0]}\`\n\n换一个目录，或者直接说要做的事（会落到默认目录 \`${config.defaultCwd}\`）。`,
      }));
      return null;
    }

    if (!fsApi.existsSync(plan.cwd)) {
      if (plan.source !== 'default') {
        await api.sendCard(chatId, cards.errorCard({
          title: '目录不存在',
          text: `别名「${plan.alias}」指向的目录不存在：\n\`${plan.cwd}\``,
        }));
        return null;
      }
      try {
        fsApi.mkdirSync(plan.cwd, { recursive: true });
      } catch (err) {
        log.error('目录创建失败', { cwd: plan.cwd, message: errMessage(err) });
        await api.sendCard(chatId, cards.errorCard({
          title: '目录创建失败',
          text: `没能创建默认目录：\n\`${plan.cwd}\`\n\n${errMessage(err)}`,
        }));
        return null;
      }
    }

    const record = newRecord({
      chatId,
      chatName: chatName || plan.groupName || plan.alias || path.basename(plan.cwd),
      cwd: plan.cwd,
      alias: plan.alias,
      agent: plan.agent || agent,
      groupName: plan.groupName,
    });
    upsertSession(record);
    try {
      spawn(record);
    } catch (err) {
      sessions.delete(record.id);
      removeSession(record.id);
      log.error('会话启动失败', { sessionId: record.id, message: errMessage(err) });
      await api.sendCard(chatId, cards.errorCard({
        title: '启动失败',
        text: `没能把终端拉起来：\n\`${errMessage(err)}\`\n\n再发一次试试。`,
      }));
      return null;
    }

    // 首条必须在任何 await 之前入队：否则连发两条时第二条会抢先拿到 seq，
    // 且卡片发送失败会让函数 reject、首条提示词永远写不进去。
    if (plan.prompt) sessions.get(record.id).submitText(plan.prompt, 'phone');
    try {
      const note = plan.note ? `\n\n${plan.note}` : '';
      await api.sendCard(chatId, cards.noticeCard({
        title: '✅ 已开工',
        template: 'green',
        text: `${displayName(record)} · \`${record.cwd}\`${note}\n\n${plan.prompt ? '第一条已进队，处理中…' : '可以直接说话。'}`,
      }));
    } catch (err) {
      log.warn('已开工卡片发送失败', { sessionId: record.id, message: errMessage(err) });
    }
    await renameGroupOnce(record);
    return record;
  }

  async function createFromPc({ cwd, agent = 'claude', alias = null }) {
    if (!fsApi.existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
    const label = alias || path.basename(cwd);
    const chatName = `${label} · ${stamp(now())}`;
    const chatId = await api.createGroup(chatName, [config.ownerOpenId]);
    const record = newRecord({ chatId, chatName, cwd, alias, agent });
    upsertSession(record);
    try {
      spawn(record);
    } catch (err) {
      sessions.delete(record.id);
      removeSession(record.id);
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

  // 会话重启后，上一轮那张卡片已经没有人会来定稿了，就地补一刀。
  async function closeOrphanCard(record, pending, text) {
    if (!pending || !pending.cardId) return;
    try {
      await api.updateCardEntity(pending.cardId, cards.errorCard({ title: '进程异常退出', text }), pending.seq + 1);
    } catch (err) {
      log.warn('处理中卡片收尾失败', {
        cardId: pending.cardId, chatId: record.chatId, message: errMessage(err),
      });
    }
  }

  // 提前结束本轮（只回车、无输出、进程崩溃）时也要把「处理中」卡片就地定稿，
  // 不能留一张永远转圈的卡。不传 card 就用回复卡；崩溃这类场景传错误卡，标题才不会被标成 ✅。
  async function finalizePendingCard(record, text, card) {
    const pending = record.pendingCard;
    if (!pending || !pending.cardId) return;
    record.pendingCard = null;
    const entity = card || cards.replyCard({ text, agent: record.agent, cwd: record.cwd });
    try {
      try {
        await api.updateCardEntity(pending.cardId, entity, pending.seq + 1);
      } catch (first) {
        // 网络抖一下（尤其 15 秒超时）就原地重试一次，和 Stop 定稿的路径保持一致
        log.warn('处理中卡片收尾失败，原地重试一次', {
          cardId: pending.cardId, chatId: record.chatId, message: String((first && first.message) || first),
        });
        await api.updateCardEntity(pending.cardId, entity, pending.seq + 1);
      }
    } catch (err) {
      // 只 warn 的话群里那张卡会永远转圈，比多出一张重复卡更糟：兜底新发一张
      log.warn('处理中卡片收尾失败，改为新发一张', {
        cardId: pending.cardId, chatId: record.chatId, message: String((err && err.message) || err),
      });
      try {
        await api.sendCard(record.chatId, entity);
      } catch (e) {
        log.warn('兜底卡片发送失败', { chatId: record.chatId, message: String((e && e.message) || e) });
      }
    }
    // 收尾前的 save 仍带着 pendingCard，这里补一次把已清空的状态落盘
    saveSession(record);
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
    // 本轮归属必须在 releaseTurn 之前取：releaseTurn 会同步把队列里的下一条写进去并派发
    // turn-start，那一笔会立刻覆盖 turnInputs，取晚了回复就挂到下一句提问上了。
    const input = turnInputs.get(record.id) || record.lastInput;
    // ptySession 内部状态也要回到 idle，否则 canWrite 永远为 false，队列里的手机消息再也写不进去
    const stoppedPs = sessions.get(record.id);
    if (stoppedPs) stoppedPs.releaseTurn();
    record.lastActiveAt = new Date(now()).toISOString();
    saveSession(record);
    ipc?.broadcast({ type: 'session', session: record });

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
        // 更新请求带 uuid（cardId-sequence），同一 sequence 重复提交是幂等的。
        // 网络抖一下（尤其现在有 15 秒超时）就改发新卡，群里会多出一张内容重复的卡，
        // 所以先原地重试一次，仍失败再兜底新发。
        try {
          await api.updateCardEntity(pending.cardId, card, pending.seq + 1);
        } catch (first) {
          log.warn('卡片定稿失败，原地重试一次', {
            cardId: pending.cardId,
            chatId: record.chatId,
            message: String((first && first.message) || first),
          });
          await api.updateCardEntity(pending.cardId, card, pending.seq + 1);
        }
        saveSession(record);
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
    saveSession(record);
  }

  async function notifyCrash(record, e) {
    // 排队期间用户可能已经发「重来」把会话拉起来了：这时再报崩溃只会误导。
    if (record.status !== 'error') return;
    const code = typeof e.code === 'number' ? `（code ${e.code}）` : '';
    const text = `会话进程异常退出${code}。\n\n回复「重来」，我用 --resume 接着干。`;
    // 本轮那张「处理中」卡还在转圈：就地定稿成错误卡，别再额外发一张，
    // 否则群里永远挂着一条看起来还在跑的消息。
    if (record.pendingCard && record.pendingCard.cardId) {
      await finalizePendingCard(record, '', cards.errorCard({ title: '进程异常退出', text }));
      return;
    }
    try {
      await api.sendCard(record.chatId, cards.errorCard({ title: '进程异常退出', text }));
    } catch (err) {
      log.warn('崩溃通知发送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
  }

  // Codex 没有 Stop hook：轮次结束时把屏上最近画面推回群里当回复
  async function pushScreenOutput(record) {
    if (record.agent !== 'codex') return;
    const ps = sessions.get(record.id);
    if (!ps || ['error', 'closed', 'closing', 'interrupted'].includes(record.status)) return;
    let snap = '';
    try {
      snap = cleanCodexSnapshot(ps.screen.snapshot({ lines: 40 }));
    } catch (err) {
      log.warn('取画面失败', { sessionId: record.id, message: String((err && err.message) || err) });
      return;
    }
    const input = turnInputs.get(record.id) || record.lastInput;
    const fromPc = input && input.origin === 'pc' && String(input.text || '').trim();
    const lead = fromPc
      ? `🖥 你刚在电脑上问：${String(input.text).replace(/\s+/g, ' ').slice(0, 80)}`
      : '🖥 这一轮跑完了：';
    try {
      await api.sendCard(record.chatId, cards.screenOutputCard({
        lead, text: snap, agent: record.agent, cwd: record.cwd,
      }));
    } catch (err) {
      log.warn('画面推送失败', { chatId: record.chatId, message: String((err && err.message) || err) });
    }
  }

  async function closeSession(sessionId, { reason = 'closed', notify = false } = {}) {
    const record = store.get(sessionId);
    if (!record) return;

    const ps = sessions.get(sessionId);
    sessions.delete(sessionId);
    turnInputs.delete(sessionId);
    forcePending.delete(record.chatId);   // 会话都没了，暂存的「仍然发送」不该留到下一轮
    record.status = 'closing';        // 先置 closing，kill 出来的 exit 事件不会被当成崩溃
    saveSession(record);
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
    saveSession(record);
    // 本轮那张「处理中」卡已经没人会来定稿了：就地收尾，别让群里永远转圈。
    // 主动关闭 / 被解散不是崩溃，标题不能写成「进程异常退出」。
    await finalizePendingCard(record, '', cards.errorCard({
      title: '会话已结束', text: '这个会话已经停了，回复「重来」可以重新开一轮。',
    }));
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

    // 收尾的网络调用期间用户可能刚好回复「重来」把会话复活了：
    // 这时不能再删记录，否则 PTY 还活着、会话表里却没有它，成了永远收不掉的孤儿。
    if (!sessions.has(sessionId)) {
      try {
        store.remove(sessionId);
        store.save();
      } catch (err) {
        // 落盘失败最多让重启后多恢复一条已结束的记录，不能把会话已关闭这件事回滚成异常
        log.warn('落盘失败', { sessionId, message: errMessage(err) });
      }
    }
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

    // 上一轮那张「处理中」卡已经没人会来定稿了：先摘下来，等新进程起来后补一刀。
    // 同时自增轮次号，作废旧进程还在飞行中的建卡任务，别让它挂到新会话上。
    const stale = record.pendingCard;
    record.status = 'starting';
    record.pendingCard = null;
    record.turnSeq = (record.turnSeq || 0) + 1;
    record.lastActiveAt = new Date(now()).toISOString();
    record.resuming = record.agent === 'claude' && Boolean(record.claudeSessionId);
    saveSession(record);
    try {
      spawn(record);
    } catch (err) {
      // 目录校验过了也可能起不来（exe 被占、权限、Node 版本）：状态落成 error，
      // 别留个半个 starting 让「重来」以外的话都写进空气。
      record.resuming = false;
      record.status = 'error';
      try {
        store.save();
      } catch (e) {
        log.warn('重启失败落盘失败', { sessionId: record.id, message: errMessage(e) });
      }
      ipc?.broadcast({ type: 'session', session: record });
      log.error('会话重启失败', { sessionId: record.id, message: errMessage(err) });
      await closeOrphanCard(record, stale, '会话中断了，这一轮没有结果。');
      try {
        await api.sendCard(record.chatId, cards.errorCard({
          title: '会话起不来',
          text: `重启失败：${errMessage(err)}`,
        }));
      } catch (e) {
        log.warn('重启失败提示发送失败', { chatId: record.chatId, message: errMessage(e) });
      }
      return false;
    }
    ipc?.broadcast({ type: 'session', session: record });

    await closeOrphanCard(record, stale, '会话中断了，这一轮没有结果。');
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
    if (!config.ownerOpenId || !openId || openId !== config.ownerOpenId) {
      log.warn('忽略非主人的卡片操作', { chatId });
      return;
    }
    const act = action && action.act;
    if (act === 'force-send') {
      await onPhoneMessage({ chatId, text: '仍然发送', senderOpenId: openId });
      return;
    }
    if (act === 'full-screen') {
      const record = store.getByChat(chatId);
      const ps = record ? sessions.get(record.id) : null;
      if (!ps || ['error', 'closed', 'closing', 'interrupted'].includes(record.status)) {
        await api.sendText(chatId, '会话已经停了，看不到完整画面了。');
        return;
      }
      const lines = Math.min(Math.max(Math.floor(Number(action.lines)) || 200, 40), 500);
      let snap = '';
      try {
        snap = ps.screen.snapshot({ lines });
      } catch (err) {
        log.warn('取画面失败', { chatId, message: String((err && err.message) || err) });
        return;
      }
      await api.sendCard(chatId, cards.fullScreenCard({ text: snap, lines }));
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
      // 上次进程可能不是正常退出，本轮那张卡没来得及定稿：启动时补一刀
      await finalizePendingCard(record, '', cards.errorCard({
        title: '电脑重启了', text: '这一轮没有跑完。回一条消息我就接上。',
      }));
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

  // 镜像窗口 attach 时补当前画面；会话不活跃（重启后待恢复）就没有画面。
  function replayFor(sessionId) {
    const ps = sessions.get(sessionId);
    if (!ps || typeof ps.replay !== 'function') return '';
    try {
      return ps.replay();
    } catch (err) {
      log.warn('读取屏幕快照失败', { sessionId, message: String((err && err.message) || err) });
      return '';
    }
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
    if (['closed', 'closing'].includes(record.status)) return;
    // 排队期间用户可能已经回「重来」把会话拉起来了（revive 在第一个 await 前就改成
    // starting）：再降级重建会多出一个 PTY 抢同一个群，必须让位。
    if (record.status !== 'error') return;
    record.resuming = false;
    record.claudeSessionId = null;
    record.transcriptPath = null;
    record.status = 'starting';
    // 上一轮那张「处理中」卡片新 PTY 不会替它收尾，先摘下来，拉起新进程后补一刀
    const stale = record.pendingCard;
    record.pendingCard = null;
    try {
      store.save();
    } catch (err) {
      log.warn('重建状态落盘失败', { sessionId: record.id, message: String((err && err.message) || err) });
    }
    // 先拉起新 PTY 再发提示：await 期间若用户发消息，必须写进新 PTY 而不是已退出的旧 PTY
    try {
      spawn(record);
    } catch (err) {
      record.status = 'error';
      try {
        store.save();
      } catch (e) {
        log.warn('重建状态落盘失败', { sessionId: record.id, message: errMessage(e) });
      }
      log.error('重建会话失败', { sessionId: record.id, message: errMessage(err) });
      await closeOrphanCard(record, stale, '会话进程中途退出，这一轮没有结果。');
      try {
        await api.sendText(record.chatId, `重建会话失败：${errMessage(err)}。回复「重来」再试。`);
      } catch (e) {
        log.warn('重建失败提示发送失败', { chatId: record.chatId, message: errMessage(e) });
      }
      return;
    }
    ipc?.broadcast({ type: 'session', session: record });
    await closeOrphanCard(record, stale, '会话进程中途退出，这一轮没有结果。');
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
      try {
        await api.sendText(chatId, '附件下载失败了，把内容直接打出来吧。');
      } catch (notifyErr) {
        // 提示发不出去，最多是用户不知道图没落地；这里再抛就会把正文补投一起掀翻
        log.warn('附件失败提示没发出去', { chatId, message: String((notifyErr && notifyErr.message) || notifyErr) });
      }
      return text;
    }
  }

  async function handlePhoneMessage({
    chatId, text, media = null, senderOpenId = null,
  }) {
    // 缺 owner 或缺发送者时一律 fail-closed：宁可漏掉一条，也不能让陌生人指挥本机
    if (!config.ownerOpenId || !senderOpenId || senderOpenId !== config.ownerOpenId) {
      log.warn('忽略非主人的消息', { chatId });
      return;
    }

    const record = store.getByChat(chatId);
    let payload = String(text == null ? '' : text).trim();

    // 「仍然发送」是桥接命令，不是要发给 agent 的正文。没有匹配的暂存（被普通消息清掉、
    // 会话重开过）时只提示，绝不能把它当正文发出去，更不能在没登记过的群里拿它建出新会话。
    if (payload === '仍然发送') {
      const pending = forcePending.get(chatId);
      forcePending.delete(chatId);
      if (!pending) {
        await api.sendText(chatId, '没有等待确认的消息了。');
        return;
      }
      const ps = record && pending.sessionId === record.id ? sessions.get(record.id) : null;
      if (!ps) {
        await api.sendText(chatId, '那条消息已经过期了（会话重开过），把内容重新发一次吧。');
        return;
      }
      // 只有输入框确实还被挡着才值得强写。用户已经在电脑前把菜单处理掉、这一轮正跑着时
      // 强写会重新派发 turn-start，把当前回合的 pendingCard 冲成一张永远转圈的卡；
      // 这时按普通消息排队，等这一轮结束自然写进去。
      const force = ps.needsConfirm();
      let forced;
      try {
        forced = ps.submitText(pending.text, 'phone', force ? { force: true } : undefined);
      } catch (err) {
        // 强写绕过队列，pty.write 抛错时没有 onError 兜底：不回一条消息用户以为发出去了
        log.warn('强行发送失败', { chatId, message: errMessage(err) });
        await api.sendText(chatId, '这条没写进去（会话那边报错了），把内容重新发一次吧。');
        return;
      }
      if (forced === 'closed') {
        await api.sendText(chatId, '会话刚刚断开了，回复「重来」重新开一轮。');
      } else if (forced === 'full') {
        await api.sendText(chatId, `积压了 ${config.queueLimit} 条还没处理完，稍后再发。`);
      }
      return;
    }
    forcePending.delete(chatId);

    if (!record) {
      // 没登记过的群：首句即建会话指令（ws 层只把 @机器人 或带附件的消息转发到这里）
      const created = await createFromPhone({
        chatId, chatName: null, text, media, agent: config.defaultAgent || 'claude',
      });
      // 首条就是附件时正文是空的，会话建好后必须把附件补投进去，否则这张图就丢了
      if (created && media) {
        const withMedia = await attachMedia(chatId, '', media);
        const ps = sessions.get(created.id);
        if (ps && withMedia) ps.submitText(withMedia, 'phone');
      }
      return;
    }

    let ps = sessions.get(record.id);

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

    if (media) payload = await attachMedia(chatId, payload, media);
    if (!payload) return;

    if (ps.needsConfirm()) {
      forcePending.set(chatId, { text: payload, sessionId: record.id });
      await api.sendCard(chatId, cards.screenCard({
        text: ps.screen.snapshot({ lines: 40 }),
        reason: 'not-ready',
      }));
      return;
    }

    const result = ps.submitText(payload, 'phone');
    if (result === 'full') {
      await api.sendText(chatId, `积压了 ${config.queueLimit} 条还没处理完，稍后再发。`);
    } else if (result === 'closed') {
      await api.sendText(chatId, '会话刚刚断开了，回复「重来」重新开一轮。');
    }
  }

  // 同一个群的消息严格串行：并发进来时，媒体下载慢的那条会让后面的消息插队，
  // 「护栏提示 → 仍然发送」也可能被打乱。排队后处理顺序和发送顺序一致。
  function serializeChat(chatId, fn) {
    const prev = chatChains.get(chatId) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});   // 链尾吃掉异常，一条消息失败不能卡死后面的
    chatChains.set(chatId, tail);
    tail.then(() => {
      if (chatChains.get(chatId) === tail) chatChains.delete(chatId);
    });
    return run;
  }

  function onPhoneMessage(args) {
    return serializeChat(args.chatId, () => handlePhoneMessage(args));
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
    replayFor,
    list,
    shutdown,
    _drain: drainWork,
    _sessions: sessions,
  };
}

module.exports = { createManager };
