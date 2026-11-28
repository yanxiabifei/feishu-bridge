// 窗口进程不在线时，daemon 直接把窗口拉起来并接进新会话（见 design 第五节）。
// 这不是「通知」的替代品里的讨巧写法：手机建群的目的是电脑上接着干，
// 少一步「点通知」就是少一步会失败的环节，也不需要 AUMID + 协议注册那套东西。
const fs = require('node:fs');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');

const COOLDOWN_MS = 30000;

// 打包版启动时会把 process.execPath 写进 config.windowExe；开发模式没有这一项，
// 退回到 node_modules 里的 electron + 仓库根目录（electron.exe <仓库根> 就是 npm run window）。
function resolveWindowCommand({ config = {}, root, existsSync = fs.existsSync } = {}) {
  const exe = typeof config.windowExe === 'string' ? config.windowExe.trim() : '';
  if (exe && existsSync(exe)) return { command: exe, args: [] };
  if (root) {
    const devExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (existsSync(devExe)) return { command: devExe, args: [root] };
  }
  return null;
}

function createWindowLauncher({
  config = {},
  root,
  log,
  spawn = realSpawn,
  existsSync = fs.existsSync,
  now = Date.now,
  cooldownMs = COOLDOWN_MS,
} = {}) {
  let lastLaunchAt = -Infinity; // 从没拉过，第一次不受冷却限制

  // clientCount 由调用方传入：窗口自己在线的路径是 IPC 广播，这里只负责离线兜底。
  function launch(sessionId, clientCount = 0) {
    if (!sessionId) return { launched: false, reason: 'no_session' };
    if (config.windowAutoLaunch === false) {
      log.info('window.launch_skipped', { sessionId, reason: 'disabled' });
      return { launched: false, reason: 'disabled' };
    }
    if (clientCount > 0) return { launched: false, reason: 'online' };

    const resolved = resolveWindowCommand({ config, root, existsSync });
    if (!resolved) {
      log.warn('window.launch_skipped', {
        sessionId,
        reason: 'no_exe',
        hint: '打包版首次运行后会自动写入 windowExe；开发模式请确认 node_modules/electron 已安装',
      });
      return { launched: false, reason: 'no_exe' };
    }

    const t = now();
    if (t - lastLaunchAt < cooldownMs) {
      log.info('window.launch_skipped', { sessionId, reason: 'cooldown' });
      return { launched: false, reason: 'cooldown' };
    }
    lastLaunchAt = t;

    const args = [...resolved.args, '--session', String(sessionId)];
    try {
      const child = spawn(resolved.command, args, { detached: true, stdio: 'ignore' });
      // detached 的子进程能不能起来是异步才知道的；不挂 error 会变成主进程未捕获异常
      if (child && typeof child.on === 'function') {
        child.on('error', (err) => {
          log.warn('window.launch_failed', { sessionId, error: String((err && err.message) || err) });
        });
        if (typeof child.unref === 'function') child.unref();
      }
      log.info('window.launched', { sessionId, command: resolved.command });
      return { launched: true, reason: 'spawned' };
    } catch (err) {
      log.warn('window.launch_failed', { sessionId, error: String((err && err.message) || err) });
      return { launched: false, reason: 'error' };
    }
  }

  return { launch };
}

module.exports = { COOLDOWN_MS, resolveWindowCommand, createWindowLauncher };
