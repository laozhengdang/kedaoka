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
// UI 测试：真的点进复习屏，读 DOM，确认卡片渲染出来了
const UITEST = process.argv.includes('--uitest');

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

// 把库里的相对图片路径变成能直接放进 <img src> 的 file:// 地址
ipcMain.handle('data-dir', async () => process.env.MIAOMIAO_DATA || '.');

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

  if (UITEST) {
    win = new BrowserWindow({
      width: 1200, height: 820, show: false,
      webPreferences: {
        preload: join(HERE, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    await win.loadFile(join(PUBLIC, 'index.html'));
    const log = [];
    try {
      const sidebar = await win.webContents.executeJavaScript(
        'document.querySelectorAll(".course").length');
      log.push(`课程条数: ${sidebar}`);
      const r1 = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('.course').click();
        await new Promise(r => setTimeout(r, 700));
        return (document.body.innerText || '').slice(0, 160);
      })()`);
      log.push('课程页文本: ' + r1.replace(/\\n/g, ' | '));
      const r2 = await win.webContents.executeJavaScript(`(async () => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => /开始今天的|继续|看结算/.test(b.textContent));
        if (!btn) return 'NO_BUTTON';
        btn.click();
        await new Promise(r => setTimeout(r, 900));
        return document.querySelector('#revInner')?.innerText?.slice(0, 140) || 'EMPTY_REVIEW';
      })()`);
      log.push('复习屏: ' + (r2 || '').replace(/\\n/g, ' | '));
      // 点第 1 档，看是否换到下一张
      const r3 = await win.webContents.executeJavaScript(`(async () => {
        const before = document.querySelector('.term')?.innerText || '';
        const btn = document.querySelector('.choice[data-r="1"]');
        if (!btn) return 'NO_CHOICE_BTN';
        btn.click();
        await new Promise(r => setTimeout(r, 1200));
        const after = document.querySelector('.term')?.innerText || 'NO_TERM';
        return JSON.stringify({ before, after, same: before === after });
      })()`);
      log.push('点①后: ' + r3);
      // 直接测一次 IPC，把真实错误暴露出来
      const r4 = await win.webContents.executeJavaScript(`(async () => {
        try {
          const d = await window.nativeApi.invoke('GET', '/api/course/' + location.hash.split('/').pop());
          const card = d.queue.cards.find(c => !c.done);
          const out = await window.nativeApi.invoke('POST', '/api/review', { cardId: card.card_id, rating: 1, latencyMs: 1, auto: 0 });
          return 'IPC_OK ' + JSON.stringify(out).slice(0, 120);
        } catch (e) { return 'IPC_ERR ' + (e && (e.message || e)); }
      })()`);
      log.push('IPC 直连: ' + r4);
      // 键盘流：3 -> 重点题 -> 1 -> 答案
      const r5 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const term0 = document.querySelector('.term')?.innerText || '';
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
        await wait(400);
        const imp = document.body.innerText.includes('这是重点吗');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
        await wait(600);
        const answer = document.querySelector('.answer')?.innerText?.slice(0, 40) || 'NO_ANSWER';
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
        await wait(500);
        const term1 = document.querySelector('.term')?.innerText || '';
        return JSON.stringify({ term0, importanceShown: imp, answer, advanced: term0 !== term1 });
      })()`);
      log.push('键盘 3→1→空格: ' + r5);
      // 仓库页
      const r6 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelector('#btnQuit')?.click();
        await wait(300);
        const id = location.hash.split('/').pop();
        location.hash = '#/browse/' + id;
        await wait(900);
        const rows = document.querySelectorAll('.cardrow').length;
        const toast = document.querySelector('#toast')?.innerText || '';
        return JSON.stringify({ rows, toast, head: (document.body.innerText || '').slice(0, 80) });
      })()`);
      log.push('仓库页: ' + r6);
      // 点一个术语看详情
      const r7 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelector('.cardrow')?.click();
        await wait(900);
        return JSON.stringify({
          term: document.querySelector('.detail .term')?.innerText || 'NO_TERM',
          bodyLen: (document.querySelector('#cardBody')?.innerText || '').length,
          toast: document.querySelector('#toast')?.innerText || '',
        });
      })()`);
      log.push('术语详情: ' + r7);
      // 配图：找一张有图的卡，看 <img> 有没有真的加载出来
      const r8 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const { callApi } = {};
        const courses = (await window.nativeApi.invoke('GET', '/api/bootstrap')).courses;
        for (const c of courses) {
          const b = await window.nativeApi.invoke('GET', '/api/browse/' + c.id);
          const withImg = b.cards.find(x => x.image_path);
          if (!withImg) continue;
          location.hash = '#/card/' + withImg.id;
          await wait(900);
          const img = document.querySelector('.cardimg img');
          if (!img) return JSON.stringify({ found: withImg.front, img: 'NO_IMG_TAG' });
          await wait(400);
          return JSON.stringify({
            found: withImg.front, src: img.src.slice(-40),
            loaded: img.complete && img.naturalWidth > 0, w: img.naturalWidth,
          });
        }
        return JSON.stringify({ img: 'NO_CARD_WITH_IMAGE' });
      })()`);
      log.push('配图: ' + r8);
    } catch (e) {
      log.push('UI 测试出错: ' + e.message);
    }
    console.log('[uitest]\n' + log.join('\n'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(process.env.MIAOMIAO_DATA || '.', 'uitest.log'), log.join('\n'), 'utf8');
    } catch (e) { console.log('[uitest] 写日志失败', e.message); }
    app.quit();
    return;
  }

  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
