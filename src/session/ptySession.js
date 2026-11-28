const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const READY_POLL_MS = 200;
const CODEX_MIN_TURN_MS = 1500;   // 刚写进去的这段不判结束
const CODEX_SETTLE_POLLS = 3;     // 静默稳定连续 3 次探测（200ms × 3）
// 电脑回车也可能不产生回合（空回车、/clear、弹窗上回车），Claude 没有 Stop hook 兜底，
// 没有这条看门狗会话会永远卡在 running，手机消息再也写不进去。
// 三轮多完全无输出、画面回到输入框，就按「回合已结束」处理。
const IDLE_GUARD_MS = 180000;
// 进程起来后一个字节都不输出：isReady 永远等不到，队列会永远堵在这里，
// 手机那边只会看到消息一直「已发送」。超时后必须止损。
const START_DEADLINE_MS = 120000;

// 宿主自己跑在 Claude Code 里时（从终端里 `npm start` 就是这种情况），环境会带一串
// 会话标记；传给子 claude 会让它认为自己是子会话，打出「Transcript saving is off」，
// 多出来的页脚还会让输入框判定失败，手机消息就永远卡在队列里。
const HOST_MARKER_VARS = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

function childEnv(base) {
  const env = { ...base, FORCE_COLOR: '1', TERM: 'xterm-256color' };
  for (const k of HOST_MARKER_VARS) delete env[k];
  return env;
}

