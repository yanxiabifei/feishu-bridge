// 把 daemon 推来的消息归约成窗口要的状态与「副作用」列表。
// 纯逻辑，不碰 DOM/xterm：清屏、写终端、改标题都由调用方按返回的 effects 执行。
function createSessionFeed({ now = () => Date.now() } = {}) {
  let sessions = [];
  let selectedId = null;
  let selected = null;
  let replayDone = false;
  let lastOutputAt = 0;

  function isSelected(id) {
    return selectedId !== null && id === selectedId;
  }

  return {
    // 选中一个会话：调用方随后把返回的消息发出去
    select(id) {
      selectedId = id;
      // 先拿列表里的那条顶上，否则切换会话后 selected 还挂着上一个会话，
      // 标题/详情会一直显示旧会话直到 daemon 推来新的 session 消息
      selected = sessions.find((s) => s.id === id) || null;
      replayDone = false;
      lastOutputAt = 0;
      return { type: 'attach', sessionId: id };
    },
    // 返回副作用数组：{ type: 'reset' } | { type: 'write', data } | { type: 'title' } | { type: 'error', message }
    handle(msg) {
      const t = msg && msg.type;
      if (t === 'sessions') {
        sessions = Array.isArray(msg.list) ? msg.list : [];
        return [];
      }
      if (t === 'session') {
        const s = msg.session;
        if (!s || !s.id) return [];
        sessions = sessions.filter((x) => x.id !== s.id).concat([s]);
        if (isSelected(s.id)) {
          selected = s;
          return [{ type: 'session', session: s }];
        }
        return [];
      }
      if (t === 'replay') {
        // 只有当前选中的会话的快照有效；先清屏再整屏写入
        if (!isSelected(msg.sessionId)) return [];
        replayDone = true;
        return [
          { type: 'reset' },
          { type: 'write', data: String(msg.data || '') },
        ];
      }
      if (t === 'data') {
        if (!isSelected(msg.sessionId)) return [];
        // replay 到达前的实时输出会被快照覆盖，写进去就是重复内容
        if (!replayDone) return [];
        lastOutputAt = now();
        return [{ type: 'write', data: String(msg.data || '') }];
      }
      if (t === 'error') {
        return [{ type: 'error', message: String(msg.message || '未知错误') }];
      }
      return [];
    },
    getState() {
      return {
        sessions: sessions.slice(),
        selectedId,
        selected,
        replayDone,
        lastOutputAt,
      };
    },
  };
}

module.exports = { createSessionFeed };
