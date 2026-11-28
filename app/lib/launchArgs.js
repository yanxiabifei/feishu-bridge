// daemon 拉起窗口时带 --session <id>；开机自启时带 --hidden（只进托盘，别开机就糊一脸）。
// 开发模式下 argv[0] 是 electron.exe、argv[1] 是仓库目录，打包后又是应用 exe，
// 所以这里不假设参数从第几个开始，整表扫一遍。
function parseLaunchArgs(argv = process.argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let hidden = false;
  let sessionId = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--hidden') {
      hidden = true;
      continue;
    }
    if (arg === '--session') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        sessionId = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--session=')) {
      const value = arg.slice('--session='.length);
      if (value) sessionId = value;
    }
  }
  return { hidden, sessionId };
}

module.exports = { parseLaunchArgs };
