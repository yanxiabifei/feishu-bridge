const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  appId: '',
  ownerOpenId: '',
  ownerChatId: '',
  defaultAgent: 'claude',
  autoDisband: false,
  claudeExe: 'claude',
  claudeArgs: ['--permission-mode', 'bypassPermissions'],
  codexEntry: path.join(
    os.homedir(),
    'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js',
  ),
  codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  defaultCwd: path.join(os.homedir(), 'feishu-workspace'),
  queueLimit: 20,
  inFlightTimeoutMs: 900000,
  sweepIntervalMs: 30000,
  ipcPort: 47831,
};

function loadConfig(file) {
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...structuredClone(DEFAULTS), ...raw };
}

function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
