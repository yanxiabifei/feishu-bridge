const fs = require('node:fs');
const path = require('node:path');

function trustKey(cwd) {
  return cwd.replace(/\\/g, '/');
}

// 返回 true 表示本次写入了信任标记（供日志用）
function ensureTrusted({ claudeJsonPath, cwd }) {
  let doc = {};
  if (fs.existsSync(claudeJsonPath)) {
    doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  }
  doc.projects = doc.projects || {};
  const key = trustKey(cwd);
  const cur = doc.projects[key] || {};
  if (cur.hasTrustDialogAccepted === true) return false;
  doc.projects[key] = { ...cur, hasTrustDialogAccepted: true };
  const tmp = `${claudeJsonPath}.fb-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, claudeJsonPath);
  return true;
}

function writeHookFile({ hooksDir, sessionId, hookScript }) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, `${sessionId}.hook.json`);
  const command = `"${process.execPath}" "${hookScript}" --session ${sessionId}`;
  const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

function prepareClaude({ session, config, hooksDir, hookScript, claudeJsonPath }) {
  ensureTrusted({ claudeJsonPath, cwd: session.cwd });
  const hookFile = writeHookFile({ hooksDir, sessionId: session.id, hookScript });
  const args = ['--settings', hookFile, ...config.claudeArgs];
  if (session.claudeSessionId) args.push('--resume', session.claudeSessionId);
  return { file: config.claudeExe, args, cwd: session.cwd };
}

function buildLaunch(opts) {
  if (opts.session.agent === 'codex') {
    return {
      file: process.execPath,
      args: [opts.config.codexEntry, ...opts.config.codexArgs],
      cwd: opts.session.cwd,
    };
  }
  return prepareClaude(opts);
}

module.exports = { trustKey, ensureTrusted, writeHookFile, prepareClaude, buildLaunch };
