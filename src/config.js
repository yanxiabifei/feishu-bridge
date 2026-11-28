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
  intakeEnabled: true,
  intakeTimeoutMs: 20000,
  inFlightTimeoutMs: 900000,
  sweepIntervalMs: 30000,
  sweepDegradedIntervalMs: 5000,
  ipcPort: 47831,
};

function loadConfig(file) {
  let raw = {};
  if (fs.existsSync(file)) {
    let text = fs.readFileSync(file, 'utf8');
    // 记事本另存为 UTF-8 会带 BOM，JSON.parse 直接报 Unexpected token
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `配置文件格式错误：${file}（${String((err && err.message) || err)}），`
        + '请修正该文件或删除后重新运行 npm run setup',
      );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`配置文件内容不是 JSON 对象：${file}，请修正或删除后重新运行 npm run setup`);
    }
  }
  return { ...structuredClone(DEFAULTS), ...raw };
}

function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
