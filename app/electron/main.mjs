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
const SELFCHECK = process.argv.includes('--selfcheck');
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
  const { callApi, startImport, getJob, probeImport } = await import('../api.mjs');
  if (path === '/api/probe' && method === 'POST') return probeImport(body.file);
  if (path === '/api/import' && method === 'POST') return { job: startImport(body.file, body.courseName, body.kind || 'theory', body.docType || 'ppt') };
  if (path.startsWith('/api/job/')) return getJob(path.slice('/api/job/'.length));
  return callApi(method, path, body || {});
});

// 外部链接用系统浏览器打开，不在应用里导航
ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});

// 把库里的相对图片路径变成能直接放进 <img src> 的 file:// 地址
ipcMain.handle('data-dir', async () => process.env.MIAOMIAO_DATA || '.');

// 保存文本到用户选的位置（导出用）
ipcMain.handle('save-text', async (_e, { filename, text } = {}) => {
  const { dialog } = await import('electron');
  const { writeFileSync } = await import('node:fs');
  const r = await dialog.showSaveDialog(win || undefined, { defaultPath: filename || 'export.txt' });
  if (r.canceled || !r.filePath) return { ok: false };
  writeFileSync(r.filePath, String(text ?? ''), 'utf8');
  return { ok: true, path: r.filePath };
});

