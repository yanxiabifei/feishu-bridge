// 项目选择器的数据：最近使用的目录（会话表 + 别名的并集），默认目录，其余靠用户手选。
const { toMs } = require('./format');

const RECENT_LIMIT = 5;

const dirName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

function buildPicker({ projects = {}, sessions = [], limit = RECENT_LIMIT } = {}) {
  const aliases = (projects && projects.aliases) || {};
  // projects.json 里 aliases 的方向是「别名 → 目录」（和 router 扫描一致），
  // 这里要按目录反查别名，直接拿 cwd 当下标永远查不中
  const aliasByCwd = new Map();
  for (const [name, cwd] of Object.entries(aliases)) {
    if (typeof cwd === 'string' && !aliasByCwd.has(cwd)) aliasByCwd.set(cwd, name);
  }
  const byCwd = new Map();

  for (const s of sessions) {
    if (!s || !s.cwd) continue;
    const prev = byCwd.get(s.cwd);
    // 记录里的时间是 ISO 字符串，Number() 会得到 NaN，排序就全乱了
    const at = toMs(s.lastActiveAt || s.createdAt || 0);
    if (!prev || at > prev.at) {
      byCwd.set(s.cwd, { at, agent: s.agent || null, alias: s.alias || null });
    }
  }

  const recent = [...byCwd.entries()]
    .map(([cwd, v]) => ({
      cwd,
      alias: aliasByCwd.get(cwd) || v.alias || dirName(cwd),
      agent: v.agent,
      at: v.at,
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  // 「接回正在跑的会话」：已结束的不再出现，其余按最后活动倒序
  const resumable = sessions
    .filter((s) => s && s.id && s.status !== 'closed' && s.status !== 'closing')
    .map((s) => ({
      id: s.id,
      alias: aliasByCwd.get(s.cwd) || s.alias || dirName(s.cwd),
      cwd: s.cwd || '',
      agent: s.agent || null,
      status: s.status || 'idle',
      at: toMs(s.lastActiveAt || s.createdAt || 0),
    }))
    .sort((a, b) => b.at - a.at);

  return {
    recent,
    resumable,
    aliases,
    defaultCwd: (projects && projects.default) || null,
    agents: ['claude', 'codex'],
  };
}

module.exports = { buildPicker, RECENT_LIMIT };
