const pad = (n) => String(n).padStart(2, '0');

// 会话记录里的时间是 ISO 字符串（daemon 的 newRecord 写的是 toISOString()），
// 不是毫秒数；只认 number 的话，真实数据的时间戳全部被当成「没有」。
function toMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) && ts > 0 ? ts : 0;
  if (typeof ts === 'string' && ts) {
    const n = Date.parse(ts);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

function mmddhhmm(ts) {
  const ms = toMs(ts);
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 窗口标题：<别名> · MM-DD HH:mm（别名优先，其次目录名）
// 时间戳只取会话自己的创建时间：没有就不写，绝不拿「现在」冒充。
function formatTitle(session) {
  if (!session) return '飞书桥';
  const name = session.alias || String(session.cwd || '').split(/[\\/]/).filter(Boolean).pop() || session.id;
  const stamp = mmddhhmm(session.createdAt);
  return stamp ? `${name} · ${stamp}` : name;
}

// 底部状态栏：「已同步 · 卡牌 · 11-23 21:40」
function formatSyncLine({ session, at = Date.now(), state = 'synced' } = {}) {
  const head = state === 'synced' ? '已同步'
    : state === 'reconnecting' ? '重连中'
      : state === 'closed' ? '已断开' : '连接中';
  const parts = [head];
  if (session) parts.push(session.alias || String(session.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '会话');
  const stamp = mmddhhmm(at);
  if (stamp) parts.push(stamp);
  return parts.join(' · ');
}

module.exports = { formatTitle, formatSyncLine, mmddhhmm, toMs };
