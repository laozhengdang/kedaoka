// main.mjs —— 桌面版入口（Electron）
// 不开本地端口、不经过浏览器：直接用 IPC 调 api.mjs，前端加载本地文件。

import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

// 数据目录：便携版放在 exe 旁边；开发时用仓库里的 data/
if (!process.env.MIAOMIAO_DATA) {
  process.env.MIAOMIAO_DATA = app.isPackaged
    ? join(dirname(app.getPath('exe')), 'data')
    : join(HERE, '..', '..', 'data');
}

// 冒烟测试：electron . --smoke 时只跑一遍 API 然后退出（不需要显示器）
const SMOKE = process.argv.includes('--smoke');

let win = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#fbfbf9',
    title: '老郑荡的妙妙小工具',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  await win.loadFile(join(PUBLIC, 'index.html'));
  if (process.env.DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

// 前端所有数据请求都走这里
ipcMain.handle('api', async (_e, { method, path, body }) => {
  const { callApi, startImport, getJob } = await import('../api.mjs');
  if (path === '/api/import' && method === 'POST') return { job: startImport(body.file, body.courseName) };
  if (path.startsWith('/api/job/')) return getJob(path.slice('/api/job/'.length));
  return callApi(method, path, body || {});
});

// 外部链接用系统浏览器打开，不在应用里导航
ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  if (SMOKE) {
    const { callApi } = await import('../api.mjs');
    const b = callApi('GET', '/api/bootstrap');
    console.log('[smoke] courses:', b.courses.map((c) => `${c.name}(${c.cards}卡)`).join(', '));
    console.log('[smoke] node', process.versions.node, 'electron', process.versions.electron);
    app.quit();
    return;
  }

  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
