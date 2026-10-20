// preload.cjs —— 只把需要的方法交给前端，不暴露 Node
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeApi', {
  invoke: (method, path, body) => ipcRenderer.invoke('api', { method, path, body }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  dataDir: () => ipcRenderer.invoke('data-dir'),
  // 原生文件选择器：返回绝对路径，彻底避开"拖进来只有文件名"的问题
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  // 拖进来的文件：把字节交给主进程落到 data/incoming，再返回真实路径
  dropFile: (name, buffer) => ipcRenderer.invoke('drop-file', { name, buffer }),
  // 专注计时用：真正的窗口全屏
  setFullscreen: (on) => ipcRenderer.invoke('set-fullscreen', on),
  // 自定义主题：选背景图并复制进数据目录
  pickImage: () => ipcRenderer.invoke('pick-image'),
  importBackground: (p) => ipcRenderer.invoke('import-background', p),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  isDesktop: true,
});
