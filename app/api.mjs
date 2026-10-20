// api.mjs —— 所有业务逻辑都在这里，服务端和桌面端共用同一份。
// server.mjs（网页版）调 callApi；electron/main.mjs（桌面版）也调 callApi。

import { spawn } from 'node:child_process';
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

  const picked = [
    ...fresh.slice(0, p.daily_new_max),
    ...due.slice(0, p.daily_review_max),
  ];
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
    SELECT q.card_id, q.done, q.position, c.front, c.back, c.importance, c.source_page, c.image_path
    FROM daily_queue q JOIN card c ON c.id=q.card_id
    WHERE q.course_id=? AND q.date=? AND q.round=?
    ORDER BY q.done, q.position`).all(courseId, date, round);

  // 今天没排上的剩余新卡，用来提示"还有 N 张没刷"
  const left = db.prepare(`
    SELECT COUNT(*) n FROM card c LEFT JOIN card_state s ON s.card_id=c.id
    WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      AND COALESCE(s.state,'new')='new'
      AND c.id NOT IN (SELECT card_id FROM daily_queue WHERE course_id=? AND date=?)`)
    .get(courseId, courseId, date).n;

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
    return { profile: getProfile(), courses: out, today: today() };
  },

  'GET /api/course/:id': (p) => {
    const c = db.prepare('SELECT * FROM course WHERE id=?').get(p.id);
    if (!c) throw new Error('课程不存在');
    const cards = db.prepare("SELECT COUNT(*) n FROM card WHERE course_id=? AND status='active'").get(p.id).n;
    return { course: { ...c, cards }, queue: queueState(p.id) };
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

  // ---- 考试模式：随机抽 N 张，答完给分 ----
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
                      pg.chapter AS chapter, sf.path AS file_path
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
    if (q) { sql += ' AND (c.front LIKE ? OR c.back LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    if (filter === 'weak') sql += " AND COALESCE(s.state,'new') IN ('learning','relearning')";
    if (filter === 'star4') sql += ' AND c.importance>=4';
    sql += ' ORDER BY c.source_page, c.importance DESC';
    const rows = db.prepare(sql).all(...args).map((r) => {
      const fileName = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
      return { ...r, fileName, chapter: chapterOf(fileName, r.chapter) };
    });
    const groups = {};
    for (const r of rows) (groups[r.source_page] ||= []).push(r);
    return { total: rows.length, groups, cards: rows };
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
      SELECT r.kind, r.from_concept, r.to_concept,
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
    return { card: c, relations: rels, logs, samePage, source };
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
    return { dist, total: Object.values(dist).reduce((a, b) => a + b, 0), date };
  },

  'GET /api/settings': () => ({ profile: getProfile() }),
  'POST /api/settings': (_p, b) => {
    for (const [k, v] of Object.entries(b || {})) setProfile(k, v);
    return { ok: true, profile: getProfile() };
  },

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
const jobs = new Map();

export function startImport(filePath, courseName) {
  const id = uid('job_');
  const job = { id, status: 'running', log: '', result: null };
  jobs.set(id, job);
  const py = spawn('python', [join(ROOT, 'tools', 'ingest.py'), '--file', filePath, '--course-name', courseName], {
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

export function getJob(id) {
  return jobs.get(id) || { status: 'unknown' };
}
