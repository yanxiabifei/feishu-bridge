const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEY = /secret|token|passwd|password|pushplus|authorization|api[_-]?key/i;

function createRedactor() {
  const literals = new Set();
  return {
    add(v) {
      if (typeof v === 'string' && v.length >= 6) literals.add(v);
    },
    scrub(s) {
      let out = String(s);
      for (const lit of literals) out = out.split(lit).join('***');
      return out;
    },
  };
}

function redact(value, redactor = createRedactor(), depth = 0) {
  if (depth > 8) return '[deep]';
  if (typeof value === 'string') return redactor.scrub(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, redactor, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '***' : redact(v, redactor, depth + 1);
    }
    return out;
  }
  return value;
}

function createLogger({ dir, redactor = createRedactor(), now = () => new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (level, event, fields) => {
    const ts = now().toISOString();
    const rec = { ts, level, event, ...redact(fields || {}, redactor) };
    fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
    if (level !== 'info') process.stderr.write(`[${level}] ${event}\n`);
  };
  return {
    redactor,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

module.exports = { createLogger, createRedactor, redact };
