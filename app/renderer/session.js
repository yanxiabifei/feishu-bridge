// 会话窗口：终端只负责显示和收键，PTY 与消息路由都在 daemon/主进程那头。
const titleEl = document.getElementById('title');
const syncEl = document.getElementById('sync');
const bottomEl = document.getElementById('bottom');
const dimsEl = document.getElementById('dims');
const screenEl = document.getElementById('screen');
const overlayEl = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayDetail = document.getElementById('overlay-detail');
const restartBtn = document.getElementById('restart');

const term = new Terminal({
  fontFamily: 'Consolas, "Cascadia Mono", monospace',
  fontSize: 14,
  lineHeight: 1.25,
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: '#12110f',
    foreground: '#e8e2d6',
    cursor: '#c8401f',
    cursorAccent: '#12110f',
    selectionBackground: 'rgba(200, 64, 31, 0.35)',
    black: '#1d1b18',
    red: '#d0573a',
    green: '#7f9a63',
    yellow: '#c9a227',
    blue: '#6f8fa8',
    magenta: '#b0788f',
    cyan: '#78a6a0',
    white: '#e8e2d6',
    brightBlack: '#5c554a',
    brightRed: '#e07053',
    brightGreen: '#96b078',
    brightYellow: '#ddb93c',
    brightBlue: '#8aa7bd',
    brightMagenta: '#c78da3',
    brightCyan: '#8fbcb6',
    brightWhite: '#fbf8f1',
  },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(screenEl);
term.onData((data) => window.bridge.input(data));

let raf = 0;
let lastCols = 0;
let lastRows = 0;
let restartTimer = null;

function refit() {
  raf = 0;
  if (!screenEl.clientWidth || !screenEl.clientHeight) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  if (term.cols === lastCols && term.rows === lastRows) return;
  lastCols = term.cols;
  lastRows = term.rows;
  dimsEl.textContent = `${term.cols}×${term.rows}`;
  window.bridge.resize(term.cols, term.rows);
}

function scheduleRefit() {
  if (!raf) raf = requestAnimationFrame(refit);
}

new ResizeObserver(scheduleRefit).observe(screenEl);
requestAnimationFrame(() => requestAnimationFrame(refit));

function showOverlay(title, detail, canRestart) {
  overlayTitle.textContent = title;
  overlayDetail.textContent = detail;
  restartBtn.hidden = !canRestart;
  restartBtn.disabled = false;
  overlayEl.hidden = false;
  if (canRestart) restartBtn.focus();
}

function hideOverlay() {
  overlayEl.hidden = true;
  restartBtn.disabled = false;
  term.focus();
}

function applyStatus(status) {
  if (!status) return;
  if (status === 'error') showOverlay('会话已中断', '进程异常退出，可以重来。', true);
  else if (status === 'interrupted') showOverlay('会话已中断', '已被中断，可以重来。', true);
  else if (status === 'closed' || status === 'closing') showOverlay('会话已结束', '群已解散，窗口即将关闭。', false);
  else hideOverlay();
}

function handleProblem(text) {
  if (overlayEl.hidden) {
    bottomEl.dataset.state = 'closed';
    syncEl.textContent = text;
    return;
  }
  overlayDetail.textContent = text;
  restartBtn.disabled = false;
}

restartBtn.addEventListener('click', () => {
  restartBtn.disabled = true;
  overlayDetail.textContent = '正在重来…';
  window.bridge.restart();
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (overlayEl.hidden) return;
    restartBtn.disabled = false;
    overlayDetail.textContent = '后台没有响应，检查连接后再试。';
  }, 8000);
});

window.bridge.onEffect((effect) => {
  if (!effect) return;
  if (effect.type === 'reset') term.reset();
  else if (effect.type === 'write') term.write(String(effect.data || ''));
  else if (effect.type === 'session') applyStatus(effect.session && effect.session.status);
  else if (effect.type === 'error') handleProblem(String(effect.message || '未知错误'));
  else if (effect.type === 'ended') showOverlay('会话已结束', '群已解散，窗口即将关闭。', false);
  else if (effect.type === 'restarted') {
    clearTimeout(restartTimer);
    if (effect.ok) {
      hideOverlay();
      syncEl.textContent = '正在接回…';
    } else {
      showOverlay('重来失败', '会话不存在或后台没能重启它。', true);
    }
  }
});

window.bridge.onMeta((meta) => {
  if (!meta || meta.type !== 'session-meta') return;
  if (meta.title) {
    titleEl.textContent = meta.title;
    document.title = meta.title;
  }
  if (meta.syncLine) syncEl.textContent = meta.syncLine;
  bottomEl.dataset.state = meta.transport || 'connecting';
  if (meta.status) applyStatus(meta.status);
  if (overlayEl.hidden) term.focus();
});
