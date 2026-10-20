// api.mjs —— 所有业务逻辑都在这里，服务端和桌面端共用同一份。
// server.mjs（网页版）调 callApi；electron/main.mjs（桌面版）也调 callApi。

import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getProfile, setProfile, today, nowIso, uid } from './db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ---------- 出处：章节名 ----------
// 优先级：页面里识别出的章节 > 文件名里的「第X章」 > 文件名本身
function chapterOf(fileName, pageChapter) {
  if (pageChapter) return pageChapter;
  if (!fileName) return '';
  const m = fileName.match(/第[一二三四五六七八九十0-9]+[章节]/);
  if (m) return m[0];
  const base = fileName.replace(/\.[^.]+$/, '').replace(/^[0-9０-９]+[-\s._、]*/, '').trim();
  return base.slice(0, 24);
}

// ---------- .drawio XML 解析（够用就好：矩形节点 + 连线） ----------
// draw.io 有两种存法：明文 <mxGraphModel>，或把模型压成 base64(deflate) 塞进
// <diagram> 文本 / .drawio.svg 的 content 属性里。两种都要能读。
function expandDrawio(input) {
  let xml = String(input);
  if (xml.includes('<mxGraphModel')) return xml;

  // .drawio.svg：<svg ... content="&lt;mxfile ...&gt;">
  const contentAttr = xml.match(/content="([\s\S]*?)"\s/);
  if (contentAttr) xml = xmlUnescape(contentAttr[1]);

  const m = xml.match(/<diagram\b[^>]*>([\s\S]*?)<\/diagram>/);
  if (!m) return xml;
  const body = m[1].trim();
  if (!body || body.startsWith('<mxGraphModel')) return xml;
  try {
    const inflated = zlib.inflateRawSync(Buffer.from(body, 'base64')).toString('utf8');
    return decodeURIComponent(inflated);
  } catch {
    try { return decodeURIComponent(body); } catch { return xml; }
  }
}

function xmlUnescape(s) {
  return String(s)
    .replace(/&#10;/g, '\n').replace(/&#9;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlAttr(text, name) {
  const m = text.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? xmlUnescape(m[1]) : '';
}

function styleMap(style) {
  const out = {};
  for (const part of String(style || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    else if (part.trim()) out[part.trim()] = '1';
  }
  return out;
}

function parseDiagramNodes(xml) {
  const nodes = [];
  const chunks = String(xml).split('<mxCell').slice(1);
  for (const raw of chunks) {
    const headEnd = raw.indexOf('>');
    if (headEnd < 0) continue;
    const head = raw.slice(0, headEnd);
    const body = raw.slice(0, Math.max(0, raw.indexOf('</mxCell>')));
    if (xmlAttr(head, 'vertex') !== '1') continue;
    const text = xmlAttr(head, 'value');
    if (!text || !text.trim()) continue;
    const geo = body.match(/<mxGeometry\b[^>]*>/);
    const g = geo ? geo[0] : head;
    const num = (n, d = 0) => {
      const v = xmlAttr(g, n);
      const f = Number(v);
      return Number.isFinite(f) && v !== '' ? f : d;
    };
    let x = num('x', NaN);
    let y = num('y', NaN);
    let w = num('width', NaN);
    let h = num('height', NaN);
    if (!Number.isFinite(x)) x = num('x', 0);
    if (!Number.isFinite(y)) y = num('y', 0);
    if (!Number.isFinite(w)) w = Number(xmlAttr(head, 'w')) || 120;
    if (!Number.isFinite(h)) h = Number(xmlAttr(head, 'h')) || 40;
    const st = styleMap(xmlAttr(head, 'style'));
    // 形状：draw.io 用 shape=xxx 或裸标签（ellipse / rhombus / hexagon …）
    let shape = String(st.shape || '').toLowerCase();
    if (!shape) {
      for (const k of ['ellipse', 'rhombus', 'hexagon', 'triangle', 'cylinder', 'document', 'text', 'parallelogram', 'trapezoid', 'circle']) {
        if (st[k] === '1') { shape = k; break; }
      }
    }
    if (!shape) shape = st.rounded === '1' ? 'rounded' : 'rect';
    // draw.io 里常带版本号或别名：cylinder3 / datastore / circle …
    shape = shape.replace(/[0-9]+$/, '');
    const alias = {
      circle: 'ellipse', datastore: 'cylinder', database: 'cylinder',
      callout: 'rounded', swimlane: 'rect', process: 'rounded', note: 'document',
      'parallelogram': 'parallelogram', 'trapezoid': 'trapezoid',
    };
    if (alias[shape]) shape = alias[shape];
    nodes.push({
      id: xmlAttr(head, 'id'),
      text: text.replace(/\n/g, ' ').trim(),
      x, y, w, h,
      fill: st.fillColor || '#f6f7fb',
      stroke: st.strokeColor || '#9aa3b2',
      rounded: st.rounded === '1',
      shape,
      fontSize: Number(st.fontSize) || 13,
      bold: st.fontStyle === '1',
    });
  }
  return nodes;
}

function parseDiagramEdges(xml) {
  const edges = [];
  for (const raw of String(xml).split('<mxCell').slice(1)) {
    const headEnd = raw.indexOf('>');
    if (headEnd < 0) continue;
    const head = raw.slice(0, headEnd);
    if (xmlAttr(head, 'edge') !== '1') continue;
    const source = xmlAttr(head, 'source');
    const target = xmlAttr(head, 'target');
    if (!source || !target) continue;
    const st = styleMap(xmlAttr(head, 'style'));
    edges.push({ source, target, label: xmlAttr(head, 'value'), dashed: st.dashed === '1' });
  }
  return edges;
}

// 把机制图里的节点文字和这门课的卡片对上，建立 card_diagram 关联
export function linkDiagramToCards(diagramId, courseId, xml) {
  const norm = (s) => String(s || '').replace(/[\s\u3000（）()·、，,。:：]/g, '');
  const stripNote = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, '');
  const cards = db.prepare("SELECT id, front FROM card WHERE course_id=? AND status='active'").all(courseId);
  const byText = new Map(cards.map((c) => [norm(c.front), c.id]));
  const ins = db.prepare('INSERT OR IGNORE INTO card_diagram(card_id,diagram_id,created_at) VALUES(?,?,?)');
  let n = 0;
  for (const node of parseDiagramNodes(xml)) {
    const cid = byText.get(norm(stripNote(node.text)));
    if (cid) { ins.run(cid, diagramId, nowIso()); n += 1; }
  }
  return n;
}

// ---------- 排程（简化版 SM-2，见文档 D19 / D13） ----------
export function schedule(cardId, rating, auto = 0) {
  const row = db.prepare('SELECT * FROM card_state WHERE card_id=?').get(cardId)
    || { state: 'new', interval_days: 0, streak_forgot: 0, leech: 0 };
  let { interval_days: iv, streak_forgot: sf, leech } = row;
  let state = row.state;

  if (rating === 1) {
    state = 'graduated';
    iv = 0;
  } else if (rating === 2) {
    state = 'review';
    iv = iv <= 0 ? 1 : Math.min(180, iv * 2.5);
    sf = 0;
  } else if (rating === 3) {
    state = 'learning';
    iv = iv <= 0 ? 0.5 : Math.max(0.5, iv * 1.2);
    sf += 1;
    if (sf >= 2) leech = 1;
  } else {
    state = 'relearning';
    iv = 0.2;
    sf += 1;
  }

  const due = new Date(Date.now() + iv * 86400000).toISOString();
  db.prepare(`INSERT INTO card_state(card_id,state,interval_days,due_at,streak_forgot,leech,last_rating,last_review_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(card_id) DO UPDATE SET state=excluded.state, interval_days=excluded.interval_days,
      due_at=excluded.due_at, streak_forgot=excluded.streak_forgot, leech=excluded.leech,
      last_rating=excluded.last_rating, last_review_at=excluded.last_review_at`)
    .run(cardId, state, iv, due, sf, leech, rating, nowIso());
  return { state, interval_days: iv, due_at: due };
}

function latestRound(courseId, date) {
  const r = db.prepare('SELECT MAX(round) AS r FROM daily_queue WHERE course_id=? AND date=?')
    .get(courseId, date).r;
  return r === null || r === undefined ? 0 : r;
}

// 标记"这张卡在今天这一轮已完成"
function markQueueDone(cardId) {
  const row = db.prepare('SELECT course_id FROM card WHERE id=?').get(cardId);
  if (!row) return;
  const date = today();
  const round = latestRound(row.course_id, date);
  db.prepare('UPDATE daily_queue SET done=1 WHERE card_id=? AND date=? AND round=?')
    .run(cardId, date, round);
}

export function ensureQueue(courseId) {
  const date = today();
  const has = db.prepare('SELECT COUNT(*) n FROM daily_queue WHERE course_id=? AND date=?')
    .get(courseId, date).n;
  if (has > 0) return;

  const p = getProfile();
  const all = db.prepare(`
    SELECT c.id, c.importance, COALESCE(s.state,'new') st, s.due_at
    FROM card c LEFT JOIN card_state s ON s.card_id=c.id
    WHERE c.course_id=? AND c.status='active' AND c.is_title=0`).all(courseId);

  const now = nowIso();
  const fresh = all.filter((c) => c.st === 'new' || c.st === 'learning')
    .sort((a, b) => b.importance - a.importance);
  const due = all.filter((c) => c.st !== 'new' && c.due_at && c.due_at <= now)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));

  let picked = [
    ...fresh.slice(0, p.daily_new_max),
    ...due.slice(0, p.daily_review_max),
  ];
  // 复习乱序：打散顺序，避免每天都是同一个排列
  if (p.shuffle) picked = picked.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO daily_queue(course_id,date,round,card_id,position) VALUES(?,?,0,?,?)');
  picked.forEach((c, i) => ins.run(courseId, date, c.id, i));
}

