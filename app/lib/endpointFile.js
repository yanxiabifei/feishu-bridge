// 窗口进程不在仓库目录里跑（打包后 exe 在 dist 下），`__dirname/..` 算不出 state/ipc.json。
// 顺序：显式环境变量 → 当前目录 → exe 所在目录及其上 4 层 → app.getAppPath() 及其上 4 层。
const path = require('node:path');
const fs = require('node:fs');

function addUpward(out, startDir) {
  let dir = startDir;
  for (let i = 0; i <= 4; i += 1) {
    out.push(path.join(dir, 'state', 'ipc.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function listCandidates({ env = process.env, cwd = process.cwd(), execPath = process.execPath, appPath } = {}) {
  const out = [];
  if (env.FEISHU_BRIDGE_IPC) out.push(path.resolve(env.FEISHU_BRIDGE_IPC));
  out.push(path.join(cwd, 'state', 'ipc.json'));
  addUpward(out, path.dirname(execPath));
  if (appPath) addUpward(out, appPath);
  return [...new Set(out)];
}

// 第一个存在的文件胜出；都不存在时返回第一个候选，让 readEndpoint 报出可读的「先运行 npm start」。
function locateEndpointFile(opts = {}) {
  const fsApi = opts.fsApi || fs;
  const candidates = listCandidates(opts);
  return candidates.find((file) => fsApi.existsSync(file)) || candidates[0];
}

module.exports = { listCandidates, locateEndpointFile };
