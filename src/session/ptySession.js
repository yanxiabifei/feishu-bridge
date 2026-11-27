const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const READY_POLL_MS = 200;
const CODEX_MIN_TURN_MS = 1500;   // 刚写进去的这段不判结束
const CODEX_SETTLE_POLLS = 3;     // 静默稳定连续 3 次探测（200ms × 3）

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
      if (!screen.isReady()) return;
      status = 'idle';
      session.status = 'idle';
      emit({ type: 'ready' });
      queue.release();
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
    }
  }

  function onExit(info) {
    clearReadyTimer();
    status = 'closed';
    session.status = 'closed';
    disposed = true;
    queue.drain();
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
    if (data.includes('\r') || data.includes('\n')) {
      const seq = session.inputSeq + 1;
      session.inputSeq = seq;
      session.lastInput = { seq, origin: 'pc', text: screen.inputLine(), at: now() };
      status = 'running';
      session.status = 'running';
      runningSince = now();
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
    queue.drain();
    if (pty) pty.kill();
    emitExitOnce(0);
    disposeScreen();
  }

  return {
    session, start, submitText, onPcKeys, resize, releaseTurn, kill, pollReady,
    _pollReady: pollReady, _queue: queue,
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

module.exports = { createPtySession };