// 再来一轮：随机抽一批（默认 20），不占用当天的 10 张额度
export function extraRound(courseId, count = 20) {
  const date = today();
  ensureQueue(courseId);
  const round = latestRound(courseId, date) + 1;

  const done = new Set(db.prepare(
    'SELECT card_id FROM daily_queue WHERE course_id=? AND date=? AND round=?')
    .all(courseId, date, round - 1).map((r) => r.card_id));

  const pool = db.prepare(`
    SELECT c.id, c.importance, COALESCE(s.state,'new') st
    FROM card c LEFT JOIN card_state s ON s.card_id=c.id
    WHERE c.course_id=? AND c.status='active' AND c.is_title=0`).all(courseId);

  // 优先没刷过的，不够再补刷过的；同分打乱
  const fresh = pool.filter((c) => !done.has(c.id));
  const again = pool.filter((c) => done.has(c.id));
  const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const picked = [...shuffle(fresh), ...shuffle(again)].slice(0, Math.max(1, count));

  const ins = db.prepare(
    'INSERT OR IGNORE INTO daily_queue(course_id,date,round,card_id,position) VALUES(?,?,?,?,?)');
  picked.forEach((c, i) => ins.run(courseId, date, round, c.id, i));
  return { round, count: picked.length };
}

export function queueState(courseId) {
  const date = today();
  ensureQueue(courseId);
  const round = latestRound(courseId, date);
  const rows = db.prepare(`
    SELECT q.card_id, q.done, q.position, c.front, c.back, c.importance, c.source_page, c.image_path,
           pg.chapter AS chapter, sf.path AS file_path
    FROM daily_queue q
    JOIN card c ON c.id=q.card_id
    LEFT JOIN page pg ON pg.id = (
      SELECT p2.id FROM page p2 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
        AND p2.page_no = c.source_page
        AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
      ORDER BY p2.id LIMIT 1)
    LEFT JOIN source_file sf ON sf.id = pg.file_id
    WHERE q.course_id=? AND q.date=? AND q.round=?
    ORDER BY q.done, q.position`).all(courseId, date, round);

  // 章节兜底：页面里没有就从文件名找
  for (const r of rows) {
    if (r.chapter) continue;
    const fn = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
    const m = fn.match(/第[一二三四五六七八九十0-9]+[章节]/);
    r.chapter = m ? m[0] : fn.replace(/\.[^.]+$/, '').replace(/^[0-9０-９]+[-\s._、]*/, '').trim();
  }

  // 今天没排上的剩余新卡，用来提示"还有 N 张没刷"
  const left = db.prepare(`
    SELECT COUNT(*) n FROM card c LEFT JOIN card_state s ON s.card_id=c.id
    WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      AND COALESCE(s.state,'new')='new'
      AND c.id NOT IN (SELECT card_id FROM daily_queue WHERE course_id=? AND date=?)`)
    .get(courseId, courseId, date).n;

  // 每张卡挂了哪些机制图（翻卡时显示在释义下面）
  const ids = rows.map((r) => r.card_id);
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const rels = db.prepare(`
      SELECT cd.card_id, d.id, d.title FROM card_diagram cd
      JOIN diagram d ON d.id = cd.diagram_id
      WHERE cd.card_id IN (${marks}) ORDER BY cd.created_at`).all(...ids);
    const map = new Map();
    for (const r of rels) {
      if (!map.has(r.card_id)) map.set(r.card_id, []);
      map.get(r.card_id).push({ id: r.id, title: r.title });
    }
    for (const r of rows) r.diagrams = map.get(r.card_id) || [];
  }

  return { date, round, total: rows.length, done: rows.filter((r) => r.done).length, left, cards: rows };
}