// 备份数据库：先 checkpoint 再复制一份
ipcMain.handle('backup-db', async () => {
  const { dialog } = await import('electron');
  const { copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = join(process.env.MIAOMIAO_DATA || '.', 'db', 'app.db');
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win || undefined, {
    defaultPath: `妙妙小工具-备份-${stamp}.db`,
    filters: [{ name: '数据库', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  copyFileSync(src, r.filePath);
  return { ok: true, path: r.filePath };
});

// 读取文本文件（导入 .drawio 用）
ipcMain.handle('read-text', async (_e, p) => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(String(p), 'utf8');
});

// 独占全屏（专注计时器用）
ipcMain.handle('set-fullscreen', async (_e, on) => {
  if (win) win.setFullScreen(Boolean(on));
  return { ok: true, fullscreen: Boolean(on) };
});

// 选背景图：返回绝对路径
ipcMain.handle('pick-image', async () => {
  const { dialog } = await import('electron');
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选一张背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

// 把选中的背景图复制进 data/backgrounds，返回库内相对路径
ipcMain.handle('import-background', async (_e, srcPath) => {
  const { copyFileSync, mkdirSync } = await import('node:fs');
  const { join, basename } = await import('node:path');
  const dir = join(process.env.MIAOMIAO_DATA || '.', 'backgrounds');
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_${basename(String(srcPath)).replace(/[\\/:*?"<>|]/g, '_')}`;
  const dst = join(dir, name);
  copyFileSync(srcPath, dst);
  return `backgrounds/${name}`;
});

// 原生文件选择器：返回绝对路径
ipcMain.handle('pick-files', async () => {
  const { dialog } = await import('electron');
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择课件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '课件', extensions: ['pdf', 'pptx', 'ppt'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

// 拖进来的文件：写到 data/incoming/ 下，返回绝对路径
ipcMain.handle('drop-file', async (_e, payload = {}) => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join, basename } = await import('node:path');
  const dir = join(process.env.MIAOMIAO_DATA || '.', 'incoming');
  mkdirSync(dir, { recursive: true });
  const safe = String(payload.name || 'dropped.pdf').replace(/[\\/:*?"<>|]/g, '_');
  const file = join(dir, basename(safe));
  writeFileSync(file, Buffer.from(payload.buffer));
  return file;
});

// 首次运行（仅打包版）：桌面没有快捷方式就建一个
async function ensureDesktopShortcut() {
  try {
    if (process.platform !== 'win32' || !app.isPackaged) return;
    const { shell } = await import('electron');
    const { existsSync } = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const desktop = pathMod.join(os.homedir(), 'Desktop');
    const lnk = pathMod.join(desktop, '老郑荡的妙妙小工具.lnk');
    if (existsSync(lnk)) return;
    shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      cwd: pathMod.dirname(process.execPath),
      icon: process.execPath,
      iconIndex: 0,
      description: '把课件 PDF 变成能考的知识卡',
    });
  } catch { /* 建不了就算了，不影响使用 */ }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  if (SELFCHECK) {
    try {
      const { runSelfCheck } = await import('../../tools/selfcheck.mjs');
      const lines = await runSelfCheck(process.env.MIAOMIAO_DATA || join(HERE, '..', '..', 'data'));
      console.log(lines.join('\n'));
    } catch (e) {
      console.log('自检失败：' + (e && e.message ? e.message : e));
    }
    app.quit();
    return;
  }

  if (SMOKE) {
    const { callApi } = await import('../api.mjs');
    const b = callApi('GET', '/api/bootstrap');
    console.log('[smoke] courses:', b.courses.map((c) => `${c.name}(${c.cards}卡)`).join(', '));
    console.log('[smoke] node', process.versions.node, 'electron', process.versions.electron);
    app.quit();
    return;
  }

  await ensureDesktopShortcut();

  if (UITEST) {
    win = new BrowserWindow({
      width: 1200, height: 820, show: UITEST,
      webPreferences: {
        preload: join(HERE, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    await win.loadFile(join(PUBLIC, 'index.html'));
    const log = [];
    // 先截一张开屏（名言），再关掉它
    try {
      const { writeFileSync: wfS } = await import('node:fs');
      const splashInfo = await win.webContents.executeJavaScript(`(async () => {
        // 等开屏真正显示出来再读（boot 是异步的）
        for (let i = 0; i < 25; i += 1) {
          const box = document.querySelector('#splash');
          if (box && !box.classList.contains('hidden')) break;
          await new Promise(r => setTimeout(r, 100));
        }
        const box = document.querySelector('#splash');
        return JSON.stringify({
          text: (document.querySelector('#splashQuote') || {}).textContent || '',
          by: (document.querySelector('#splashAuthor') || {}).textContent || '',
          visible: !!box && !box.classList.contains('hidden'),
        });
      })()`);
      log.push('开屏: ' + splashInfo);
      const shotSplash = await win.webContents.capturePage();
      const dir = process.env.MIAOMIAO_DATA || '.';
      wfS(join(dir, 'shot-splash.png'), shotSplash.toPNG());
    } catch (e) { log.push('开屏截图失败: ' + e.message + ' / data=' + (process.env.MIAOMIAO_DATA || 'undefined')); }
    try {
      const sidebar = await win.webContents.executeJavaScript(`(async () => {
        // 关掉启动画面，否则会挡住后面的点击
        document.querySelector('#splash')?.click();
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('.course') || document.querySelector('#main .wrap')) break;
          await new Promise(r => setTimeout(r, 120));
        }
        return document.querySelectorAll('.course').length;
      })()`);
      log.push(`课程条数: ${sidebar}`);
      const r1 = await win.webContents.executeJavaScript(`(async () => {
        const first = document.querySelector('.course');
        if (first) first.click();
        else if (window.STATE && STATE.courses && STATE.courses[0]) location.hash = '#/course/' + STATE.courses[0].id;
        await new Promise(r => setTimeout(r, 700));
        return (document.body.innerText || '').slice(0, 160);
      })()`);
      log.push('课程页文本: ' + r1.replace(/\\n/g, ' | '));
      const courseAudit = await win.webContents.executeJavaScript(`JSON.stringify({
        tinted: document.querySelectorAll('.btn-tint').length,
        colored: [...document.querySelectorAll('.btn-tint')].map((b) => getComputedStyle(b).backgroundColor).filter((c) => c && c !== 'rgba(0, 0, 0, 0)').length,
        actions: !!document.querySelector('.actions'),
      })`);
      log.push('按钮体检: ' + courseAudit);
      const statsAudit = await win.webContents.executeJavaScript(`(async () => {
        const b = await window.nativeApi.invoke('GET', '/api/bootstrap');
        location.hash = '#/stats/' + b.courses[0].id;
        await new Promise(r => setTimeout(r, 900));
        const list = document.querySelector('#fuzzyList');
        return JSON.stringify({
          hasList: !!list,
          items: list ? list.querySelectorAll('[data-card]').length : 0,
          navBack: !!document.querySelector('#stBack'),
          navSet: document.querySelectorAll('[data-jump]').length,
        });
      })()`);
      log.push('统计体检: ' + statsAudit);
      try {
        const { writeFileSync: wf2 } = await import('node:fs');
        await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('#splash')?.click();
          await new Promise(r => setTimeout(r, 700));
        })()`);
        const shotCourse = await win.webContents.capturePage();
        wf2(join(process.env.MIAOMIAO_DATA || '.', 'shot-course.png'), shotCourse.toPNG());
      } catch { /* noop */ }
      const r2 = await win.webContents.executeJavaScript(`(async () => {
        // 先确保在课程页（前面几步可能跳到了别的页面）
        const bs = await window.nativeApi.invoke('GET', '/api/bootstrap');
        const cid = bs.courses[0] && bs.courses[0].id;
        if (cid) {
          location.hash = '#/course/' + cid;
          await new Promise(r => setTimeout(r, 900));
        }
        const btn = [...document.querySelectorAll('button')]
          .find(b => /开始今天的|继续/.test(b.textContent));
        if (!btn) {
          // 今天已经刷完了：先点「再来一轮」造一个队列，再进复习屏
          const extra = [...document.querySelectorAll('button')].find(b => /再来一轮/.test(b.textContent));
          if (!extra) return 'NO_BUTTON_AND_NO_EXTRA｜已有按钮：' + [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 20).join('/');
          extra.click();
          await new Promise(r => setTimeout(r, 1600));
          const btn2 = [...document.querySelectorAll('button')].find(b => /开始今天的|继续/.test(b.textContent));
          if (!btn2) return 'STILL_NO_BUTTON';
          btn2.click();
        } else {
          btn.click();
        }
        await new Promise(r => setTimeout(r, 900));
        return document.querySelector('#revInner')?.innerText?.slice(0, 140) || 'EMPTY_REVIEW';
      })()`);
      log.push('复习屏: ' + (r2 || '').replace(/\\n/g, ' | '));
      // 截一张图，留作界面证据
      try {
        const { writeFileSync } = await import('node:fs');
        await new Promise((r) => setTimeout(r, 500));
        const shot = await win.webContents.capturePage();
        const shotPath = join(process.env.MIAOMIAO_DATA || '.', 'shot-review.png');
        writeFileSync(shotPath, shot.toPNG());
        log.push('截图: ' + shotPath);
      } catch (e) { log.push('截图失败: ' + e.message); }
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

      // 卡片编辑器：按钮是否齐全 + 加关联能否搜出结果
      try {
        const editor = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const ids = ['btnEdit', 'btnSwapImg', 'btnRevert', 'btnAddRel', 'btnMerge'];
          const present = {};
          for (const id of ids) present[id] = !!document.querySelector('#' + id);
          let hits = 0;
          const add = document.querySelector('#btnAddRel');
          if (add) {
            add.click();
            await wait(250);
            const q = document.querySelector('#addRelQ');
            if (q) {
              q.value = '抗体';
              q.dispatchEvent(new Event('input'));
              await wait(700);
              hits = document.querySelectorAll('#addRelList [data-pick]').length;
            }
          }
          return JSON.stringify({ present, hits });
        })()`);
        log.push('卡片编辑器: ' + editor);
      } catch (e) {
        log.push('卡片编辑器检查出错: ' + e.message);
      }
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
      // 关系图页
      const r9 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const courses = (await window.nativeApi.invoke('GET', '/api/bootstrap')).courses;
        location.hash = '#/graph/' + courses[0].id;
        await wait(900);
        const roots = document.querySelectorAll('.tree-root').length;
        const links = document.querySelectorAll('.tree a').length;
        const firstLink = document.querySelector('.tree a')?.innerText || '';
        return JSON.stringify({ roots, links, firstLink, toast: document.querySelector('#toast')?.innerText || '' });
      })()`);
      log.push('关系图: ' + r9);
      // 设置页的 AI 面板
      const r10 = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        location.hash = '#/settings';
        await wait(900);
        const panel = document.querySelector('#aiPanel')?.innerText || 'NO_PANEL';
        return JSON.stringify({ panel: panel.replace(/\\n/g, ' | ').slice(0, 160) });
      })()`);
      log.push('AI 面板: ' + r10);
      // 设置页截图（此时还在设置页，能看清显示偏好那一块）
      try {
        const { writeFileSync: wf } = await import('node:fs');
        await win.webContents.executeJavaScript(`(async () => {
          const elx = document.querySelector('#pShuffle');
          if (elx) elx.scrollIntoView({ block: 'center' });
          await new Promise(r => setTimeout(r, 400));
        })()`);
        const shotSet = await win.webContents.capturePage();
        wf(join(process.env.MIAOMIAO_DATA || '.', 'shot-settings.png'), shotSet.toPNG());
      } catch { /* noop */ }
      // 关键控件体检：确认新功能真的在界面上
      const audit = await win.webContents.executeJavaScript(`JSON.stringify({
        balance: (document.querySelector('#balanceText') || {}).textContent || '',
        balanceBtn: !!document.querySelector('#btnBalance'),
        shuffle: !!document.querySelector('#pShuffle'),
        quotes: !!document.querySelector('#pQuotes'),
        expMd: !!document.querySelector('#expMd'),
        expCsv: !!document.querySelector('#expCsv'),
        expBackup: !!document.querySelector('#expBackup'),
        advClear: !!document.querySelector('#advClearQueue'),
        plainBtn: !!document.querySelector('#pPlainBtn'),
        setNav: document.querySelectorAll('.set-nav a').length,
      })`);
      log.push('控件体检: ' + audit);

      // 名言库：抽样 10 次看重复率，并读一次首页实际显示的那句
      try {
        const q = await win.webContents.executeJavaScript(`JSON.stringify((() => {
          const pool = window.QUOTES || [];
          const api = window.MiaoQuotes;
          const out = [];
          if (api) {
            for (let i = 0; i < 10; i += 1) out.push(api.pick(null).t.slice(0, 14));
          }
          return { total: pool.length, picked: out.length, uniq: new Set(out).size, samples: out.slice(0, 4) };
        })())`);
        log.push('名言库: ' + q);
        const home = await win.webContents.executeJavaScript(`(async () => {
          location.hash = '#/';
          await new Promise(r => setTimeout(r, 700));
          const el = document.querySelector('.quote');
          const flat = (s) => String(s || '').split(String.fromCharCode(10)).join(' ');
          return JSON.stringify({ home: el ? flat(el.innerText).slice(0, 50) : 'NO_QUOTE' });
        })()`);
        log.push('首页名言: ' + home);
      } catch (e) {
        log.push('名言检查出错: ' + e.message);
      }

      // 计算器：打开 → 输入算式 → 读结果 → 截图 → 关闭
      try {
        const { writeFileSync: wf3 } = await import('node:fs');
        const calc = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          document.querySelector('#btnCalc')?.click();
          await wait(400);
          const input = document.querySelector('#calcInput');
          if (!input) return JSON.stringify({ ok: false, err: '没打开' });
          const cases = ['0.1+0.2', '120 km/h to m/s', '5 mol/L * 2 L', 'sqrt(16)+3!', 'C(10,3)', '30 C to F'];
          const out = [];
          for (const c of cases) {
            input.value = c;
            input.dispatchEvent(new Event('input'));
            await wait(60);
            out.push(c + ' = ' + (document.querySelector('#calcResult')?.textContent || ''));
          }
          const btnCount = document.querySelectorAll('.calc-key, .calc-fn').length;
          return JSON.stringify({ ok: true, btnCount, out });
        })()`);
        log.push('计算器: ' + calc);
        log.push('计算器样式: ' + await win.webContents.executeJavaScript(`(() => {
          const ov = document.querySelector('.calc-ov');
          const box = document.querySelector('.calc-box');
          if (!ov) return 'no overlay';
          const cs = getComputedStyle(ov);
          const r = ov.getBoundingClientRect();
          const br = box ? box.getBoundingClientRect() : null;
          return JSON.stringify({
            display: cs.display, position: cs.position, zIndex: cs.zIndex,
            opacity: cs.opacity, visibility: cs.visibility,
            rect: [r.x | 0, r.y | 0, r.width | 0, r.height | 0],
            box: br ? [br.x | 0, br.y | 0, br.width | 0, br.height | 0] : null,
            bg: cs.backgroundColor,
          });
        })()`));
        // 截图前把窗口提到前面，否则合成层可能还没画出来
        try { win.show(); win.focus(); } catch { /* noop */ }
        await win.webContents.executeJavaScript(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        const shotCalc = await win.webContents.capturePage();
        // 再单独截计算器那块区域，排除整页合成的问题
        try {
          const rectShot = await win.webContents.capturePage({ x: 380, y: 20, width: 440, height: 760 });
          wf3(join(process.env.MIAOMIAO_DATA || '.', 'shot-calc-box.png'), rectShot.toPNG());
        } catch { /* noop */ }
        wf3(join(process.env.MIAOMIAO_DATA || '.', 'shot-calc.png'), shotCalc.toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('#calcClose')?.click()`);

        // 右边缘把手：点击 → 贴边展开 → 再截一张
        try {
          const dock = await win.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            const h = document.querySelector('#calcHandle');
            if (!h) return JSON.stringify({ ok: false, err: '没有把手' });
            h.click();
            await wait(450);
            const ov = document.querySelector('.calc-ov');
            const box = document.querySelector('.calc-box');
            const br = box ? box.getBoundingClientRect() : null;
            return JSON.stringify({
              ok: !!ov && ov.classList.contains('calc-ov-dock'),
              handleText: h.textContent.trim(),
              rect: br ? [br.x | 0, br.width | 0, br.height | 0] : null,
              hasInput: !!document.querySelector('#calcInput'),
            });
          })()`);
          log.push('右边缘计算器: ' + dock);
          await win.webContents.executeJavaScript(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
          const dockShot = await win.webContents.capturePage({ x: 700, y: 0, width: 486, height: 780 });
          wf3(join(process.env.MIAOMIAO_DATA || '.', 'shot-calc-dock.png'), dockShot.toPNG());
          await win.webContents.executeJavaScript(`document.querySelector('#calcClose')?.click()`);
        } catch (e) {
          log.push('右边缘计算器出错: ' + e.message);
        }
      } catch (e) {
        log.push('计算器测试出错: ' + e.message);
      }
      // 专注计时器外观
      try {
        const { writeFileSync } = await import('node:fs');
        await win.webContents.executeJavaScript(`(async () => {
          location.hash = '#/';
          document.querySelector('#btnTimer').click();
          document.querySelector('#focusToggle').click();
          await new Promise(r => setTimeout(r, 1200));
        })()`);
        const shot2 = await win.webContents.capturePage();
        writeFileSync(join(process.env.MIAOMIAO_DATA || '.', 'shot-focus.png'), shot2.toPNG());
        await win.webContents.executeJavaScript("document.querySelector('#focusExit').click()");
        // 机制图
        await win.webContents.executeJavaScript(`(async () => {
          const b = await window.nativeApi.invoke('GET', '/api/bootstrap');
          const want = ${JSON.stringify(process.env.SHOT_COURSE || '免疫学')};
          const c = b.courses.find(x => x.name === want) || b.courses[0];
          location.hash = '#/diagram/' + c.id;
          await new Promise(r => setTimeout(r, 900));
        })()`);
        const shot3 = await win.webContents.capturePage();
        writeFileSync(join(process.env.MIAOMIAO_DATA || '.', 'shot-diagram.png'), shot3.toPNG());

        // 模拟卷配置页
        await win.webContents.executeJavaScript(`(async () => {
          const b = await window.nativeApi.invoke('GET', '/api/bootstrap');
          location.hash = '#/exam/' + b.courses[0].id;
          await new Promise(r => setTimeout(r, 800));
        })()`);
        const shotExam = await win.webContents.capturePage();
        writeFileSync(join(process.env.MIAOMIAO_DATA || '.', 'shot-exam.png'), shotExam.toPNG());

        // 卡片释义 + 机制图
        const { db: dbase } = await import('../db.mjs');
        const cardId = dbase.prepare('SELECT card_id FROM card_diagram LIMIT 1').get()?.card_id;
        if (cardId) {
          await win.webContents.executeJavaScript(`(async () => {
            location.hash = '#/card/${cardId}';
            await new Promise(r => setTimeout(r, 1100));
          })()`);
          const shot4 = await win.webContents.capturePage();
          writeFileSync(join(process.env.MIAOMIAO_DATA || '.', 'shot-card.png'), shot4.toPNG());
        }
      } catch { /* noop */ }
      try {
        const { writeFileSync } = await import('node:fs');
        const shot = await win.webContents.capturePage();
        writeFileSync(join(process.env.MIAOMIAO_DATA || '.', 'shot-final.png'), shot.toPNG());
      } catch { /* noop */ }
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
