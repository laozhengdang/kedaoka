// 检查复习屏四个按钮的真实计算样式（确认 CSS 真的生效）
import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.MIAOMIAO_DATA = process.env.MIAOMIAO_DATA || join(HERE, '..', '..', 'data');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 820, show: false,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true },
  });
  await win.loadFile(join(HERE, '..', 'public', 'index.html'));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const b = await window.nativeApi.invoke('GET', '/api/bootstrap');
    const cid = b.courses[0].id;
    location.hash = '#/course/' + cid;
    await wait(700);
    const btn = [...document.querySelectorAll('button')].find(x => /开始今天的|继续/.test(x.textContent));
    if (btn) btn.click();
    else return 'NO_START_BUTTON';
    await wait(900);
    const els = [...document.querySelectorAll('.choice')];
    return JSON.stringify(els.map(e => ({
      cls: e.className,
      bg: getComputedStyle(e).backgroundColor,
      color: getComputedStyle(e).color,
    })));
  })()`);
  console.log(out);
  app.quit();
});
