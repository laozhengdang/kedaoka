// preload.cjs —— 只把两个方法交给前端，不暴露 Node
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeApi', {
  invoke: (method, path, body) => ipcRenderer.invoke('api', { method, path, body }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  dataDir: () => ipcRenderer.invoke('data-dir'),
  isDesktop: true,
});
