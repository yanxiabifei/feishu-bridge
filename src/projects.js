const fs = require('node:fs');

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

module.exports = { loadProjects };
