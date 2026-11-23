const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');

function safeInvoke(log, name, fn) {
  setImmediate(() => {
    let ret;
    try {
      ret = fn();
    } catch (err) {
      if (log && log.warn) log.warn(`ipc: ${name} threw: ${(err && err.message) || err}`);
      return;
    }
    if (ret && typeof ret.then === 'function') {
      ret.then(undefined, (err) => {
        if (log && log.warn) log.warn(`ipc: ${name} rejected: ${(err && err.message) || err}`);
      });
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
      resolve({
        port: actualPort,
        broadcast(obj) { for (const ws of clients) send(ws, obj); },
        send(ws, obj) { send(ws, obj); },
        close() {
          return new Promise((done) => {
            for (const ws of clients) ws.terminate();
            wss.close();
            server.close(() => {
              if (ipcFile && fs.existsSync(ipcFile)) fs.unlinkSync(ipcFile);
              done();
            });
          });
        },
      });
    });
  });
}

module.exports = { startIpc };