function createPtySession({
  session, launch, ptyFactory, screenFactory, queueFactory, log, onEvent,
  now = () => Date.now(), queueLimit = 20,
}) {
  let status = session.status === 'idle' ? 'starting' : (session.status || 'starting');
  let pty = null;
  let readyTimer = null;
  let disposed = false;
  let exitEmitted = false;
  let screenDisposed = false;
  let runningSince = 0;
  let settlePolls = 0;
  let lastActivityAt = 0;   // 最后一次有 PTY 输出或写入的时间，看门狗用
  let startDeadlineAt = 0;  // 启动后一直没输出的止损线

  const screen = screenFactory({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  const emit = (e) => onEvent({ sessionId: session.id, ...e });

  function clearReadyTimer() {
    if (readyTimer) {
      clearInterval(readyTimer);
      readyTimer = null;
    }
  }

  function disposeScreen() {
    if (screenDisposed) return;
    screenDisposed = true;
    screen.dispose();
  }

  function emitExitOnce(code, signal) {
    if (exitEmitted) return;
    exitEmitted = true;
    emit({ type: 'exit', code, signal });
  }

  // 会话结束时排队还没写进去的消息不会再发出去了，必须让上层知道，
  // 否则手机那边只收到过「已排队」，以为消息已经送进去了。
  function dropQueue() {
    const dropped = queue.drain();
    if (dropped.length) emit({ type: 'queue-dropped', items: dropped });
    return dropped;
  }

  // 写入一次输入：先进入 running，pty 抛错则回滚到 idle 再抛出，
  // 让队列的 pump 捕获并通过 onError 派发，否则状态会永久卡在 running。
  function writeItem(item) {
    status = 'running';
    session.status = 'running';
    try {
      pty.write(screen.bracketedPaste(item.text) + '\r');
    } catch (err) {
      status = 'idle';
      session.status = 'idle';
      throw err;
    }
    runningSince = now();
    lastActivityAt = runningSince;
    settlePolls = 0;
    emit({ type: 'turn-start', seq: item.seq, origin: item.origin, text: item.text });
  }

  const queue = queueFactory({
    limit: queueLimit,
    canWrite: () => status === 'idle' && screen.isReady() && screen.inInputBox(),
    write: writeItem,
    onOverflow(item) { emit({ type: 'overflow', text: item.text }); },
    onError(err) { emit({ type: 'error', message: String((err && err.message) || err) }); },
  });

  function pollReady() {
    if (disposed || status === 'closed') return;
    if (status === 'starting') {
      if (screen.isReady()) {
        status = 'idle';
        session.status = 'idle';
        emit({ type: 'ready' });
        queue.release();
        return;
      }
      // 一个字节都没有输出过，isReady 永远不会成立：到点止损，别让队列一直堵着
      if (lastActivityAt === 0 && now() >= startDeadlineAt) {
        emit({ type: 'error', message: '会话进程长时间没有任何输出，已经停掉了。回复「重来」再试。' });
        kill();
      }
      return;
    }
    if (status === 'idle' && queue.pending() > 0 && !queue.inFlight()) {
      queue.release();
    }
    // Codex 没有 Stop hook：画面静默稳定且回到输入框，就认为这一轮结束了
    if (status === 'running' && session.agent === 'codex') {
      const stable = screen.isReady() && screen.inInputBox() && now() - runningSince >= CODEX_MIN_TURN_MS;
      settlePolls = stable ? settlePolls + 1 : 0;
      if (settlePolls >= CODEX_SETTLE_POLLS) {
        settlePolls = 0;
        emit({ type: 'turn-end' });
        releaseTurn();
      }
      return;
    }
    // Claude 的看门狗：回车后根本没起回合时 Stop 不会来，靠「长时间无输出 + 回到输入框」自愈
    if (status === 'running'
        && now() - lastActivityAt >= IDLE_GUARD_MS
        && screen.isReady() && screen.inInputBox()) {
      emit({ type: 'turn-end', guard: 'idle' });
      releaseTurn();
    }
  }

  function onExit(info) {
    clearReadyTimer();
    status = 'closed';
    session.status = 'closed';
    disposed = true;
    dropQueue();
    // node-pty 在子进程自然退出后不会自己 dispose：windowsTerminal.js:97-100 的
    // socket close 只调 _close()，从不调 WindowsPtyAgent.kill()；而 conout Worker
    // 的 dispose() 只存在于 WindowsPtyAgent.kill() 内部（windowsPtyAgent.js:151），
    // 于是 MessagePort 一直撑住事件循环。对原始 pty 再调一次 kill 才走 dispose；
    // 先把 pty 摘掉防止重入。
    if (pty) {
      const p = pty;
      pty = null;
      try { p.kill(); } catch { /* 已经退出 */ }
    }
    disposeScreen();
    emitExitOnce(info && info.exitCode, info && info.signal);
  }

  function start() {
    if (pty || disposed) return;
    startDeadlineAt = now() + START_DEADLINE_MS;
    const l = launch(session);
    pty = ptyFactory(l.file, l.args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: l.cwd,
      env: childEnv(process.env),
    });
    pty.onData((d) => {
      if (disposed) return;
      lastActivityAt = now();
      screen.write(d);
      emit({ type: 'data', data: d });
    });
    pty.onExit((info) => { onExit(info); });
    readyTimer = setInterval(pollReady, READY_POLL_MS);
    if (readyTimer.unref) readyTimer.unref();
    emit({ type: 'spawned', pid: pty.pid });
  }

  function submitText(text, origin, { force = false } = {}) {
    if (disposed || status === 'closed') {
      emit({ type: 'input', input: session.lastInput, queued: false, rejected: true, reason: 'closed' });
      return 'closed';
    }
    const seq = session.inputSeq + 1;
    session.inputSeq = seq;
    session.lastInput = { seq, origin, text, at: now() };
    const item = { seq, text, origin };
    if (force) {
      // 菜单/弹窗挡住输入框时用户仍要求发送：无视 canWrite 判断直接写入。
      writeItem(item);
      emit({ type: 'input', input: session.lastInput, queued: false, forced: true });
      return 'queued';
    }
    const result = queue.push(item);
    emit({ type: 'input', input: session.lastInput, queued: result === 'queued' });
    return result;
  }

  function onPcKeys(data) {
    if (disposed || status === 'closed' || !pty) return;
    pty.write(data);
    if (status === 'starting') return;
    if (status === 'running') {
      // 这一轮还没结束：此刻敲进去的是排给下一轮的，不能抢走 lastInput，
      // 否则本轮结果卡片会被标成「你刚在电脑上问：…」。按键已在上面透传。
      lastActivityAt = now();
      return;
    }
    if (data.includes('\r') || data.includes('\n')) {
      const seq = session.inputSeq + 1;
      session.inputSeq = seq;
      session.lastInput = { seq, origin: 'pc', text: screen.inputLine(), at: now() };
      status = 'running';
      session.status = 'running';
      runningSince = now();
      lastActivityAt = runningSince;
      settlePolls = 0;
      emit({ type: 'pc-input', input: session.lastInput });
    }
  }

  // 窗口改尺寸：屏幕缓冲和 ConPTY 都要跟着变，否则换行位置会错。
  function resize(cols, rows) {
    const c = Math.floor(Number(cols));
    const r = Math.floor(Number(rows));
    if (!(c > 0 && r > 0)) return;
    if (screen && typeof screen.resize === 'function') screen.resize(c, r);
    if (pty && typeof pty.resize === 'function') pty.resize(c, r);
  }

  function releaseTurn() {
    settlePolls = 0;
    if (disposed || status === 'closed' || status !== 'running') return;
    status = 'idle';
    session.status = 'idle';
    queue.release();
  }

  function kill() {
    if (disposed) return;
    disposed = true;
    status = 'closed';
    clearReadyTimer();
    dropQueue();
    const p = pty;
    pty = null;
    // pty 可能已经在退出过程中，kill 自己抛错不能把后面的收尾（exit/屏幕释放）全跳过
    if (p) {
      try { p.kill(); } catch { /* 已经退出 */ }
    }
    emitExitOnce(0);
    disposeScreen();
  }

  return {
    session, start, submitText, onPcKeys, resize, releaseTurn, kill, pollReady,
    _pollReady: pollReady, _queue: queue,
    // 镜像窗口 attach 时补画面：屏幕当前的 ANSI 快照
    replay() {
      return typeof screen.serialize === 'function' ? screen.serialize() : '';
    },
    needsConfirm() { return status === 'idle' && !screen.inInputBox(); },
    snapshot() {
      return {
        id: session.id,
        chatId: session.chatId,
        agent: session.agent,
        cwd: session.cwd,
        alias: session.alias || null,
        status,
        pending: queue.pending(),
        lastInput: session.lastInput,
      };
    },
    get status() { return status; },
    get lastInput() { return session.lastInput; },
    get screen() { return screen; },
  };
}

module.exports = { createPtySession, childEnv };
