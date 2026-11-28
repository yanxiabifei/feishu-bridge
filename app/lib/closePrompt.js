// 关闭窗口时的三选一。按钮顺序按 Windows 习惯「肯定项在右」，
// 默认项跟会话忙不忙走：正忙时手滑点确定的代价太大，默认取消。
const BUSY = new Set(['starting', 'running']);

function closeChoices(status) {
  const close = { id: 'close', label: '结束会话' };
  const detach = { id: 'detach', label: '只关窗口' };
  const cancel = { id: 'cancel', label: '取消' };
  if (BUSY.has(status)) {
    return {
      buttons: [cancel, detach, close],
      defaultId: 'cancel',
      cancelId: 'cancel',
      busy: true,
    };
  }
  return {
    buttons: [close, detach, cancel],
    defaultId: 'close',
    cancelId: 'cancel',
    busy: false,
  };
}

module.exports = { closeChoices };
