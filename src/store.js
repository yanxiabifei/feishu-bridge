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
      let raw = fs.readFileSync(file, 'utf8');
      // 记事本另存为 UTF-8 会带 BOM，不剥掉会当成损坏文件把会话全清空
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      try {
        data = JSON.parse(raw);
      } catch {
        const backup = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, backup);
          if (log) log.warn('store.corrupt', { file, backup });
        } catch (err) {
          // 挪不走（被占用/只读）就当没有：已经读到内存里了，照常重建空表
          if (log) log.warn('store.corrupt_rename_failed', { file, error: String((err && err.message) || err) });
        }
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
