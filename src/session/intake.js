const { execFile } = require('node:child_process');
const { parseFirstMessage } = require('./router');
const { childEnv } = require('./ptySession');

const NAME_MAX = 20;

const SCHEMA = {
  type: 'object',
  properties: {
    cwd: { type: 'string' },
    groupName: { type: 'string' },
    prompt: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['cwd', 'groupName', 'prompt'],
  additionalProperties: false,
};

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').toLowerCase();
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const s = Array.from(name.replace(/[\r\n]+/g, ' ').trim());
  if (!s.length) return null;
  return s.slice(0, NAME_MAX).join('').trim() || null;
}

function aliasOf(cwd, aliases) {
  const key = normPath(cwd);
  for (const [alias, p] of Object.entries(aliases)) {
    if (normPath(p) === key) return alias;
  }
  return null;
}

// 一次性的「前台接待」：只看这句话，给出目录/群名/第一句指令，不做任何实际操作
function buildPrompt({ text, aliases, defaultCwd, forcedCwd }) {
  const lines = [
    '你是一次性的前台接待，只做判断，不执行任何实际操作（你也没有工具）。',
    '根据用户第一句话，决定：在哪个目录开工会话、飞书群叫什么名字、交给执行会话的第一句指令怎么写。',
    '',
    `用户第一句话：${text}`,
    '',
    '候选目录（别名=路径）：',
    ...Object.entries(aliases).map(([a, p]) => `  ${a}=${p}`),
    `默认目录：${defaultCwd}`,
  ];
  if (forcedCwd) {
    lines.push('', `目录已由规则确定为 ${forcedCwd}，不得更改。`);
  }
  lines.push(
    '',
    '要求：cwd 必须是上面出现过的目录；groupName 不超过 20 个字，一眼能看出在做什么；',
    'prompt 保留用户原意、可以补足必要的上下文，但不要凭空加需求；note 用一句话说明你的判断。',
  );
  return lines.join('\n');
}

function compose({ rawText, cwd, prompt, note }) {
  const tail = note ? `。${note}` : '';
  return `（前台接待备忘：用户原话「${rawText}」；工作目录 ${cwd}${tail}）\n\n${prompt}`;
}

function parseCliOutput(stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('\n{');
  const line = start >= 0 ? text.slice(start + 1) : text;
  let doc;
  try {
    doc = JSON.parse(line);
  } catch {
    return null;
  }
  if (doc && typeof doc === 'object' && doc.structured_output && typeof doc.structured_output === 'object') {
    return doc.structured_output;
  }
  if (doc && typeof doc.result === 'string') {
    try {
      const parsed = JSON.parse(doc.result.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// 真跑一次无头 claude：一次对话、不落盘、进程退出即消失
function runIntakeCli({ prompt, timeoutMs = 20000, cwd, exe = 'claude', env = process.env }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(SCHEMA),
      '--tools', '',
      '--exclude-dynamic-system-prompt-sections',
      '--no-session-persistence',
      '--max-turns', '2',
    ];
    execFile(exe, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      cwd: cwd || process.cwd(),
      env: childEnv(env),
    }, (err, stdout) => {
      if (err) return reject(err);
      const out = parseCliOutput(stdout);
      if (!out) return reject(new Error('接待输出无法解析'));
      resolve(out);
    });
  });
}

function applyDecision(base, out, { aliases, exists }) {
  if (!out || typeof out !== 'object' || Array.isArray(out)) return base;
  // 归一后的路径映射回配置里的写法：模型可能把 D:/other 写成 d:\Other，
  // 直接存原样的话，后面按字符串比对 cwd 的地方（exists、项目表、卡片）就对不上。
  const allowed = new Map(Object.values(aliases).map((p) => [normPath(p), p]));

  const res = { ...base, decidedBy: 'intake' };
  if (!base.forcedCwd) {
    const canon = allowed.get(normPath(out.cwd));
    if (canon && exists(canon)) {
      res.cwd = canon;
      res.alias = aliasOf(canon, aliases);
    }
  }
  res.groupName = cleanName(out.groupName);
  res.note = typeof out.note === 'string' && out.note.trim() ? out.note.trim() : null;
  const own = typeof out.prompt === 'string' ? out.prompt.trim() : '';
  // 接待自己写了指令才带上备忘块（原话 + 目录 + 判断），否则沿用规则指令
  if (own) res.prompt = compose({ rawText: base.rawPrompt, cwd: res.cwd, prompt: own, note: res.note });
  return res;
}

const NOOP_RUNNER = null;

async function decide({
  text,
  projects = {},
  defaultCwd,
  exists = () => false,
  enabled = true,
  timeoutMs = 20000,
  runIntake = NOOP_RUNNER,
}) {
  const aliases = projects.aliases || {};
  const fallbackCwd = projects.default || defaultCwd;
  const parsed = parseFirstMessage(text, { aliases, defaultCwd: fallbackCwd, exists });

  const base = {
    cwd: parsed.cwd,
    alias: parsed.alias,
    prompt: parsed.prompt,
    groupName: null,
    note: null,
    source: parsed.source,
    rawPrompt: String(text || '').trim(),
    agent: parsed.agent,
    decidedBy: 'rule',
    forcedCwd: parsed.source === 'alias' || parsed.source === 'path' ? parsed.cwd : null,
  };

  // 空文本（群里只发了一张图）没有可判断的内容，跑接待只是白等一次模型调用
  const blank = !String(text == null ? '' : text).trim();
  if (blank || parsed.source === 'path-missing' || !enabled || typeof runIntake !== 'function') return base;

  let out = null;
  try {
    out = await runIntake({
      prompt: buildPrompt({ text: base.rawPrompt, aliases, defaultCwd: fallbackCwd, forcedCwd: base.forcedCwd }),
      timeoutMs,
    });
  } catch {
    return base;
  }

  return applyDecision(base, out, { aliases, exists });
}

module.exports = { decide, runIntakeCli, parseCliOutput, buildPrompt };
