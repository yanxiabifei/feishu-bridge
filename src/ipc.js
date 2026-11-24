const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');

// handler 名白名单：日志 event/字段只用固定值，绝不拼接动态内容。
const HANDLER_NAMES = new Set(['onHookStop', 'onClientOpen', 'onClientMessage']);

// 错误日志走结构化字段，交给 createLogger 的 redactor 脱敏；
// 日志自身（appendFileSync）可能因磁盘/权限失败抛错，必须吞掉，不能拖垮 daemon。
function reportHandlerError(log, name, err) {
  try {
    const handler = HANDLER_NAMES.has(name) ? name : 'unknown';
    let message;
    try {
      message = (err && err.message) || err;
    } catch {
      message = 'unknown error';
    }
    if (log && typeof log.warn === 'function') {
      log.warn('ipc.handler_error', { handler, error: message });
    }
  } catch {
    /* 日志失败不影响 daemon */
  }
}

function safeInvoke(log, name, fn) {
  setImmediate(() => {
    let ret;
    try {
      ret = fn();
    } catch (err) {
      reportHandlerError(log, name, err);
      return;
    }
    if (ret && typeof ret.then === 'function') {
      try {
        // Promise.resolve 会把“thenable 的 then 同步抛错”转成 rejection。
        Promise.resolve(ret)
          .then(undefined, (err) => reportHandlerError(log, name, err))
          .catch(() => {});
      } catch {
        /* thenable 的 then 直接抛错也不能拖垮 daemon */
      }
    }
  });
}

function startIpc({ port = 0, token, handlers = {}, log, ipcFile }) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hook/stop') {
      if (req.headers['x-bridge-token'] !== token) {
        res.writeHead(401);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        let payload = {};
        try { payload = JSON.parse(body); } catch { /* 空 body 按空对象处理 */ }
        const sessionId = url.searchParams.get('session') || '';
        if (handlers.onHookStop) {
          safeInvoke(log, 'onHookStop', () => handlers.onHookStop({ sessionId, payload }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.searchParams.get('token') !== token) {
      ws.close(4001, 'unauthorized');
      return;
    }
    clients.add(ws);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (handlers.onClientMessage) {
        safeInvoke(log, 'onClientMessage', () => handlers.onClientMessage(msg, ws));
      }
    });
    ws.on('close', () => clients.delete(ws));
    if (handlers.onClientOpen) {
      safeInvoke(log, 'onClientOpen', () => handlers.onClientOpen(ws));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      if (ipcFile) {
        fs.mkdirSync(path.dirname(ipcFile), { recursive: true });
        fs.writeFileSync(ipcFile, JSON.stringify({
          port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString(),
        }, null, 2));
      }
      const send = (ws, obj) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      };
      let closing = null;
      resolve({
        port: actualPort,
        broadcast(obj) { for (const ws of clients) send(ws, obj); },
        send(ws, obj) { send(ws, obj); },
        close() {
          if (closing) return closing;
          closing = new Promise((done) => {
            for (const ws of clients) ws.terminate();
            wss.close();
            server.close(() => {
              try {
                if (ipcFile && fs.existsSync(ipcFile)) fs.unlinkSync(ipcFile);
              } finally {
                done();
              }
            });
          });
          return closing;
        },
      });
    });
  });
}

module.exports = { startIpc };
