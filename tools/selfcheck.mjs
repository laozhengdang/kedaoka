// selfcheck.mjs —— 数据自检：不点界面也能知道库里有没有问题
// 用法：node tools/selfcheck.mjs [数据目录]   或   exe --selfcheck
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export async function runSelfCheck(dataDirArg) {
  const dataDir = dataDirArg || process.env.MIAOMIAO_DATA || join(ROOT, 'data');
  process.env.MIAOMIAO_DATA = dataDir;
  const { db } = await import(pathToFileURL(join(ROOT, 'app', 'db.mjs')).href);

  const lines = [];
  const say = (s = '') => { lines.push(s); };
  const ok = (s) => say(`  ✓ ${s}`);
  const bad = (s) => say(`  ✗ ${s}`);
  const warn = (s) => say(`  ! ${s}`);

  say('数据自检');
  say('='.repeat(52));
  say(`数据目录：${dataDir}`);
  say('');

  const courses = db.prepare('SELECT id, name FROM course ORDER BY created_at').all();
  if (!courses.length) say('还没有课程。');

  let problems = 0;

  for (const c of courses) {
    say(`【${c.name}】`);
    const total = db.prepare(
      "SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0").get(c.id).n;
    say(`  卡片 ${total} 张`);

    const dup = db.prepare(`
      SELECT front, COUNT(*) n FROM card
      WHERE course_id=? AND status='active' AND is_title=0
      GROUP BY front HAVING n>1`).all(c.id);
    if (dup.length) { bad(`重复词 ${dup.length} 组：${dup.slice(0, 5).map((d) => d.front).join('、')}`); problems += 1; }
    else ok('没有重名卡片');

    const noFile = db.prepare(`
      SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0
        AND (file_id IS NULL OR file_id='')`).get(c.id).n;
    if (noFile) warn(`有 ${noFile} 张卡没记来源文件（章节可能显示不全）`);
    else ok('全部卡片都记得来源文件');

    const noBack = db.prepare(`
      SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0
        AND (back IS NULL OR length(trim(back))<4)`).get(c.id).n;
    if (noBack) { bad(`${noBack} 张卡没有释义（复习时会空白）`); problems += 1; }
    else ok('每张卡都有释义');

    const junk = db.prepare(`
      SELECT front FROM card WHERE course_id=? AND status='active' AND is_title=0
        AND (front LIKE '第%章' OR front LIKE '第%节' OR front IN ('主要内容','本章要点','实验目的','思考题','小结','简称','称为','建立'))
      LIMIT 10`).all(c.id);
    if (junk.length) { bad(`疑似垃圾词 ${junk.length} 个：${junk.map((j) => j.front).join('、')}`); problems += 1; }
    else ok('没有明显垃圾词');

    const dias = db.prepare('SELECT id, title FROM diagram WHERE course_id=?').all(c.id);
    const linked = db.prepare(`
      SELECT COUNT(DISTINCT cd.card_id) n FROM card_diagram cd
      JOIN card c ON c.id=cd.card_id WHERE c.course_id=?`).get(c.id).n;
    if (dias.length) ok(`机制图 ${dias.length} 张，挂到 ${linked} 张卡`);
    else warn('还没有机制图（课程页「机制图」→ 让 AI 画一张）');

    const today = db.prepare(
      'SELECT COUNT(*) n, COALESCE(SUM(done),0) d FROM daily_queue WHERE course_id=? AND date=(SELECT MAX(date) FROM daily_queue WHERE course_id=?)')
      .get(c.id, c.id);
    if (today.n) ok(`最近一次队列：${today.d}/${today.n} 完成`);
    say('');
  }

  say('【全局】');
  const orphan = db.prepare(`
    SELECT COUNT(*) n FROM card c
    WHERE c.status='active' AND c.file_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM source_file sf WHERE sf.id=c.file_id)`).get().n;
  if (orphan) { bad(`${orphan} 张卡的来源文件已不存在（出处会空）`); problems += 1; }
  else ok('卡片与来源文件的关联完整');

  const brokenDiag = db.prepare(`
    SELECT COUNT(*) n FROM card_diagram cd
    WHERE NOT EXISTS (SELECT 1 FROM diagram d WHERE d.id=cd.diagram_id)
       OR NOT EXISTS (SELECT 1 FROM card c WHERE c.id=cd.card_id)`).get().n;
  if (brokenDiag) { bad(`${brokenDiag} 条机制图关联指向已删除的对象`); problems += 1; }
  else ok('机制图关联没有悬空');

  const prof = db.prepare("SELECT value FROM profile WHERE key='profession'").get();
  say(`  当前科目：${prof ? JSON.parse(prof.value) : '（未设置）'}`);

  say('');
  say('='.repeat(52));
  say(problems ? `发现 ${problems} 个需要处理的问题（上面标 ✗ 的）` : '没有发现硬伤，可以放心用');

  const outDir = join(dataDir, 'reports');
  try {
    mkdirSync(outDir, { recursive: true });
    const f = join(outDir, `selfcheck-${new Date().toISOString().slice(0, 10)}.txt`);
    writeFileSync(f, lines.join('\n'), 'utf8');
    say(`报告已存：${f}`);
  } catch { /* 存不了就算了，屏幕上有 */ }

  return lines;
}

// 直接 node 运行才自动执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = await runSelfCheck(process.argv[2]);
  console.log(lines.join('\n'));
}