// ---------- 路由表 ----------
const handlers = {
  'GET /api/bootstrap': () => {
    const courses = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM card WHERE course_id=c.id AND status='active') cards
      FROM course c ORDER BY c.created_at`).all();
    const out = courses.map((c) => {
      const q = queueState(c.id);
      return { ...c, today: { total: q.total, done: q.done } };
    });
    const professions = db.prepare('SELECT id, name FROM profession ORDER BY name').all();
    const prof = getProfile().profession || '兽医学';
    return { profile: getProfile(), courses: out, today: today(), professions, profession: prof };
  },

  // 切换专业方向（大分类：兽医 / 草业 …）
  'POST /api/profession': (_p, b) => {
    const name = String(b?.name || '').trim();
    if (!name) throw new Error('专业名不能为空');
    let prof = db.prepare('SELECT id FROM profession WHERE name=?').get(name);
    if (!prof) {
      prof = { id: uid('prof_') };
      db.prepare('INSERT INTO profession(id,name) VALUES(?,?)').run(prof.id, name);
    }
    setProfile('profession', name);
    return { ok: true, profession: name, id: prof.id };
  },

  'GET /api/course/:id': (p) => {
    const c = db.prepare('SELECT * FROM course WHERE id=?').get(p.id);
    if (!c) throw new Error('课程不存在');
    const cards = db.prepare("SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active'").get(p.id).n;
    // 理论课 / 实验课各多少张（按来源文件区分）
    const kinds = db.prepare(`
      SELECT COALESCE(sf.kind,'theory') k, COUNT(*) n
      FROM card c LEFT JOIN source_file sf ON sf.id=c.file_id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      GROUP BY k`).all(p.id);
    const kindCount = { theory: 0, lab: 0 };
    for (const r of kinds) kindCount[r.k] = r.n;
    return { course: { ...c, cards, kinds: kindCount }, queue: queueState(p.id) };
  },

  'POST /api/start/:id': (p) => {
    ensureQueue(p.id);
    return queueState(p.id);
  },

  'POST /api/review': (_p, b) => {
    const { cardId, rating, humanImportance = null, latencyMs = null, auto = 0 } = b || {};
    if (!cardId) throw new Error('缺少 cardId');
    const st = schedule(cardId, rating, auto);
    db.prepare('INSERT INTO review_log(card_id,ts,rating,auto,human_importance,latency_ms) VALUES(?,?,?,?,?,?)')
      .run(cardId, nowIso(), rating, auto ? 1 : 0, humanImportance, latencyMs);
    markQueueDone(cardId);
    if (humanImportance !== null) db.prepare('UPDATE card SET importance=? WHERE id=?').run(humanImportance, cardId);
    return { ok: true, state: st };
  },

  'POST /api/queue/extra/:id': (p, b) => {
    const r = extraRound(p.id, Number(b?.count) || 20);
    return { ok: true, ...r, queue: queueState(p.id) };
  },

  // 全局检索：跨课程找术语（Ctrl+K）
  'GET /api/search': (p) => {
    const q = String(p.query?.q || '').trim();
    if (!q) return { total: 0, hits: [] };
    const rows = db.prepare(`
      SELECT c.id, c.front, c.back, c.importance, c.source_page, co.name AS course, co.id AS course_id
      FROM card c JOIN course co ON co.id=c.course_id
      WHERE c.status='active' AND c.is_title=0 AND (c.front LIKE ? OR c.back LIKE ?)
      ORDER BY CASE WHEN c.front LIKE ? THEN 0 ELSE 1 END, c.importance DESC
      LIMIT 30`).all(`%${q}%`, `%${q}%`, `${q}%`);
    return { total: rows.length, hits: rows };
  },

  // ---- 批次管理：这门课导过哪些课件 ----
  'GET /api/batches/:id': (p) => {
    const rows = db.prepare(`
      SELECT sf.id, sf.path, sf.pages, sf.imported_at, COALESCE(sf.kind,'theory') kind,
             COALESCE(sf.doc_type,'ppt') doc_type,
             COALESCE(sf.active,1) active,
             (SELECT COUNT(*) FROM card c WHERE c.file_id=sf.id AND c.status='active' AND c.is_title=0) cards
      FROM source_file sf WHERE sf.course_id=? ORDER BY sf.imported_at`).all(p.id);
    return {
      total: rows.length,
      batches: rows.map((r) => ({ ...r, fileName: String(r.path).split(/[\\/]/).pop() })),
    };
  },
  'POST /api/batch/:id/remove': (p) => {
    const f = db.prepare('SELECT id, course_id FROM source_file WHERE id=?').get(p.id);
    if (!f) throw new Error('这一批不存在');
    db.prepare('UPDATE source_file SET active=0 WHERE id=?').run(p.id);
    const n = db.prepare("UPDATE card SET status='archived' WHERE file_id=? AND status='active'").run(p.id).changes;
    // 这批的卡从今日队列里撤掉，避免复习到已被移除的内容
    db.prepare(`DELETE FROM daily_queue WHERE card_id IN (SELECT id FROM card WHERE file_id=?)`).run(p.id);
    return { ok: true, archived: n };
  },
  // 局部重跑：删掉这一批的卡，按同样的文件重解析一遍
  'POST /api/batch/:id/reparse': (p) => {
    const f = db.prepare('SELECT * FROM source_file WHERE id=?').get(p.id);
    if (!f) throw new Error('这一批不存在');
    const c = db.prepare('SELECT name FROM course WHERE id=?').get(f.course_id);
    const job = startImport(f.path, c.name, f.kind || 'theory', f.doc_type || 'ppt', true);
    return { ok: true, job };
  },
  'POST /api/batch/:id/restore': (p) => {
    const f = db.prepare('SELECT id FROM source_file WHERE id=?').get(p.id);
    if (!f) throw new Error('这一批不存在');
    db.prepare('UPDATE source_file SET active=1 WHERE id=?').run(p.id);
    const n = db.prepare("UPDATE card SET status='active' WHERE file_id=? AND status='archived'").run(p.id).changes;
    return { ok: true, restored: n };
  },

  // ---- 考前抽检：全课随机抽，含已毕业的卡 ----
  'GET /api/spot/:id': (p) => {
    const n = Math.max(5, Math.min(100, Number(p.query?.n) || 15));
    const rows = db.prepare(`
      SELECT c.id, c.front, c.back, c.importance, c.source_page, COALESCE(s.state,'new') st
      FROM card c LEFT JOIN card_state s ON s.card_id=c.id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      ORDER BY RANDOM() LIMIT ?`).all(p.id, n);
    return { cards: rows, total: rows.length };
  },
  'GET /api/diagrams/:id': (p) => {
    // 按生成顺序排（先画的是最大的那一章，放最前面）
    const rows = db.prepare('SELECT id, title, created_at FROM diagram WHERE course_id=? ORDER BY created_at')
      .all(p.id);
    return { total: rows.length, diagrams: rows };
  },
  'POST /api/diagram/:id': (p, b) => {
    const xml = expandDrawio(String(b?.xml || ''));
    if (!xml.includes('<mxCell')) throw new Error('这不像是 draw.io 文件（没找到 mxCell）');
    const title = String(b?.title || '未命名机制图').slice(0, 60);
    const id = uid('dia_');
    db.prepare('INSERT INTO diagram(id,course_id,title,xml,created_at) VALUES(?,?,?,?,?)')
      .run(id, p.id, title, xml, nowIso());
    // 导进来就顺手把"节点文字对得上的卡片"挂上，省得一张张手动挂
    const linked = linkDiagramToCards(id, p.id, xml);
    return { ok: true, id, title, linked };
  },
  'GET /api/diagram/:id': (p) => {
    const d = db.prepare('SELECT * FROM diagram WHERE id=?').get(p.id);
    if (!d) throw new Error('机制图不存在');
    const xml = expandDrawio(d.xml);
    const nodes = parseDiagramNodes(xml);
    // 节点文字对得上哪张卡，就挂上 id —— 这就是"点名词跳卡片"
    // 比对时忽略空格、括号、顿号，避免"（筛选杂交瘤）"这种注解导致对不上
    const norm = (s) => String(s || '').replace(/[\s\u3000（）()·、，,。:：]/g, '');
    const cards = db.prepare("SELECT id, front FROM card WHERE course_id=? AND status='active'")
      .all(d.course_id);
    const byText = new Map(cards.map((c) => [norm(c.front), c.id]));
    // 先去掉括号里的注解再比对：'HAT 选择培养基（筛选杂交瘤）' → 'HAT选择培养基'
    const stripNote = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, '');
    for (const n of nodes) {
      n.cardId = byText.get(norm(stripNote(n.text))) || '';
    }
    return { diagram: { id: d.id, title: d.title, course_id: d.course_id }, nodes, edges: parseDiagramEdges(xml) };
  },
  'POST /api/diagram/:id/delete': (p) => {
    db.prepare('DELETE FROM diagram WHERE id=?').run(p.id);
    return { ok: true };
  },

  // AI 自动画机制图
  'POST /api/diagram-gen/:id': async (p, b) => {
    const { startDiagramGen } = await import('./ai.mjs');
    return { job: startDiagramGen(p.id, { chapter: b?.chapter || '', all: Boolean(b?.all) }) };
  },
  'GET /api/diagram-job/:id': async (p) => {
    const { getDiagramJob } = await import('./ai.mjs');
    return getDiagramJob(p.id);
  },
  // 这门课有哪些章节（画图时选）
  'GET /api/chapters/:id': (p) => {
    const rows = db.prepare(`
      SELECT sf.path AS file_path, pg.chapter, COUNT(*) n
      FROM card c
      LEFT JOIN page pg ON pg.id = (
        SELECT p2.id FROM page p2 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
          AND p2.page_no = c.source_page
          AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
        ORDER BY p2.id LIMIT 1)
      LEFT JOIN source_file sf ON sf.id = pg.file_id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      GROUP BY pg.chapter, sf.path`).all(p.id);
    const map = new Map();
    for (const r of rows) {
      const fn = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
      const m = fn.match(/第[一二三四五六七八九十0-9]+[章节]/);
      const name = r.chapter || (m ? m[0] : fn.replace(/\.[^.]+$/, '').replace(/^[0-9０-９]+[-\s._、]*/, '').trim());
      if (!name) continue;
      map.set(name, (map.get(name) || 0) + r.n);
    }
    return { chapters: [...map.entries()].map(([name, n]) => ({ name, n })) };
  },
  // ---- 别名合并：把一张卡并到另一张（同一个概念的不同叫法） ----
  'POST /api/card/:id/merge': (p, b) => {
    const intoId = String(b?.intoId || '');
    if (!intoId) throw new Error('要指定并到哪张卡');
    if (intoId === p.id) throw new Error('不能并到自己');
    const src = db.prepare('SELECT * FROM card WHERE id=?').get(p.id);
    const dst = db.prepare('SELECT * FROM card WHERE id=?').get(intoId);
    if (!src || !dst) throw new Error('卡片不存在');
    if (src.course_id !== dst.course_id) throw new Error('只能在同一门课里合并');

    // 原名记成别名，将来搜旧名还能找到
    const has = db.prepare('SELECT 1 FROM term WHERE concept_id=? AND text=?')
      .get(dst.concept_id, src.front);
    if (!has) {
      db.prepare('INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)')
        .run(dst.concept_id, src.front, 'alt', 'human');
    }
    // 关系一起搬过去
    const rels = db.prepare('SELECT id, from_concept, to_concept FROM relation WHERE from_concept=? OR to_concept=?')
      .all(src.concept_id, src.concept_id);
    for (const r of rels) {
      const from = r.from_concept === src.concept_id ? dst.concept_id : r.from_concept;
      const to = r.to_concept === src.concept_id ? dst.concept_id : r.to_concept;
      if (from === to) { db.prepare('DELETE FROM relation WHERE id=?').run(r.id); continue; }
      const dup = db.prepare('SELECT 1 FROM relation WHERE from_concept=? AND to_concept=? AND kind=(SELECT kind FROM relation WHERE id=?)')
        .get(from, to, r.id);
      if (dup) { db.prepare('DELETE FROM relation WHERE id=?').run(r.id); continue; }
      db.prepare('UPDATE relation SET from_concept=?, to_concept=? WHERE id=?').run(from, to, r.id);
    }
    // 重要度取高的，出处保留原卡页码
    const imp = Math.max(Number(src.importance) || 3, Number(dst.importance) || 3);
    db.prepare("UPDATE card SET importance=? WHERE id=?").run(imp, dst.id);
    db.prepare("UPDATE card SET status='merged' WHERE id=?").run(src.id);
    db.prepare('DELETE FROM daily_queue WHERE card_id=?').run(src.id);
    return { ok: true, into: dst.front, alias: src.front };
  },

  // ---- 待修队列：被标记「释义有误 / 图配错」的卡 ----
  'GET /api/broken/:id': (p) => {
    const rows = db.prepare(`
      SELECT id, front, back, source_page, image_path, origin FROM card
      WHERE course_id=? AND status='broken' ORDER BY source_page`).all(p.id);
    return { total: rows.length, cards: rows };
  },
  'POST /api/card/:id/restore': (p) => {
    db.prepare("UPDATE card SET status='active' WHERE id=?").run(p.id);
    db.prepare('INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?) ON CONFLICT(card_id) DO NOTHING')
      .run(p.id, 'new', nowIso());
    return { ok: true };
  },

  // ---- 图片查看器：这张图的前后邻居（翻页用） ----
  'GET /api/card/:id/images': (p) => {
    const c = db.prepare('SELECT id, course_id, source_page, image_path FROM card WHERE id=?').get(p.id);
    if (!c) throw new Error('卡片不存在');
    const rows = db.prepare(`
      SELECT id, front, image_path, source_page FROM card
      WHERE course_id=? AND status='active' AND image_path IS NOT NULL AND image_path <> ''
      ORDER BY source_page, id`).all(c.course_id);
    const i = rows.findIndex((r) => r.id === c.id);
    return {
      total: rows.length,
      index: i,
      current: c.image_path || '',
      prev: i > 0 ? rows[i - 1] : null,
      next: i >= 0 && i < rows.length - 1 ? rows[i + 1] : null,
      all: rows.map((r) => ({ id: r.id, front: r.front, image_path: r.image_path, page: r.source_page })),
    };
  },

  // ---- 卡片编辑器进阶：恢复原版 / 换图 / 关系增删 ----
  'POST /api/card/:id/revert': (p) => {
    const c = db.prepare('SELECT * FROM card WHERE id=?').get(p.id);
    if (!c) throw new Error('卡片不存在');
    if (!c.orig_front) throw new Error('这张卡没有保存原始版本');
    db.prepare('UPDATE card SET front=?, back=? WHERE id=?')
      .run(c.orig_front, c.orig_back || c.back, p.id);
    return { ok: true, front: c.orig_front, back: c.orig_back };
  },

  'POST /api/card/:id/image': (p, b) => {
    const c = db.prepare('SELECT * FROM card WHERE id=?').get(p.id);
    if (!c) throw new Error('卡片不存在');
    const src = String(b.path || '');
    if (!src || !existsSync(src)) throw new Error('找不到这个文件：' + src);
    const base = process.env.MIAOMIAO_DATA || join(ROOT, 'data');
    const dir = join(base, 'images', c.course_id);
    mkdirSync(dir, { recursive: true });
    const ext = (src.match(/\.[a-z0-9]+$/i) || ['.png'])[0].toLowerCase();
    const name = `card_${p.id}${ext}`;
    copyFileSync(src, join(dir, name));
    const rel = `images/${c.course_id}/${name}`;
    db.prepare('UPDATE card SET image_path=? WHERE id=?').run(rel, p.id);
    return { ok: true, image_path: rel };
  },

  'POST /api/card/:id/image-remove': (p) => {
    db.prepare('UPDATE card SET image_path=NULL WHERE id=?').run(p.id);
    return { ok: true };
  },

  'POST /api/relation/add': (p, b) => {
    const fromCard = String(b.from || '');
    const toCard = String(b.to || '');
    if (!fromCard || !toCard || fromCard === toCard) throw new Error('两端都要选，且不能是同一张卡');
    const cf = db.prepare('SELECT id, concept_id, course_id FROM card WHERE id=?').get(fromCard);
    const ct = db.prepare('SELECT id, concept_id, course_id FROM card WHERE id=?').get(toCard);
    if (!cf || !ct) throw new Error('卡片不存在');
    const dup = db.prepare(
      'SELECT id FROM relation WHERE (from_concept=? AND to_concept=?) OR (from_concept=? AND to_concept=?)'
    ).get(cf.concept_id, ct.concept_id, ct.concept_id, cf.concept_id);
    if (dup) throw new Error('这两个概念已经有关联了');
    const info = db.prepare('INSERT INTO relation(course_id,from_concept,to_concept,kind) VALUES(?,?,?,?)')
      .run(cf.course_id, cf.concept_id, ct.concept_id, 'manual');
    return { ok: true, id: Number(info.lastInsertRowid) };
  },

  'POST /api/relation/delete': (p, b) => {
    const id = Number(b.id);
    if (!Number.isFinite(id)) throw new Error('关系编号不对');
    db.prepare('DELETE FROM relation WHERE id=?').run(id);
    return { ok: true };
  },

  // ---- 导出：卡片清单（Markdown / CSV） ----
  'GET /api/export/cards/:id': (p) => {
    const fmt = p.query?.format === 'csv' ? 'csv' : 'md';
    const c = db.prepare('SELECT name FROM course WHERE id=?').get(p.id);
    const rows = db.prepare(`
      SELECT c.front, c.back, c.importance, c.source_page,
             pg.chapter AS ch, sf.path AS file_path
      FROM card c
      LEFT JOIN page pg ON pg.id = (
        SELECT p2.id FROM page p2 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
          AND p2.page_no = c.source_page
          AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
        ORDER BY p2.id LIMIT 1)
      LEFT JOIN source_file sf ON sf.id = pg.file_id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      ORDER BY c.source_page`).all(p.id).map((r) => {
        const fn = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
        const m = fn.match(/第[一二三四五六七八九十0-9]+[章节]/);
        const fallback = fn.replace(/\.[^.]+$/, '').replace(/^[0-9０-９]+[-\s._、]*/, '').trim();
        return { ...r, ch: r.ch || (m ? m[0] : fallback) || '未分章' };
      });
    const courseName = c ? c.name : '课程';
    if (fmt === 'csv') {
      const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
      const head = ['章节', '页码', '术语', '星级', '释义'].map(q).join(',');
      const body = rows.map((r) => [
        r.ch, r.source_page, r.front, r.importance, String(r.back || '').replace(/\n/g, ' '),
      ].map(q).join(','));
      return {
        filename: `${courseName}-卡片.csv`,
        mime: 'text/csv',
        text: '\ufeff' + [head, ...body].join('\n'),
      };
    }
    let md = `# ${courseName} · 知识卡\n\n`;
    let lastCh = '';
    for (const r of rows) {
      if (r.ch !== lastCh) { md += `\n## ${r.ch}\n\n`; lastCh = r.ch; }
      const star = '★'.repeat(Number(r.importance) || 3);
      md += `- **${r.front}**（${star}，第 ${r.source_page} 页）\n  ${String(r.back || '').replace(/\n/g, ' ')}\n`;
    }
    return { filename: `${courseName}-卡片.md`, mime: 'text/markdown', text: md };
  },

  // ---- 考试模式：定考试日期，倒推每天要刷多少 ----
  'GET /api/plan/:id': (p) => {
    const plan = db.prepare('SELECT * FROM course_plan WHERE course_id=?').get(p.id);
    const total = db.prepare(
      "SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0").get(p.id).n;
    const graduated = db.prepare(`
      SELECT COUNT(*) n FROM card c JOIN card_state s ON s.card_id=c.id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0 AND s.state='graduated'`).get(p.id).n;
    const fourStar = db.prepare(`
      SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0
        AND importance>=4 AND id NOT IN (SELECT card_id FROM card_state WHERE state='graduated')`).get(p.id).n;
    return { plan: plan || null, total, graduated, fourStar, today: today() };
  },
  'POST /api/plan/:id': (p, b) => {
    const examDate = String(b?.examDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) throw new Error('考试日期格式不对');
    const t = today();
    const days = Math.max(1, Math.round((new Date(examDate) - new Date(t)) / 86400000));
    const total = db.prepare(
      "SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0").get(p.id).n;
    const graduated = db.prepare(`
      SELECT COUNT(*) n FROM card c JOIN card_state s ON s.card_id=c.id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0 AND s.state='graduated'`).get(p.id).n;
    const remaining = Math.max(0, total - graduated);
    const newDays = Math.max(1, Math.round(days * 0.6));   // 留 40% 天数给复习与缓冲
    const perDay = Math.max(5, Math.ceil(remaining / newDays));
    db.prepare(`INSERT INTO course_plan(course_id,exam_date,daily_target,created_at) VALUES(?,?,?,?)
      ON CONFLICT(course_id) DO UPDATE SET exam_date=excluded.exam_date,
        daily_target=excluded.daily_target, created_at=excluded.created_at`)
      .run(p.id, examDate, perDay, nowIso());
    if (b?.apply) setProfile(`daily_new_${p.id}`, perDay);
    return { ok: true, days, remaining, perDay, newDays };
  },
  'POST /api/plan/:id/clear': (p) => {
    db.prepare('DELETE FROM course_plan WHERE course_id=?').run(p.id);
    return { ok: true };
  },

  // ---- 学习统计 ----
  'GET /api/stats/:id': (p) => {
    const days = [];
    for (let k = 6; k >= 0; k -= 1) {
      const d = new Date(Date.now() - k * 86400000);
      const iso = d.toISOString().slice(0, 10);
      days.push({
        date: iso,
        n: db.prepare(`
          SELECT COUNT(*) n FROM review_log l JOIN card c ON c.id=l.card_id
          WHERE c.course_id=? AND substr(l.ts,1,10)=?`).get(p.id, iso).n,
      });
    }
    const total = db.prepare(
      "SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active' AND is_title=0").get(p.id).n;
    const byState = db.prepare(`
      SELECT COALESCE(s.state,'new') st, COUNT(*) n FROM card c
      LEFT JOIN card_state s ON s.card_id=c.id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0 GROUP BY st`).all(p.id);
    const reviews = db.prepare(`
      SELECT COUNT(*) n, COALESCE(SUM(COALESCE(l.latency_ms,0)),0) ms
      FROM review_log l JOIN card c ON c.id=l.card_id WHERE c.course_id=?`).get(p.id);
    const chapters = db.prepare(`
      SELECT COALESCE(pg.chapter,'未分章') ch, COUNT(*) total,
             SUM(CASE WHEN s.state='graduated' THEN 1 ELSE 0 END) grad
      FROM card c
      LEFT JOIN card_state s ON s.card_id=c.id
      LEFT JOIN page pg ON pg.id = (
        SELECT p2.id FROM page p2 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
          AND p2.page_no = c.source_page
          AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
        ORDER BY p2.id LIMIT 1)
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      GROUP BY ch ORDER BY total DESC`).all(p.id);
    // 最近 7 天标『模糊』(rating=3) 的词
    const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const fuzzy = db.prepare(`
      SELECT c.id, c.front, c.source_page AS page, COUNT(*) AS times
      FROM review_log l JOIN card c ON c.id=l.card_id
      WHERE c.course_id=? AND l.rating=3 AND substr(l.ts,1,10) >= ?
      GROUP BY c.id ORDER BY times DESC, c.front LIMIT 40`).all(p.id, since);

    return { days, total, byState, reviews, chapters, fuzzy };
  },

  // ---- 待审队列：AI 复核刷掉的候选词 ----
  'GET /api/pending/:id': (p) => {
    const rows = db.prepare(
      'SELECT id, name, reason, page, created_at FROM rejected_term WHERE course_id=? ORDER BY created_at DESC LIMIT 200')
      .all(p.id);
    return { total: rows.length, items: rows };
  },
  'POST /api/pending/restore': (_p, b) => {
    const r = db.prepare('SELECT * FROM rejected_term WHERE id=?').get(b?.itemId);
    if (!r) throw new Error('这条不存在');
    const exists = db.prepare("SELECT id FROM card WHERE course_id=? AND front=? AND status='active'")
      .get(r.course_id, r.name);
    if (!exists) {
      const conceptId = uid('cp_');
      db.prepare('INSERT INTO concept(id,course_id,type,created_at) VALUES(?,?,?,?)')
        .run(conceptId, r.course_id, 'unknown', nowIso());
      db.prepare('INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)')
        .run(conceptId, r.name, 'preferred', 'human');
      const cardId = uid('card_');
      db.prepare(`INSERT INTO card(id,course_id,concept_id,front,back,image_path,source_page,source_text,
        importance,origin,status,is_title,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,'human','active',0,?)`)
        .run(cardId, r.course_id, conceptId, r.name, '（人工捞回，释义待补）', r.page || 1, '', 3, nowIso());
      db.prepare('INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?)')
        .run(cardId, 'new', nowIso());
    }
    db.prepare('DELETE FROM rejected_term WHERE id=?').run(r.id);
    return { ok: true };
  },
  'POST /api/pending/drop': (_p, b) => {
    db.prepare('DELETE FROM rejected_term WHERE id=?').run(b?.itemId);
    return { ok: true };
  },

  // ---- 模拟卷：配置 → 作答 → 交卷 ----
  'POST /api/exam/:id/start': (p, b) => {
    const n = Math.max(5, Math.min(100, Number(b?.n) || 20));
    const chapter = String(b?.chapter || '');
    const minutes = Math.max(0, Number(b?.minutes) || 0);
    let rows = db.prepare(`
      SELECT c.id, c.front, c.back, c.importance, c.source_page, c.image_path,
             pg.chapter AS chapter
      FROM card c
      LEFT JOIN page pg ON pg.id = (
        SELECT p2.id FROM page p2 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
          AND p2.page_no = c.source_page
          AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
        ORDER BY p2.id LIMIT 1)
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      ORDER BY RANDOM() LIMIT ?`).all(p.id, chapter ? 400 : n);
    if (chapter) {
      rows = rows.filter((r) => (r.chapter || '') === chapter).slice(0, n);
      rows = rows.sort(() => Math.random() - 0.5);
    }
    if (!rows.length) throw new Error('这门课还没有可考的卡片');
    const id = uid('exam_');
    db.prepare(`INSERT INTO exam_attempt(id,course_id,scope,total,right_count,minutes,used_sec,answers,created_at)
      VALUES(?,?,?,?,0,?,0,'[]',?)`).run(id, p.id, chapter || '整门课', rows.length, minutes, nowIso());
    return { attemptId: id, cards: rows, minutes, scope: chapter || '整门课' };
  },
  'POST /api/exam/answer': (_p, b) => {
    const { attemptId, cardId, correct } = b || {};
    if (!attemptId || !cardId) throw new Error('缺少参数');
    const a = db.prepare('SELECT answers FROM exam_attempt WHERE id=?').get(attemptId);
    if (!a) throw new Error('这次考试不存在');
    const list = JSON.parse(a.answers);
    if (!list.some((x) => x.cardId === cardId)) list.push({ cardId, correct: Boolean(correct) });
    db.prepare('UPDATE exam_attempt SET answers=? WHERE id=?').run(JSON.stringify(list), attemptId);
    return { ok: true };
  },
  'POST /api/exam/finish': (p, b) => {
    const { attemptId, minutes } = b || {};
    const a = db.prepare('SELECT * FROM exam_attempt WHERE id=?').get(attemptId);
    if (!a) throw new Error('这次考试不存在');
    const list = JSON.parse(a.answers);
    const right = list.filter((x) => x.correct).length;
    db.prepare('UPDATE exam_attempt SET right_count=?, used_sec=? WHERE id=?')
      .run(right, Number(minutes) * 60 || 0, attemptId);
    // 答错的打回队列（按"完全不记得"）
    for (const x of list.filter((y) => !y.correct)) schedule(x.cardId, 4, 1);
    const ids = list.map((x) => x.cardId);
    const cards = ids.length ? db.prepare(
      `SELECT id, front, back, source_page FROM card WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) : [];
    const byId = new Map(cards.map((c) => [c.id, c]));
    const detail = list.map((x) => ({ ...x, card: byId.get(x.cardId) || null }));
    return { ok: true, total: list.length, right, detail, attemptId };
  },
  'GET /api/exam-attempt/:id': (p) => {
    const a = db.prepare('SELECT * FROM exam_attempt WHERE id=?').get(p.id);
    if (!a) throw new Error('不存在');
    const list = JSON.parse(a.answers);
    const ids = list.map((x) => x.cardId);
    const cards = ids.length ? db.prepare(
      `SELECT id, front, back, source_page FROM card WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) : [];
    const byId = new Map(cards.map((c) => [c.id, c]));
    return { attempt: a, detail: list.map((x) => ({ ...x, card: byId.get(x.cardId) || null })) };
  },
  // 错题本：所有做错过的题（按最近一次找卡）
  'GET /api/wrong/:id': (p) => {
    const rows = db.prepare(`
      SELECT a.id AS attempt_id, a.created_at, a.answers
      FROM exam_attempt a WHERE a.course_id=? ORDER BY a.created_at DESC LIMIT 30`).all(p.id);
    const map = new Map();
    for (const a of rows) {
      for (const x of JSON.parse(a.answers)) {
        if (x.correct) continue;
        if (!map.has(x.cardId)) map.set(x.cardId, { cardId: x.cardId, last: a.created_at, times: 0, attemptId: a.id });
        map.get(x.cardId).times += 1;
      }
    }
    const ids = [...map.keys()];
    const cards = ids.length ? db.prepare(
      `SELECT id, front, back, source_page, status FROM card WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) : [];
    const out = cards.map((c) => ({ ...c, ...map.get(c.id) }));
    return { total: out.length, cards: out };
  },

  // 把一张卡塞进今天的队列（术语详情页的按钮）
  'POST /api/card/:id/queue': (p) => {
    const c = db.prepare('SELECT course_id FROM card WHERE id=?').get(p.id);
    if (!c) throw new Error('卡片不存在');
    const date = today();
    ensureQueue(c.course_id);
    const round = latestRound(c.course_id, date);
    const exists = db.prepare('SELECT 1 FROM daily_queue WHERE course_id=? AND date=? AND round=? AND card_id=?')
      .get(c.course_id, date, round, p.id);
    if (exists) return { ok: true, already: true };
    const maxPos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM daily_queue WHERE course_id=? AND date=? AND round=?')
      .get(c.course_id, date, round).p;
    db.prepare('INSERT INTO daily_queue(course_id,date,round,card_id,position) VALUES(?,?,?,?,?)')
      .run(c.course_id, date, round, p.id, maxPos + 1);
    return { ok: true };
  },
  // 这一页的原文（"查看原文"用，没有 PDF 阅读器就看这一页抽出来的文字）
  'GET /api/page-text/:id': (p) => {
    const c = db.prepare('SELECT course_id, source_page, file_id FROM card WHERE id=?').get(p.id);
    if (!c) throw new Error('卡片不存在');
    const row = db.prepare(`
      SELECT p.text, p.chapter, sf.path FROM page p JOIN source_file sf ON sf.id=p.file_id
      WHERE p.page_no=? AND sf.course_id=? AND (? IS NULL OR p.file_id=?)
      ORDER BY p.id LIMIT 1`).get(c.source_page, c.course_id, c.file_id, c.file_id);
    return {
      page: c.source_page,
      chapter: row?.chapter || '',
      fileName: row?.path ? String(row.path).split(/[\\/]/).pop() : '',
      text: row?.text || '',
    };
  },
  'GET /api/exam/:id': (p) => {
    const n = Math.max(5, Math.min(100, Number(p.query?.n) || 20));
    const rows = db.prepare(`
      SELECT c.id, c.front, c.back, c.importance, c.source_page, c.image_path, pg.chapter
      FROM card c
      LEFT JOIN page pg ON pg.id = (
        SELECT p2.id FROM page p2
        WHERE p2.file_id = COALESCE(c.file_id, p2.file_id) AND p2.page_no = c.source_page
          AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
        ORDER BY p2.id LIMIT 1)
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      ORDER BY RANDOM() LIMIT ?`).all(p.id, n);
    const course = db.prepare('SELECT name FROM course WHERE id=?').get(p.id);
    return { course: course?.name || '', cards: rows, total: rows.length };
  },
  'POST /api/exam/:id/result': (_p, b) => {
    const { cardId, correct } = b || {};
    if (!cardId) throw new Error('缺少 cardId');
    // 答对当"记得但没把握"（2），答错按"完全不会"（4）重置
    const st = schedule(cardId, correct ? 2 : 4, 1);
    db.prepare('INSERT INTO review_log(card_id,ts,rating,auto,human_importance,latency_ms) VALUES(?,?,?,?,?,?)')
      .run(cardId, nowIso(), correct ? 2 : 4, 1, null, null);
    return { ok: true, state: st };
  },

  'POST /api/card/:id/broken': (p) => {
    db.prepare("UPDATE card SET status='broken' WHERE id=?").run(p.id);
    db.prepare('INSERT INTO review_log(card_id,ts,rating,auto,human_importance,latency_ms) VALUES(?,?,?,?,?,?)')
      .run(p.id, nowIso(), -1, 0, null, null);
    markQueueDone(p.id);
    return { ok: true };
  },

  'GET /api/browse/:id': (p) => {
    const q = (p.query?.q || '').trim();
    const filter = p.query?.filter || 'all';
    let sql = `SELECT c.id,c.front,c.back,c.importance,c.source_page,c.status,c.image_path,
                      COALESCE(s.state,'new') st,
                      pg.chapter AS chapter, sf.path AS file_path,
                      (SELECT COUNT(*) FROM card_diagram cd WHERE cd.card_id=c.id) AS dia_count
               FROM card c
               LEFT JOIN card_state s ON s.card_id=c.id
               LEFT JOIN page pg ON pg.id = (
                 SELECT p2.id FROM page p2
                 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
                   AND p2.page_no = c.source_page
                   AND p2.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
                 ORDER BY p2.id LIMIT 1)
               LEFT JOIN source_file sf ON sf.id=pg.file_id
               WHERE c.course_id=? AND c.status='active' AND c.is_title=0`;
    const args = [p.id];
    const kind = p.query?.kind;
    if (kind === 'theory' || kind === 'lab') {
      sql += " AND COALESCE((SELECT kind FROM source_file WHERE id=c.file_id),'theory')=?";
      args.push(kind);
    }
    if (q) { sql += ' AND (c.front LIKE ? OR c.back LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    if (filter === 'weak') sql += " AND COALESCE(s.state,'new') IN ('learning','relearning')";
    if (filter === 'star4') sql += ' AND c.importance>=4';
    // 只看有图的：配了课件插图，或者挂了机制图
    if (filter === 'pic') {
      sql += ` AND (c.image_path IS NOT NULL AND c.image_path <> ''
                 OR EXISTS(SELECT 1 FROM card_diagram cd WHERE cd.card_id=c.id))`;
    }
    sql += ' ORDER BY c.source_page, c.importance DESC';
    const rows = db.prepare(sql).all(...args).map((r) => {
      const fileName = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
      return { ...r, fileName, chapter: chapterOf(fileName, r.chapter) };
    });
    const groups = {};
    for (const r of rows) (groups[r.source_page] ||= []).push(r);
    // "只看有图"按钮上显示的总数（不受当前筛选影响）
    const picCount = db.prepare(`
      SELECT COUNT(*) n FROM card c
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
        AND ((c.image_path IS NOT NULL AND c.image_path <> '')
             OR EXISTS(SELECT 1 FROM card_diagram cd WHERE cd.card_id=c.id))`)
      .get(p.id).n;
    return { total: rows.length, groups, cards: rows, picCount };
  },

  'GET /api/card/:id': (p) => {
    const c = db.prepare(`SELECT c.*, COALESCE(s.state,'new') st, s.due_at, s.streak_forgot, s.interval_days
                          FROM card c LEFT JOIN card_state s ON s.card_id=c.id WHERE c.id=?`).get(p.id);
    if (!c) throw new Error('卡片不存在');
    const src = db.prepare(`
      SELECT sf.path AS file_path, pg.chapter AS chapter
      FROM page pg JOIN source_file sf ON sf.id=pg.file_id
      WHERE pg.page_no=? AND sf.course_id=?
        AND (? IS NULL OR pg.file_id = ?)
      LIMIT 1`).get(c.source_page, c.course_id, c.file_id, c.file_id);
    const fileName = src && src.file_path ? String(src.file_path).split(/[\\/]/).pop() : '';
    const source = {
      page: c.source_page,
      chapter: chapterOf(fileName, src && src.chapter),
      fileName,
    };
    const rels = db.prepare(`
      SELECT r.id AS rel_id, r.kind, r.from_concept, r.to_concept,
             cf.front AS from_front, ct.front AS to_front, cf.id AS from_card, ct.id AS to_card
      FROM relation r
      LEFT JOIN concept cf2 ON cf2.id=r.from_concept
      LEFT JOIN concept ct2 ON ct2.id=r.to_concept
      LEFT JOIN card cf ON cf.concept_id=cf2.id
      LEFT JOIN card ct ON ct.concept_id=ct2.id
      WHERE r.from_concept=? OR r.to_concept=?`).all(c.concept_id, c.concept_id);
    const logs = db.prepare('SELECT ts,rating,auto FROM review_log WHERE card_id=? ORDER BY ts DESC LIMIT 5').all(p.id);
    const samePage = db.prepare('SELECT id,front,importance FROM card WHERE course_id=? AND source_page=? AND id<>? LIMIT 8')
      .all(c.course_id, c.source_page, p.id);
    // 这张卡配了哪些机制图（翻卡时显示在释义下面）
    const diagrams = db.prepare(`
      SELECT d.id, d.title FROM card_diagram cd JOIN diagram d ON d.id=cd.diagram_id
      WHERE cd.card_id=? ORDER BY cd.created_at`).all(p.id);
    return { card: c, relations: rels, logs, samePage, source, diagrams };
  },

  // 手动挂 / 摘机制图
  'POST /api/card/:id/diagram': (p, b) => {
    const did = String(b?.diagramId || '');
    if (!did) throw new Error('缺少 diagramId');
    db.prepare('INSERT OR IGNORE INTO card_diagram(card_id,diagram_id,created_at) VALUES(?,?,?)')
      .run(p.id, did, nowIso());
    return { ok: true };
  },
  'POST /api/card/:id/diagram-remove': (p, b) => {
    db.prepare('DELETE FROM card_diagram WHERE card_id=? AND diagram_id=?')
      .run(p.id, String(b?.diagramId || ''));
    return { ok: true };
  },

  'POST /api/card/:id': (p, b) => {
    const fields = [];
    const args = [];
    for (const k of ['front', 'back', 'image_path', 'importance']) {
      if (b?.[k] !== undefined) { fields.push(`${k}=?`); args.push(b[k]); }
    }
    if (!fields.length) return { ok: true };
    fields.push("origin='human'");
    args.push(p.id);
    db.prepare(`UPDATE card SET ${fields.join(',')} WHERE id=?`).run(...args);
    return { ok: true };
  },

  'GET /api/summary/:id': (p) => {
    const date = today();
    const rows = db.prepare(`
      SELECT l.rating, COUNT(*) n FROM daily_queue q
      JOIN review_log l ON l.card_id=q.card_id AND substr(l.ts,1,10)=?
      WHERE q.course_id=? AND q.date=? AND l.rating>0 GROUP BY l.rating`).all(date, p.id, date);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const r of rows) dist[r.rating] = r.n;

    // 今天标了「以后不用再考」的卡（结算页批量复核）
    const graduatedToday = db.prepare(`
      SELECT c.id, c.front FROM review_log l JOIN card c ON c.id=l.card_id
      WHERE c.course_id=? AND l.rating=1 AND substr(l.ts,1,10)=?
      ORDER BY l.ts DESC`).all(p.id, date);

    // 明天到期的复习量
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const dueTomorrow = db.prepare(`
      SELECT COUNT(*) n FROM card c JOIN card_state s ON s.card_id=c.id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
        AND s.due_at IS NOT NULL AND substr(s.due_at,1,10)=?`).get(p.id, tomorrow).n;

    // 连续学习天数（含今天，往回数）
    let streak = 0;
    for (let k = 0; k < 365; k += 1) {
      const d = new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
      const n = db.prepare(`
        SELECT COUNT(*) n FROM review_log l JOIN card c ON c.id=l.card_id
        WHERE c.course_id=? AND substr(l.ts,1,10)=?`).get(p.id, d).n;
      if (n > 0) streak += 1;
      else if (k > 0) break;
    }

    return {
      dist, total: Object.values(dist).reduce((a, b) => a + b, 0),
      date, graduatedToday, dueTomorrow, streak,
    };
  },

  // 高级：清空今天的队列
  'POST /api/queue/clear/:id': (p) => {
    const n = db.prepare('DELETE FROM daily_queue WHERE course_id=? AND date=?').run(p.id, today()).changes;
    return { ok: true, removed: n };
  },
  // 高级：设置页里跑自检
  'POST /api/selfcheck': async () => {
    const { runSelfCheck } = await import('../tools/selfcheck.mjs');
    const lines = await runSelfCheck(process.env.MIAOMIAO_DATA || '');
    return { lines };
  },

  'GET /api/settings': () => ({ profile: getProfile() }),
  'POST /api/settings': (_p, b) => {
    for (const [k, v] of Object.entries(b || {})) setProfile(k, v);
    return { ok: true, profile: getProfile() };
  },

  // 新建专业时让 AI 现编提示词
  'POST /api/profession/hint': async (_p, b) => {
    const name = String(b?.name || '').trim();
    if (!name) throw new Error('专业名不能为空');
    const { genProfessionHint, saveProfessionHint } = await import('./ai.mjs');
    const data = await genProfessionHint(name);
    saveProfessionHint(name, data);
    return { ok: true, name, ...data };
  },
  'GET /api/profession/hint': async (p) => {
    const { getProfessionHint } = await import('./ai.mjs');
    return { hint: getProfessionHint(p.query?.name || getProfile().profession || '兽医学') };
  },
  'GET /api/professions': () => db.prepare('SELECT id, name, term_hint FROM profession ORDER BY name').all(),

  'GET /api/courses': () => db.prepare('SELECT * FROM course ORDER BY created_at').all(),

  // 新建学科（先建空课程，再往里导课件）
  'POST /api/course': (_p, b) => {
    const name = String(b?.name || '').trim();
    if (!name) throw new Error('学科名不能为空');
    const exists = db.prepare('SELECT id FROM course WHERE name=?').get(name);
    if (exists) throw new Error('已经有同名学科了');
    const profName = String(b?.profession || '兽医学').trim() || '兽医学';
    let prof = db.prepare('SELECT id FROM profession WHERE name=?').get(profName);
    if (!prof) {
      prof = { id: uid('prof_') };
      db.prepare('INSERT INTO profession(id,name) VALUES(?,?)').run(prof.id, profName);
    }
    const id = uid('course_');
    db.prepare('INSERT INTO course(id,profession_id,name,mode,state,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, prof.id, name, b?.mode === 'calc' ? 'calc' : 'concept', 'active', nowIso());
    return { ok: true, id, name };
  },

  // ---- AI 配置与精修 ----
  'GET /api/ai/config': async () => {
    const { getAiConfig, maskKey } = await import('./ai.mjs');
    const c = getAiConfig();
    return { baseUrl: c.baseUrl, model: c.model, hasKey: Boolean(c.apiKey), keyMask: maskKey(c.apiKey),
      pagesPerRequest: c.pagesPerRequest };
  },
  'POST /api/ai/config': async (_p, b) => {
    const { saveAiConfig, maskKey } = await import('./ai.mjs');
    const c = saveAiConfig(b || {});
    return { ok: true, baseUrl: c.baseUrl, model: c.model, hasKey: Boolean(c.apiKey), keyMask: maskKey(c.apiKey) };
  },
  'GET /api/ai/balance': async (p) => {
    const { fetchBalance, getUsageSummary } = await import('./ai.mjs');
    const bal = await fetchBalance(p.query?.force === '1');
    return { ...bal, usage: getUsageSummary() };
  },

  'POST /api/ai/test': async () => {
    const { testConnection } = await import('./ai.mjs');
    return testConnection();
  },
  'POST /api/refine/:id': async (p) => {
    const { startRefine } = await import('./ai.mjs');
    return { job: startRefine(p.id) };
  },
  'GET /api/refine-job/:id': async (p) => {
    const { getRefineJob } = await import('./ai.mjs');
    return getRefineJob(p.id);
  },

  // 一键复习清单
  'POST /api/outline/:id': async (p) => {
    const { startOutline } = await import('./ai.mjs');
    return { job: startOutline(p.id) };
  },
  'GET /api/outline-job/:id': async (p) => {
    const { getOutlineJob } = await import('./ai.mjs');
    return getOutlineJob(p.id);
  },
  'GET /api/outline/:id': async (p) => {
    const { getSavedOutline } = await import('./ai.mjs');
    return getSavedOutline(p.id);
  },

  // 把清单导出成 Markdown 文件（存在 data/outlines/ 下）
  'POST /api/outline-save': async (_p, b) => {
    const { getSavedOutline } = await import('./ai.mjs');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const o = getSavedOutline(b?.courseId);
    if (!o.content) throw new Error('还没有清单可以导出');
    const dataDir = process.env.MIAOMIAO_DATA || join(process.cwd(), 'data');
    const dir = join(dataDir, 'outlines');
    mkdirSync(dir, { recursive: true });
    const safe = String(b?.name || '复习清单').replace(/[\\/:*?"<>|]/g, '_');
    const stamp = new Date().toISOString().slice(0, 10);
    const file = join(dir, `${safe}-考前清单-${stamp}.md`);
    writeFileSync(file, o.content, 'utf8');
    return { ok: true, path: file };
  },

  // 关系图：章 → 页 → 术语（章节名从"第一节/第二章"这类行识别，真实结构，不猜）
  'GET /api/graph/:id': (p) => {
    const rows = db.prepare(`
      SELECT c.id, c.front, c.importance, c.source_page, c.is_title, p.chapter
      FROM card c
      LEFT JOIN page p ON p.page_no = c.source_page
        AND p.file_id IN (SELECT id FROM source_file WHERE course_id = c.course_id)
      WHERE c.course_id = ? AND c.status = 'active'
      ORDER BY c.source_page, c.importance DESC`).all(p.id);

    const chapters = [];
    const byName = new Map();
    for (const r of rows) {
      // 认不出章节就按每 10 页一组，保证任何课件都能成树
      let name = r.chapter;
      if (!name) {
        const start = Math.floor((r.source_page - 1) / 10) * 10 + 1;
        name = `第 ${start}–${start + 9} 页`;
      }
      let ch = byName.get(name);
      if (!ch) { ch = { name, pages: [], count: 0 }; byName.set(name, ch); chapters.push(ch); }
      let pg = ch.pages.find((x) => x.page === r.source_page);
      if (!pg) { pg = { page: r.source_page, cards: [] }; ch.pages.push(pg); }
      pg.cards.push({ id: r.id, front: r.front, importance: r.importance, is_title: r.is_title });
      ch.count += 1;
    }
    const edges = db.prepare(`
      SELECT cf.id AS from_id, cf.front AS from_front, ct.id AS to_id, ct.front AS to_front, r.kind
      FROM relation r
      JOIN concept a ON a.id=r.from_concept JOIN card cf ON cf.concept_id=a.id
      JOIN concept b ON b.id=r.to_concept JOIN card ct ON ct.concept_id=b.id
      WHERE r.course_id=?`).all(p.id);
    return { chapters, edges, totalCards: rows.length };
  },
};

export function callApi(method, rawPath, body = {}) {
  const [pathOnly, search = ''] = String(rawPath).split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const key of Object.keys(handlers)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const hit = rx.exec(pathOnly);
    if (!hit) continue;
    const params = { id: '', query };
    names.forEach((n, i) => { params[n] = decodeURIComponent(hit[i + 1]); });
    return handlers[key](params, body);
  }
  throw new Error(`没有这个接口: ${method} ${pathOnly}`);
}

// ---------- 导入（调用 python 解析，无 AI） ----------
// 解析课件用的 Python：优先用随程序打包的内置运行环境（同学不用装 Python）
const BUNDLED_PY = join(ROOT, 'runtime', 'python', 'python.exe');
function pythonExe() {
  try {
    if (existsSync(BUNDLED_PY)) return BUNDLED_PY;
  } catch { /* 忽略 */ }
  return 'python';
}

const jobs = new Map();

export function startImport(filePath, courseName, kind = 'theory', docType = 'ppt', reparse = false) {
  const id = uid('job_');
  const job = { id, status: 'running', log: '', result: null };
  jobs.set(id, job);
  const py = spawn(pythonExe(), [join(ROOT, 'tools', 'ingest.py'),
    '--file', filePath, '--course-name', courseName, '--kind', kind, '--doc-type', docType,
    ...(reparse ? ['--reparse'] : [])], {
    cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  py.stdout.on('data', (d) => { job.log += d.toString(); });
  py.stderr.on('data', (d) => { job.log += d.toString(); });
  py.on('error', (e) => { job.status = 'failed'; job.log += String(e.message); });
  py.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    try { job.result = JSON.parse(job.log.trim().split('\n').pop()); } catch { /* noop */ }
  });
  return job.id;
}

// 导入前探测：页数/图片数/字数，用来做时长与费用预估
export function probeImport(filePath) {
  return new Promise((resolve, reject) => {
    const py = spawn(pythonExe(), [join(ROOT, 'tools', 'ingest.py'), '--file', filePath, '--course-name', 'probe', '--probe'], {
      cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    py.stdout.on('data', (d) => { out += d.toString(); });
    py.stderr.on('data', (d) => { out += d.toString(); });
    py.on('error', (e) => reject(e));
    py.on('close', (code) => {
      try {
        const line = out.trim().split('\n').filter(Boolean).pop();
        const j = JSON.parse(line);
        if (j.probe) resolve(j); else reject(new Error(out.slice(0, 200)));
      } catch { reject(new Error('探测失败：' + out.slice(0, 200))); }
    });
  });
}

export function getJob(id) {
  return jobs.get(id) || { status: 'unknown' };
}
