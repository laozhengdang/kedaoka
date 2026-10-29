// pack.mjs —— 可靠打包：复制代码 → 校验 → 报告
// 用 node 跑（根目录 `node tools/pack.mjs`），或双击 打包.bat
import { existsSync, readFileSync, statSync, rmSync, mkdirSync, cpSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'build', '课到卡');
const APPDIR = join(OUT, 'resources', 'app');

const say = (s) => console.log(s);
const fail = (s) => { console.error('[×] ' + s); process.exitCode = 1; };

say('打包检查');
say('='.repeat(50));

// 打包目录没了就自动从「已安装的完整副本」复制一份（不含 data）
// 顺序：环境变量 MIAOMIAO_BASE → 桌面\课到卡 → 项目里的旧构建
if (!existsSync(join(OUT, '课到卡.exe'))) {
  const homes = [process.env.MIAOMIAO_BASE, join(process.env.USERPROFILE || '', 'Desktop', '课到卡'),
    join(ROOT, 'build', '老郑荡的妙妙小工具')].filter(Boolean);
  const base = homes.find((h) => existsSync(join(h, 'resources', 'app')) &&
    (existsSync(join(h, '课到卡.exe')) || existsSync(join(h, '老郑荡的妙妙小工具.exe'))));
  if (!base) {
    fail(`没找到 ${OUT}\\课到卡.exe，也没找到可复制的完整副本（可设 MIAOMIAO_BASE 指向程序目录）`);
    process.exit(1);
  }
  say(`0) 打包目录不存在，从完整副本重建：${base}`);
  cpSync(base, OUT, {
    recursive: true,
    filter: (src) => !/[\\/]data([\\/]|$)/.test(src) && !/[\\/]log([\\/]|$)/.test(src),
  });
  const oldExe = join(OUT, '老郑荡的妙妙小工具.exe');
  if (!existsSync(join(OUT, '课到卡.exe')) && existsSync(oldExe)) {
    cpSync(oldExe, join(OUT, '课到卡.exe'));
    rmSync(oldExe, { force: true });
  }
  rmSync(join(OUT, 'data'), { recursive: true, force: true });
  mkdirSync(join(OUT, 'data'), { recursive: true });
}

if (!existsSync(join(OUT, '课到卡.exe'))) {
  fail(`没找到 ${OUT}\\课到卡.exe（先把 Electron 发行版放进去）`);
  process.exit(1);
}

// 1) 复制 app/ tools/ package.json
say('1) 复制代码…');
mkdirSync(APPDIR, { recursive: true });
for (const dir of ['app', 'tools']) {
  const dst = join(APPDIR, dir);
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  cpSync(join(ROOT, dir), dst, { recursive: true });
}
copyFileSync(join(ROOT, 'package.json'), join(APPDIR, 'package.json'));

// 让同学能一键在桌面建快捷方式：两个文件放到程序根目录（exe 旁边）
for (const f of ['创建桌面快捷方式.bat', '自检.bat', 'make_shortcut.ps1']) {
  const src = f.endsWith('.bat') ? join(ROOT, f) : join(ROOT, 'tools', f);
  if (existsSync(src)) copyFileSync(src, join(OUT, f));
}

// 2) 复制内置 Python（有就复制）
say('2) 复制内置 Python…');
if (existsSync(join(ROOT, 'runtime', 'python', 'python.exe'))) {
  const dst = join(APPDIR, 'runtime');
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  cpSync(join(ROOT, 'runtime'), dst, { recursive: true });
  say('   已复制 runtime/python');
} else {
  say('   [!] 没有 runtime/python，导入功能需要系统 Python');
}

// 3) 校验：源码里的关键标记必须出现在打包目录
say('3) 校验关键代码…');
const mustHave = [
  ['app/public/app.js', ['loadBalance', 'expMd', 'pShuffle', 'pQuotes', 'openImageViewer']],
  ['app/public/index.html', ['btnBalance', 'focusPresets', 'vendor/decimal.js']],
  ['app/public/vendor/decimal.js', ['Decimal']],
  ['app/public/quotes.js', ['QUOTES']],
  ['app/api.mjs', ['export/cards', 'card/:id/images']],
];
let ok = true;
for (const [rel, keys] of mustHave) {
  const target = join(APPDIR, rel);
  if (!existsSync(target)) { fail(`${rel} 没复制过去`); ok = false; continue; }
  const text = readFileSync(target, 'utf8');
  for (const k of keys) {
    if (!text.includes(k)) { fail(`${rel} 里缺少 ${k}`); ok = false; }
  }
}

// 4) 时间戳对比
say('4) 时间戳对比…');
const srcJs = statSync(join(ROOT, 'app', 'public', 'app.js')).mtime;
const dstJs = existsSync(join(APPDIR, 'app', 'public', 'app.js'))
  ? statSync(join(APPDIR, 'app', 'public', 'app.js')).mtime : new Date(0);
say(`   源码 app.js：${srcJs.toLocaleString()}`);
say(`   打包 app.js：${dstJs.toLocaleString()}`);
if (dstJs < srcJs) { fail('打包目录比源码旧，复制没生效'); ok = false; }

say('='.repeat(50));
if (ok) say('打包完成，可以启动：build\\课到卡\\课到卡.exe');
else say('打包有问题，看上面 [×] 的行');
process.exit(ok ? 0 : 1);
