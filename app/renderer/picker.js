// 选择器：数据全由主进程推来，这里只负责画出来、收键盘。
const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const chosenEl = document.getElementById('chosen');
const chooseEl = document.getElementById('choose');
const agentsEl = document.getElementById('agents');
const transportBox = document.querySelector('.transport');
const transportEl = document.getElementById('transport');
const retryEl = document.getElementById('retry');

const STATUS_LABEL = {
  running: '运行中',
  starting: '启动中',
  idle: '空闲',
  error: '出错',
  interrupted: '已中断',
  closing: '关闭中',
};
const TRANSPORT_LABEL = {
  synced: '已连接',
  reconnecting: '重连中',
  connecting: '连接中',
  closed: '未连接',
};

let model = { recent: [], resumable: [] };
let chosenCwd = '';
let items = [];
let activeIndex = 0;
let busy = false;

const el = (tag, cls) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

function stamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dirName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function tagEl(text, status) {
  const t = el('span', 'tag');
  t.textContent = text;
  if (status) t.dataset.status = status;
  return t;
}

function sectionEl(title, count) {
  const sec = el('section', 'section');
  const head = el('div', 'section-head');
  const name = el('span');
  name.textContent = title;
  const num = el('span', 'section-count');
  num.textContent = String(count);
  head.append(name, num);
  const rows = el('div', 'rows');
  sec.append(head, rows);
  listEl.append(sec);
  return rows;
}

function emptyLine(text) {
  const node = el('div', 'empty');
  node.textContent = text;
  listEl.append(node);
}

function addRow(parent, { key, name, path, meta, activate }) {
  const btn = el('button', 'row');
  btn.type = 'button';
  btn.setAttribute('role', 'option');
  const nm = el('div', 'row-name');
  nm.textContent = name;
  const p = el('div', 'row-path');
  p.textContent = path || '';
  if (path) p.title = path;
  const m = el('div', 'row-meta');
  for (const node of meta) if (node) m.append(node);
  btn.append(nm, p, m);
  btn.addEventListener('click', activate);
  btn.addEventListener('mouseenter', () => setActive(key));
  parent.append(btn);
  items.push({ key, el: btn, activate });
  return btn;
}

function paintActive() {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    item.el.classList.toggle('active', i === activeIndex);
    item.el.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
  }
  const current = items[activeIndex];
  if (current) current.el.scrollIntoView({ block: 'nearest' });
}

function setActive(key) {
  const index = items.findIndex((item) => item.key === key);
  if (index < 0 || index === activeIndex) return;
  activeIndex = index;
  paintActive();
}

function move(step) {
  if (!items.length) return;
  activeIndex = (activeIndex + step + items.length) % items.length;
  paintActive();
}

function activateActive() {
  if (busy) return;
  const item = items[activeIndex];
  if (item) item.activate();
}

function showBanner(text, { info = false } = {}) {
  bannerEl.textContent = text || '';
  bannerEl.className = info ? 'banner info' : 'banner';
  bannerEl.hidden = !text;
}

function render() {
  const previousKey = items[activeIndex] ? items[activeIndex].key : null;
  items = [];
  listEl.textContent = '';

  const recent = Array.isArray(model.recent) ? model.recent : [];
  const resumable = Array.isArray(model.resumable) ? model.resumable : [];

  if (recent.length) {
    const rows = sectionEl('最近使用', recent.length);
    for (const r of recent) {
      const meta = [];
      const at = stamp(r.at);
      if (at) {
        const time = el('span');
        time.textContent = at;
        meta.push(time);
      }
      if (r.agent) meta.push(tagEl(r.agent));
      addRow(rows, {
        key: `recent:${r.cwd}`,
        name: r.alias || dirName(r.cwd),
        path: r.cwd,
        meta,
        activate: () => createHere(r.cwd, r.agent),
      });
    }
  }

  if (resumable.length) {
    const rows = sectionEl('接回正在跑的会话', resumable.length);
    for (const s of resumable) {
      const meta = [];
      const at = stamp(s.at);
      if (at) {
        const time = el('span');
        time.textContent = at;
        meta.push(time);
      }
      if (s.agent) meta.push(tagEl(s.agent));
      meta.push(tagEl(STATUS_LABEL[s.status] || s.status || '空闲', s.status));
      addRow(rows, {
        key: `session:${s.id}`,
        name: s.alias || dirName(s.cwd) || s.id,
        path: s.cwd,
        meta,
        activate: () => attachSession(s.id),
      });
    }
  }

  if (!recent.length && !resumable.length) {
    emptyLine('还没有记录，选个目录开工。');
  }

  items.push({ key: 'choose', el: chooseEl, activate: chooseDir });
  if (!agentsEl.hidden) {
    for (const name of ['claude', 'codex']) {
      const btn = agentsEl.querySelector(`[data-agent="${name}"]`);
      if (btn) items.push({ key: `agent:${name}`, el: btn, activate: () => createHere(chosenCwd, name) });
    }
  }

  const restored = items.findIndex((item) => item.key === previousKey);
  activeIndex = restored >= 0 ? restored : 0;
  paintActive();
}

function applyTransport(state) {
  transportBox.dataset.state = state || 'connecting';
  transportEl.textContent = TRANSPORT_LABEL[state] || '连接中';
  retryEl.hidden = state !== 'closed';
}

async function chooseDir() {
  if (busy) return;
  const dir = await window.bridge.chooseDir();
  if (!dir) return;
  chosenCwd = dir;
  chosenEl.textContent = dir;
  chosenEl.title = dir;
  agentsEl.hidden = false;
  render();
  setActive('agent:claude');
}

function createHere(cwd, agent) {
  if (busy || !cwd) return;
  const name = agent === 'codex' ? 'codex' : 'claude';
  busy = true;
  document.body.classList.add('busy');
  showBanner(`正在建群并打开会话（${name}）…`, { info: true });
  window.bridge.pickerAction({ action: 'create', cwd, agent: name });
}

function attachSession(sessionId) {
  if (busy || !sessionId) return;
  window.bridge.pickerAction({ action: 'attach', sessionId });
}

function applyPicker(meta) {
  if (meta.picker) model = meta.picker;
  applyTransport(meta.transport);
  busy = false;
  document.body.classList.remove('busy');
  const message = meta.error || meta.hint || '';
  showBanner(message);
  render();
}

chooseEl.addEventListener('click', chooseDir);
for (const btn of agentsEl.querySelectorAll('.agent')) {
  btn.addEventListener('click', () => createHere(chosenCwd, btn.dataset.agent));
  btn.addEventListener('mouseenter', () => setActive(`agent:${btn.dataset.agent}`));
}
retryEl.addEventListener('click', () => {
  showBanner('正在重连后台…', { info: true });
  window.bridge.reconnect();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.close();
    return;
  }
  if (event.target && event.target.id === 'retry') return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    activateActive();
  }
});

window.bridge.onMeta((meta) => {
  if (!meta) return;
  if (meta.type === 'picker') applyPicker(meta);
  else if (meta.type === 'error') showBanner(meta.message);
});

window.bridge.onEffect((effect) => {
  if (!effect) return;
  if (effect.type === 'error') showBanner(effect.message);
});

applyTransport('connecting');
render();
