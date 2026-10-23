// preload.cjs —— 只把需要的方法交给前端，不暴露 Node
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nativeApi', {
  invoke: (method, path, body) => ipcRenderer.invoke('api', { method, path, body }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  dataDir: () => ipcRenderer.invoke('data-dir'),
  // 原生文件选择器：返回绝对路径，彻底避开"拖进来只有文件名"的问题
  pickFiles: () => ipcRenderer.invoke('pick-files'),

  // 拖进来的文件：优先直接拿真实路径（不复制、不受大小限制）
  getDroppedPath: (file) => {
    try {
      if (!webUtils || typeof webUtils.getPathForFile !== 'function') return '';
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  // 拿不到路径时的兜底：分块写入，避免一次性传几百 MB 把 IPC 撑爆
  dropBegin: (name, size) => ipcRenderer.invoke('drop-begin', { name, size }),
  dropChunk: (id, offset, buffer) => ipcRenderer.invoke('drop-chunk', { id, offset, buffer }),
  dropEnd: (id) => ipcRenderer.invoke('drop-end', id),
  // 旧接口保留（网页版/老调用方不炸）
  dropFile: (name, buffer) => ipcRenderer.invoke('drop-file', { name, buffer }),

  // 专注计时用：真正的窗口全屏
  setFullscreen: (on) => ipcRenderer.invoke('set-fullscreen', on),
  // 自定义主题：选背景图并复制进数据目录
  pickImage: () => ipcRenderer.invoke('pick-image'),
  importBackground: (p) => ipcRenderer.invoke('import-background', p),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  saveText: (filename, text) => ipcRenderer.invoke('save-text', { filename, text }),
  backupDb: () => ipcRenderer.invoke('backup-db'),
  // 检查更新 / 下载 / 安装
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: (payload) => ipcRenderer.invoke('download-update', payload),
  installUpdate: (payload) => ipcRenderer.invoke('install-update', payload),
  onUpdateProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update-progress', h);
    return () => ipcRenderer.removeListener('update-progress', h);
  },
  isDesktop: true,
});
