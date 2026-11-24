const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const READY_POLL_MS = 200;

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
  }

  function onExit(info) {
    clearReadyTimer();
    status = 'closed';
    session.status = 'closed';
    disposed = true;
    queue.drain();
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
      env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' },
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
      emit({ type: 'pc-input', input: session.lastInput });
    }
  }

  function releaseTurn() {
    if (disposed || status === 'closed' || status !== 'running') return;
    status = 'idle';
    session.status = 'idle';
    queue.release();
  }

  function kill() {
    if (disposed) return;
    disposed = true;
    status = 'closed';
    session.status = 'closed';
    clearReadyTimer();
    queue.drain();
    if (pty) pty.kill();
    emitExitOnce(0);
    disposeScreen();
  }

  return {
    session, start, submitText, onPcKeys, releaseTurn, kill, pollReady,
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
