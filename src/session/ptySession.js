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
    const spec = launch();
    pty = ptyFactory(spec);
    pty.onData((data) => { screen.write(data); });
    pty.onExit((info) => { onExit(info); });
    readyTimer = setInterval(pollReady, READY_POLL_MS);
    if (readyTimer.unref) readyTimer.unref();
    emit({ type: 'spawned', file: spec.file, cwd: spec.cwd });
  }

  function submitText(text, origin, { force = false } = {}) {
    if (disposed || status === 'closed') {
      emit({ type: 'input', origin, text, queued: false });
      return 'closed';
    }
    const seq = session.inputSeq + 1;
    session.inputSeq = seq;
    session.lastInput = { origin, text, seq, at: now() };
    const item = { text, origin, seq };
    if (force) {
      // 菜单/弹窗挡住输入框时用户仍要求发送：无视 canWrite 判断直接写入。
      writeItem(item);
      return 'written';
    }
    return queue.push(item);
  }

  function onPcKeys(data) {
    if (disposed || status === 'closed' || !pty) return;
    pty.write(data);
    if (data.includes('\r')) {
      const seq = session.inputSeq + 1;
      session.inputSeq = seq;
      session.lastInput = { origin: 'pc', text: screen.inputLine(), seq, at: now() };
      status = 'running';
      session.status = 'running';
      emit({ type: 'pc-input', text: session.lastInput.text, seq });
    }
  }

  function releaseTurn() {
    if (disposed || status === 'closed') return;
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
        alias: session.alias,
        status,
        pending: queue.size(),
        lastInput: session.lastInput,
      };
    },
    get status() { return status; },
    get lastInput() { return session.lastInput; },
    get screen() { return screen; },
  };
}

module.exports = { createPtySession };
