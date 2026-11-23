const SEP = /^[\s,，:：、]+/;
const ALIAS_MAX = 6;

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 返回 { cwd, alias, prompt, source }
// source: 'alias' | 'path' | 'path-missing' | 'default'
function parseFirstMessage(text, { aliases = {}, defaultCwd, exists = () => false }) {
  const raw = String(text || '').replace(/\uFEFF/g, '').trim();

  for (let len = Math.min(ALIAS_MAX, raw.length); len >= 1; len -= 1) {
    const cand = raw.slice(0, len);
    if (!has(aliases, cand)) continue;
    const rest = raw.slice(len);
    if (rest !== '' && !SEP.test(rest)) continue; // 别名后必须跟分隔符，避免吃掉 "demo44"
    return { cwd: aliases[cand], alias: cand, prompt: rest.replace(SEP, '').trim(), source: 'alias' };
  }

  const m = raw.match(/^([A-Za-z]:[\\/][^\s]*)([\s\S]*)$/);
  if (m) {
    const cwd = m[1];
    const prompt = m[2].replace(SEP, '').trim();
    if (exists(cwd)) return { cwd, alias: null, prompt, source: 'path' };
    return { cwd: null, alias: null, prompt: raw, source: 'path-missing' };
  }

  return { cwd: defaultCwd, alias: null, prompt: raw, source: 'default' };
}

module.exports = { parseFirstMessage };
