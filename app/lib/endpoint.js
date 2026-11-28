const fs = require('node:fs');

// 窗口不自己保管端口和 token：一律从 daemon 写下的 state/ipc.json 读，
// 这样 daemon 换了端口（或重启换了 token）窗口重连时不会用上过期值。
function readEndpoint({ file, fsApi = fs }) {
  let text;
  try {
    text = fsApi.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error('后台守护进程没有在运行：找不到 state/ipc.json，先运行 npm start');
    }
    throw err;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let info;
  try {
    info = JSON.parse(text);
  } catch {
    throw new Error(`state/ipc.json 已损坏：${file}，删掉后重启 npm start`);
  }
  if (!info || !Number.isInteger(info.port) || info.port <= 0 || typeof info.token !== 'string' || !info.token) {
    throw new Error(`state/ipc.json 内容不完整：${file}，删掉后重启 npm start`);
  }
  return { port: info.port, token: info.token, pid: info.pid };
}

function buildWsUrl({ port, token }) {
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

module.exports = { readEndpoint, buildWsUrl };
