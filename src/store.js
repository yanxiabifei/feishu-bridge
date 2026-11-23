const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function createStore({ file, log }) {
  let data = { sessions: [] };

  const save = () => writeJsonAtomic(file, data);

  return {
    load() {
      if (!fs.existsSync(file)) {
        data = { sessions: [] };
        return this;
      }
      const raw = fs.readFileSync(file, 'utf8');
      try {
        data = JSON.parse(raw);
      } catch {
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, backup);
        if (log) log.warn('store.corrupt', { file, backup });
        data = { sessions: [] };
      }
      if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) data = { sessions: [] };
      return this;
    },
    all() {
      return data.sessions.slice();
    },
    get(id) {
      return data.sessions.find((s) => s.id === id) || null;
    },
    getByChat(chatId) {
      return data.sessions.find((s) => s.chatId === chatId) || null;
    },
    upsert(session) {
      const i = data.sessions.findIndex((s) => s.id === session.id);
      if (i >= 0) data.sessions[i] = session;
      else data.sessions.push(session);
      save();
      return session;
    },
    remove(id) {
      data.sessions = data.sessions.filter((s) => s.id !== id);
      save();
    },
    save,
  };
}

module.exports = { createStore, writeJsonAtomic };
