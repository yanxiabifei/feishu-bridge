const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');

module.exports = {
  ROOT,
  STATE,
  LOGS: path.join(ROOT, 'logs'),
  CONFIG: path.join(STATE, 'config.json'),
  SECRET: path.join(STATE, 'secret.bin'),
  PROJECTS: path.join(STATE, 'projects.json'),
  SESSIONS: path.join(STATE, 'sessions.json'),
  IPC: path.join(STATE, 'ipc.json'),
  HOOKS: path.join(STATE, 'hooks'),
  MEDIA: path.join(STATE, 'media'),
  HOOK_SCRIPT: path.join(ROOT, 'bin', 'hook-stop.js'),
  CLAUDE_JSON: path.join(os.homedir(), '.claude.json'),
  ensureDirs() {
    for (const d of [this.STATE, this.LOGS, this.HOOKS, this.MEDIA]) {
      fs.mkdirSync(d, { recursive: true });
    }
  },
};
