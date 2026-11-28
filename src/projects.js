const fs = require('node:fs');
const { writeJsonAtomic } = require('./store');
const { ALIAS_MAX } = require('./session/router');

// 记事本 / PowerShell 5 另存的 UTF-8 会带 BOM，JSON.parse 直接报 Unexpected token；
// config.js 与 store.js 都剥过，这里漏剥会让整张别名表静默清空
function readJsonText(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// 读 state/projects.json；文件不存在或 JSON 损坏都退回默认值，绝不抛错
function loadProjects({ file, defaultCwd }) {
  let doc = {};
  try {
    doc = JSON.parse(readJsonText(file));
  } catch {
    doc = {};
  }
  const aliases = {};
  const raw = doc && typeof doc === 'object' ? doc.aliases : null;
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      // 用 defineProperty：renameAlias 允许把别名改成 "__proto__"，
      // 普通赋值会走原型 setter，读回来就丢
      if (typeof val === 'string' && val.trim()) {
        Object.defineProperty(aliases, key, {
          value: val, enumerable: true, writable: true, configurable: true,
        });
      }
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
  // 与 router 的扫描上限保持一致：超长的名字改成功也永远命不中，等于白改
  if (name.length > ALIAS_MAX) return { ok: false, message: `新别名最多 ${ALIAS_MAX} 个字符。` };

  let doc;
  try {
    doc = JSON.parse(readJsonText(file));
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
