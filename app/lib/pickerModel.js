// 项目选择器的数据：最近使用的目录（会话表 + 别名的并集），默认目录，其余靠用户手选。
const RECENT_LIMIT = 5;

const dirName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

function buildPicker({ projects = {}, sessions = [], limit = RECENT_LIMIT } = {}) {
  const aliases = (projects && projects.aliases) || {};
  const byCwd = new Map();

  for (const s of sessions) {
    if (!s || !s.cwd) continue;
    const prev = byCwd.get(s.cwd);
    const at = Number(s.lastActiveAt || s.createdAt || 0);
    if (!prev || at > prev.at) {
      byCwd.set(s.cwd, { at, agent: s.agent || null, alias: s.alias || null });
    }
  }

  const recent = [...byCwd.entries()]
    .map(([cwd, v]) => ({
      cwd,
      alias: aliases[cwd] || v.alias || dirName(cwd),
      agent: v.agent,
      at: v.at,
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  return {
    recent,
    aliases,
    defaultCwd: (projects && projects.default) || null,
    agents: ['claude', 'codex'],
  };
}

module.exports = { buildPicker, RECENT_LIMIT };
