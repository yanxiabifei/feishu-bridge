// daemon 的错误回包只说明「哪条请求失败了」，不带窗口身份。
// 先按 sessionId 认领到具体窗口，再退回按请求类型认；都认不出就返回 null，交给调用方广播。
function pickErrorTarget(candidates, msg) {
  const list = Array.isArray(candidates) ? candidates : [];
  const sessionId = msg && msg.sessionId;
  const replyTo = msg && msg.replyTo;
  if (sessionId) {
    const exact = list.find((e) => e.sessionId === sessionId && (!replyTo || e.awaiting === replyTo));
    if (exact) return exact;
    const sameSession = list.find((e) => e.sessionId === sessionId);
    if (sameSession) return sameSession;
  }
  if (replyTo) {
    const byType = list.find((e) => e.awaiting === replyTo);
    if (byType) return byType;
  }
  return null;
}

module.exports = { pickErrorTarget };
