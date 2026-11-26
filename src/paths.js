const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const LOGS = path.join(ROOT, 'logs');
const HOOKS = path.join(STATE, 'hooks');
const MEDIA = path.join(STATE, 'media');

module.exports = {
  ROOT, STATE, LOGS, HOOKS, MEDIA,
  CONFIG: path.join(STATE, 'config.json'),
  SECRET: path.join(STATE, 'secret.bin'),
  PROJECTS: path.join(STATE, 'projects.json'),
  SESSIONS: path.join(STATE, 'sessions.json'),
  IPC: path.join(STATE, 'ipc.json'),
  HOOK_SCRIPT: path.join(ROOT, 'bin', 'hook-stop.js'),
  CLAUDE_JSON: path.join(os.homedir(), '.claude.json'),
  ensureDirs() {
    for (const d of [STATE, LOGS, HOOKS, MEDIA]) fs.mkdirSync(d, { recursive: true });
  },
};
