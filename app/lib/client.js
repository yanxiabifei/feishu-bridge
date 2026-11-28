// daemon 的 WebSocket 客户端：断线自动重连，消息按 type 分发给订阅者。
// 只依赖 ws 的实现注入（测试里可以直接用 require('ws')），不依赖 Electron。
function createDaemonClient({
  WebSocketImpl,
  url,
  log = { warn() {} },
  reconnect = true,
  minBackoffMs = 500,
  maxBackoffMs = 8000,
  now = () => Date.now(),
  onTransportChange,
}) {
  let ws = null;
  let state = 'closed'; // closed | connecting | open
  let attempts = 0;
  let timer = null;
  let stopped = false;
  const listeners = new Set();

  function setState(next) {
    if (state === next) return;
    state = next;
    try {
      if (onTransportChange) onTransportChange(next);
    } catch (err) {
      log.warn('client.transport_listener_failed', { error: String((err && err.message) || err) });
    }
  }

  function emit(msg) {
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch (err) {
        log.warn('client.listener_failed', { error: String((err && err.message) || err) });
      }
    }
  }

  function scheduleReconnect() {
    if (!reconnect || stopped) return;
    const delay = Math.min(maxBackoffMs, minBackoffMs * (2 ** attempts));
    attempts += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    if (timer.unref) timer.unref();
  }

  function connect() {
    if (stopped || ws) return;
    setState('connecting');
    const socket = new WebSocketImpl(url);
    ws = socket;
    socket.on('open', () => {
      attempts = 0;
      setState('open');
      emit({ type: 'transport', state: 'open' });
    });
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      emit(msg);
    });
    socket.on('error', (err) => {
      // 不处理会变成未捕获异常；close 事件随后一定会来，重连逻辑放那里
      log.warn('client.socket_error', { error: String((err && err.message) || err) });
    });
    socket.on('close', () => {
      ws = null;
      if (stopped) {
        setState('closed');
        return;
      }
      setState('connecting');
      emit({ type: 'transport', state: 'closed', at: now() });
      scheduleReconnect();
    });
  }

  return {
    connect,
    send(msg) {
      if (!ws || ws.readyState !== ws.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (ws) {
        const s = ws;
        ws = null;
        try { s.close(); } catch { /* 已经断了 */ }
      }
      setState('closed');
    },
    get state() { return state; },
  };
}

module.exports = { createDaemonClient };
