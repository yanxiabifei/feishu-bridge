const SEP = /^[\s,，:：、]+/;
const ALIAS_MAX = 6;

// 「用 codex」「走 codex」「codex：」这类明确指名才算，正文里顺口提到不算
const AGENT_LEAD = /^\s*codex\s*(?:模式)?\s*[:：]?\s*/i;
const AGENT_VERB = /(?:用|使用|走)\s*codex\s*(?:模式)?\s*[:：]?\s*/i;

function splitAgent(prompt) {
  const text = String(prompt || '');
  if (AGENT_LEAD.test(text)) {
    return { agent: 'codex', prompt: text.replace(AGENT_LEAD, '').trim() };
  }
  if (AGENT_VERB.test(text)) {
    return { agent: 'codex', prompt: text.replace(AGENT_VERB, '').replace(/\s+/g, ' ').trim() };
  }
  return { agent: null, prompt: text };
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 返回 { cwd, alias, prompt, source, agent }
// source: 'alias' | 'path' | 'path-missing' | 'default'
function parseFirstMessage(text, { aliases = {}, defaultCwd, exists = () => false }) {
  const raw = String(text || '').replace(/\uFEFF/g, '').trim();

  const withAgent = (r) => ({ ...r, ...splitAgent(r.prompt) });   // splitAgent 的 prompt 覆盖原值

  for (let len = Math.min(ALIAS_MAX, raw.length); len >= 1; len -= 1) {
    const cand = raw.slice(0, len);
    if (!has(aliases, cand)) continue;
    const rest = raw.slice(len);
    if (rest !== '' && !SEP.test(rest)) continue; // 别名后必须跟分隔符，避免吃掉 "demo44"
    return withAgent({ cwd: aliases[cand], alias: cand, prompt: rest.replace(SEP, '').trim(), source: 'alias' });
  }

  const m = raw.match(/^([A-Za-z]:[\\/][^\s]*)([\s\S]*)$/);
  if (m) {
    const cwd = m[1];
    const prompt = m[2].replace(SEP, '').trim();
    if (exists(cwd)) return withAgent({ cwd, alias: null, prompt, source: 'path' });
    return withAgent({ cwd: null, alias: null, prompt: raw, source: 'path-missing' });
  }

  return withAgent({ cwd: defaultCwd, alias: null, prompt: raw, source: 'default' });
}

module.exports = { parseFirstMessage };
