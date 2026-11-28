const pad = (n) => String(n).padStart(2, '0');

function mmddhhmm(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
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

module.exports = { formatTitle, formatSyncLine, mmddhhmm };
