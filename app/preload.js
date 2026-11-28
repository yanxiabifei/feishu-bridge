// 渲染进程只拿到这一层窄接口：所有会话 id / 权限判断都在主进程做，
// 页面里写不了任意 IPC 通道，也拿不到 Node。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  input: (data) => ipcRenderer.send('bridge:input', data),
  resize: (cols, rows) => ipcRenderer.send('bridge:resize', { cols, rows }),
  restart: () => ipcRenderer.send('bridge:restart'),
  detach: () => ipcRenderer.send('bridge:detach'),
  closeSession: () => ipcRenderer.send('bridge:close-session'),
  pickerAction: (item) => ipcRenderer.send('bridge:picker', item),
  chooseDir: () => ipcRenderer.invoke('bridge:choose-dir'),
  reconnect: () => ipcRenderer.send('bridge:reconnect'),
  onEffect: (cb) => { ipcRenderer.on('bridge:effect', (_e, eff) => cb(eff)); },
  onMeta: (cb) => { ipcRenderer.on('bridge:meta', (_e, meta) => cb(meta)); },
});
