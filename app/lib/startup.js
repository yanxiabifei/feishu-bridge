// 窗口的开机自启走 HKCU\...\Run：不需要管理员权限，取消勾选直接删值。
// 打包产物是免安装文件夹，没有安装器可挂「安装时注册」，所以由打包版自己在启动时补一次。
// 只在打包版调用。开发模式写注册表会把 electron.exe 钉死成一个没有仓库参数的裸进程。
const { execFileSync } = require('node:child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'FeishuBridge.Window';

const isWindows = (platform) => platform === 'win32';

function defaultExec(file, args) {
  return execFileSync(file, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 5000,
  });
}

// 路径里有空格（C:\Program Files\...）不加引号会被 CreateProcess 从空格处截断
function autostartCommand(exePath) {
  return `"${exePath}" --hidden`;
}

function isEnabled({ exec = defaultExec, platform = process.platform } = {}) {
  if (!isWindows(platform)) return false;
  try {
    exec('reg.exe', ['query', RUN_KEY, '/v', VALUE_NAME]);
    return true;
  } catch {
    return false;
  }
}

// 返回「写完之后注册表里的真实状态」，而不是「命令有没有报错」：
// 杀软拦注册表时 reg 有时仍返回 0，只有回查才靠得住。
function setEnabled({ exec = defaultExec, exePath, enabled, platform = process.platform }) {
  if (!isWindows(platform)) return false;
  if (enabled) {
    if (!exePath) return false;
    try {
      exec('reg.exe', [
        'add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', autostartCommand(exePath), '/f',
      ]);
    } catch {
      /* 回查给结论 */
    }
  } else {
    try {
      exec('reg.exe', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
    } catch {
      /* 本来就没有这一项也算成功 */
    }
  }
  return isEnabled({ exec, platform });
}

module.exports = { RUN_KEY, VALUE_NAME, autostartCommand, isEnabled, setEnabled };
