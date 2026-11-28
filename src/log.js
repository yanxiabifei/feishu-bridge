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
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactor.scrub(String(value.message)),
      stack: redactor.scrub(String(value.stack || '')),
    };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
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
    try {
      const ts = now().toISOString();
      const rec = { ts, level, event, ...redact(fields || {}, redactor) };
      fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
    } catch {
      // 磁盘满 / 无权限 / 同路径是目录：日志写不进去绝不能把 daemon 一起带走
    }
    if (level !== 'info') {
      try {
        process.stderr.write(`[${level}] ${event}\n`);
      } catch {
        /* stderr 也断了就算了 */
      }
    }
  };
  return {
    redactor,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

module.exports = { createLogger, createRedactor, redact };
