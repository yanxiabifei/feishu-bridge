const fs = require('node:fs');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { restrictAcl } = require('./secrets');
const { writeJsonAtomic } = require('./store');

// handler 名白名单：日志 event/字段只用固定值，绝不拼接动态内容。
const HANDLER_NAMES = new Set(['onHookStop', 'onClientOpen', 'onClientMessage']);

// hook 只上报一轮对话的文本，256KB 已经远超正常用量；不设上限就是内存放大器
const MAX_HOOK_BODY = 256 * 1024;
// 窗口发给 daemon 的都是小段 JSON（按键、attach、resize），1MB 足够
const MAX_WS_MESSAGE = 1024 * 1024;
// 窗口断电/休眠后拿不到 FIN，只能靠 ping 把死连接筛出来
const HEARTBEAT_MS = 30000;

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

// ipc.json 的写盘 / ACL 失败只记 warn：daemon 启动不能因此挂起或抛未捕获异常。
function warnIpcError(log, event, err) {
  try {
    let message;
    try {
      message = (err && err.message) || String(err);
    } catch {
      message = 'unknown error';
    }
    if (log && typeof log.warn === 'function') {
      log.warn(event, { error: message });
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

function startIpc({ port = 0, token, handlers = {}, log, ipcFile, acl = restrictAcl }) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      // 畸形请求目标（"//"、"//[" 之类）会让 new URL 抛错；
      // 不接住就是 req 回调里冒出的 uncaughtException，整个 daemon 陪葬
      res.writeHead(400);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/hook/stop') {
      // token 没配置时必须拒绝：缺请求头时 undefined === undefined 会直接放行
      if (typeof token !== 'string' || token === '' || req.headers['x-bridge-token'] !== token) {
        res.writeHead(401);
        res.end();
        return;
      }
      // 按 Buffer 收齐再解码：按 chunk 转字符串会把跨分片的中文字符劈成乱码
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        if (tooLarge) return;
        chunks.push(c);
        size += c.length;
        if (size > MAX_HOOK_BODY) {
          tooLarge = true;
          chunks.length = 0;
          res.writeHead(413);
          res.end();
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 空 body 按空对象处理 */ }
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

  const wss = new WebSocketServer({ server, maxPayload: MAX_WS_MESSAGE });
  // wss 会把底层 server 的 'error' 再转发射一次；没有监听者就是 uncaughtException。
  wss.on('error', (err) => warnIpcError(log, 'ipc.ws_error', err));
  wss.on('connection', (ws, req) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      ws.close(4000, 'bad request');
      return;
    }
    if (typeof token !== 'string' || token === '' || url.searchParams.get('token') !== token) {
      ws.close(4001, 'unauthorized');
      return;
    }
    clients.add(ws);
    ws.isAlive = true;
    // 畸形帧（无效 UTF-8、超大帧）会让 ws 在连接对象上 emit('error')，
    // 没有监听者时 EventEmitter 直接抛成 uncaughtException，整个 daemon 陪葬
    ws.on('error', (err) => warnIpcError(log, 'ipc.ws_client_error', err));
    ws.on('pong', () => { ws.isAlive = true; });
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

  // 端口被占用（两个实例同时启动）必须变成可捕获的 rejection：
  // 没有 error 监听的 'error' 事件在 Node 里是 uncaughtException，直接崩进程。
  return new Promise((resolve, reject) => {
    const onListenError = (err) => reject(err);
    server.once('error', onListenError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onListenError);
      server.on('error', (err) => warnIpcError(log, 'ipc.server_error', err));

      const heartbeat = setInterval(() => {
        for (const ws of clients) {
          if (ws.isAlive === false) { ws.terminate(); continue; }
          ws.isAlive = false;
          try { ws.ping(); } catch { /* 已经断开 */ }
        }
      }, HEARTBEAT_MS);
      if (heartbeat.unref) heartbeat.unref();

      const actualPort = server.address().port;
      if (ipcFile) {
        try {
          // 原子写：hook 每次 Stop 都会读这个文件，普通写有短暂的半截窗口
          writeJsonAtomic(ipcFile, {
            port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString(),
          });
          try {
            acl(ipcFile);
          } catch (err) {
            // ACL 失败不能拖垮 daemon（比如未登录的 unattended 启动）
            warnIpcError(log, 'ipc.acl_failed', err);
          }
        } catch (err) {
          warnIpcError(log, 'ipc.write_failed', err);
        }
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
            clearInterval(heartbeat);
            for (const ws of clients) ws.terminate();
            wss.close();
            // keep-alive 的连接会拖住 server.close 的回调，直接断掉
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => {
              try {
                if (ipcFile && fs.existsSync(ipcFile)) fs.unlinkSync(ipcFile);
              } catch {
                // 清理失败（文件被占用 / 路径是目录）不影响关闭
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
