const fs = require('node:fs');
const { writeJsonAtomic } = require('./store');

// 读 state/projects.json；文件不存在或 JSON 损坏都退回默认值，绝不抛错
function loadProjects({ file, defaultCwd }) {
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    doc = {};
  }
  const aliases = {};
  const raw = doc && typeof doc === 'object' ? doc.aliases : null;
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      if (typeof val === 'string' && val.trim()) aliases[key] = val;
    }
  }
  const def = doc && typeof doc.default === 'string' && doc.default.trim()
    ? doc.default
    : defaultCwd;
  return { aliases, default: def };
}

// 只改 aliases 一项：读原始 JSON 再写回，default / recent / 未来新增字段原样保留
function renameAlias({ file, from, to }) {
  const name = String(to || '').trim();
  if (!name) return { ok: false, message: '新别名不能为空。' };
  if (/\s/.test(name)) return { ok: false, message: '新别名不能带空格。' };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, message: '读不到 projects.json，先在电脑上跑一次 npm run setup。' };
  }
  if (!doc || typeof doc !== 'object' || !doc.aliases || typeof doc.aliases !== 'object') {
    return { ok: false, message: 'projects.json 里没有别名表。' };
  }
  if (typeof doc.aliases[from] !== 'string') {
    return { ok: false, message: `别名「${from}」不存在。` };
  }
  if (from === name) return { ok: false, message: '新旧别名一样，不用改。' };
  if (Object.prototype.hasOwnProperty.call(doc.aliases, name)) {
    return { ok: false, message: `别名「${name}」已经被占用了。` };
  }

  const aliases = {};
  for (const [k, v] of Object.entries(doc.aliases)) {
    // 用 defineProperty 而不是 aliases[key] = v：新名若是 "__proto__"，
    // 普通赋值会走原型 setter，静默丢数据
    Object.defineProperty(aliases, k === from ? name : k, {
      value: v, enumerable: true, writable: true, configurable: true,
    });
  }
  doc.aliases = aliases;
  writeJsonAtomic(file, doc);
  return { ok: true, aliases };
}

module.exports = { loadProjects, renameAlias };
