// server.mjs —— 本地服务：静态文件 + JSON API
// 零依赖：只用 Node 内置模块。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, getProfile, setProfile, today, nowIso, uid,
} from './db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const ROOT = join(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// ---------- 排程（简化版 SM-2，见文档 D19 / D13） ----------
function schedule(cardId, rating, auto = 0) {
  const row = db.prepare('SELECT * FROM card_state WHERE card_id=?').get(cardId)
    || { state: 'new', interval_days: 0, streak_forgot: 0, leech: 0 };
  let { interval_days: iv, streak_forgot: sf, leech } = row;
  let state = row.state;

  if (rating === 1) {                 // 记得·不再考 → 毕业
    state = 'graduated';
    iv = 0;
  } else if (rating === 2) {          // 记得
    state = 'review';
    iv = iv <= 0 ? 1 : Math.min(180, iv * 2.5);
    sf = 0;
  } else if (rating === 3) {          // 模糊：基本不动
    state = 'learning';
    iv = iv <= 0 ? 0.5 : Math.max(0.5, iv * 1.2);
    sf += 1;
    if (sf >= 2) leech = 1;
  } else {                            // 完全不记得：重置
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

function ensureQueue(courseId) {
  const date = today();
  const has = db.prepare('SELECT COUNT(*) n FROM daily_queue WHERE course_id=? AND date=?')
    .get(courseId, date).n;
  if (has > 0) return;

  const p = getProfile();
  const all = db.prepare(`
    SELECT c.id, c.importance, COALESCE(s.state,'new') st, s.due_at, s.last_review_at
    FROM card c LEFT JOIN card_state s ON s.card_id=c.id
    WHERE c.course_id=? AND c.status='active'`).all(courseId);

  const now = nowIso();
  const fresh = all.filter((c) => c.st === 'new' || c.st === 'learning')
    .sort((a, b) => b.importance - a.importance);
  // 到期复习卡：graduated 的 30 天抽检也放进来
  const due = all.filter((c) => c.st !== 'new' && c.due_at && c.due_at <= now)
    .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));

  const picked = [
    ...fresh.slice(0, p.daily_new_max),
    ...due.slice(0, p.daily_review_max),
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO daily_queue(course_id,date,card_id,position) VALUES(?,?,?,?)');
  picked.forEach((c, i) => ins.run(courseId, date, c.id, i));
}

function queueState(courseId) {
  const date = today();
  ensureQueue(courseId);
  const rows = db.prepare(`
    SELECT q.card_id, q.done, q.position, c.front, c.back, c.importance, c.source_page, c.image_path
    FROM daily_queue q JOIN card c ON c.id=q.card_id
    WHERE q.course_id=? AND q.date=?
    ORDER BY q.done, q.position`).all(courseId, date);
  const done = rows.filter((r) => r.done).length;
  return { date, total: rows.length, done, cards: rows };
}

// ---------- API ----------
const api = {
  'GET /api/bootstrap': () => {
    const courses = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM card WHERE course_id=c.id AND status='active') cards
      FROM course c ORDER BY c.created_at`).all();
    const out = courses.map((c) => {
      const q = queueState(c.id);
      const dates = db.prepare(
        'SELECT DISTINCT date FROM daily_queue WHERE course_id=? AND done=1 ORDER BY date DESC').all(c.id);
      return { ...c, today: { total: q.total, done: q.done }, days: dates.length };
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
    const st = schedule(cardId, rating, auto);
    db.prepare('INSERT INTO review_log(card_id,ts,rating,auto,human_importance,latency_ms) VALUES(?,?,?,?,?,?)')
      .run(cardId, nowIso(), rating, auto ? 1 : 0, humanImportance, latencyMs);
    db.prepare('UPDATE daily_queue SET done=1 WHERE card_id=? AND date=?').run(cardId, today());
    if (humanImportance !== null) {
      db.prepare('UPDATE card SET importance=? WHERE id=?').run(humanImportance, cardId);
    }
    return { ok: true, state: st };
  },

  'POST /api/card/:id/broken': (p, b) => {
    db.prepare("UPDATE card SET status='broken' WHERE id=?").run(p.id);
    db.prepare('INSERT INTO review_log(card_id,ts,rating,auto,human_importance,latency_ms) VALUES(?,?,?,?,?,?)')
      .run(p.id, nowIso(), -1, 0, null, null);
    db.prepare('UPDATE daily_queue SET done=1 WHERE card_id=? AND date=?').run(p.id, today());
    return { ok: true };
  },

  'GET /api/browse/:id': (p) => {
    const q = (p.query.q || '').trim();
    const filter = p.query.filter || 'all';
    let sql = `SELECT c.id,c.front,c.back,c.importance,c.source_page,c.status,
                      COALESCE(s.state,'new') st, s.due_at
               FROM card c LEFT JOIN card_state s ON s.card_id=c.id
               WHERE c.course_id=?`;
    const args = [p.id];
    if (q) { sql += ' AND (c.front LIKE ? OR c.back LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    if (filter === 'weak') sql += " AND COALESCE(s.state,'new') IN ('learning','relearning')";
    if (filter === 'star4') sql += ' AND c.importance>=4';
    sql += ' ORDER BY c.source_page, c.importance DESC';
    const rows = db.prepare(sql).all(...args);
    const byPage = {};
    for (const r of rows) {
      (byPage[r.source_page] ||= []).push(r);
    }
    return { total: rows.length, groups: byPage, cards: rows };
  },

  'GET /api/card/:id': (p) => {
    const c = db.prepare(`SELECT c.*, COALESCE(s.state,'new') st, s.due_at, s.streak_forgot, s.interval_days
                          FROM card c LEFT JOIN card_state s ON s.card_id=c.id WHERE c.id=?`).get(p.id);
    if (!c) throw new Error('卡片不存在');
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
    return { card: c, relations: rels, logs, samePage };
  },

  'POST /api/card/:id': (p, b) => {
    const fields = [];
    const args = [];
    for (const k of ['front', 'back', 'image_path', 'importance']) {
      if (b[k] !== undefined) { fields.push(`${k}=?`); args.push(b[k]); }
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
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    return { dist, total, date };
  },

  'GET /api/settings': () => ({ profile: getProfile() }),
  'POST /api/settings': (p, b) => {
    for (const [k, v] of Object.entries(b || {})) setProfile(k, v);
    return { ok: true, profile: getProfile() };
  },

  'GET /api/courses': () => db.prepare('SELECT * FROM course ORDER BY created_at').all(),
};

// ---------- 导入（调用 python 解析，无 AI） ----------
const jobs = new Map();
function startImport(filePath, courseName) {
  const id = uid('job_');
  const job = { id, status: 'running', log: '', result: null };
  jobs.set(id, job);
  const py = spawn('python', [join(ROOT, 'tools', 'ingest.py'), '--file', filePath, '--course-name', courseName], {
    cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  py.stdout.on('data', (d) => { job.log += d.toString(); });
  py.stderr.on('data', (d) => { job.log += d.toString(); });
  py.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    try { job.result = JSON.parse(job.log.trim().split('\n').pop()); } catch { /* noop */ }
  });
  return job;
}

// ---------- 路由 ----------
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    try {
      if (path === '/api/import' && req.method === 'POST') {
        const b = await readBody(req);
        const job = startImport(b.file, b.courseName);
        res.writeHead(200, { 'content-type': MIME['.json'] });
        return res.end(JSON.stringify({ job: job.id }));
      }
      if (path.startsWith('/api/job/')) {
        const job = jobs.get(path.slice('/api/job/'.length));
        res.writeHead(200, { 'content-type': MIME['.json'] });
        return res.end(JSON.stringify(job || { status: 'unknown' }));
      }

      const method = req.method;
      let matched = null;
      for (const key of Object.keys(api)) {
        const [m, pattern] = key.split(' ');
        if (m !== method) continue;
        const names = [];
        const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
        const hit = rx.exec(path);
        if (hit) {
          const params = { id: '' };
          names.forEach((n, i) => { params[n] = hit[i + 1]; });
          params.query = Object.fromEntries(url.searchParams);
          matched = { handler: api[key], params };
          break;
        }
      }
      if (!matched) {
        res.writeHead(404, { 'content-type': MIME['.json'] });
        return res.end(JSON.stringify({ error: 'no such api' }));
      }
      const body = method === 'POST' ? await readBody(req) : {};
      const out = await matched.handler(matched.params, body);
      res.writeHead(200, { 'content-type': MIME['.json'] });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'content-type': MIME['.json'] });
      return res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
  }

  // 静态文件
  const rel = path === '/' ? '/index.html' : path;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403); return res.end('forbidden');
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

const PORT = Number(process.env.PORT || 5173);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  老郑荡的妙妙小工具 已启动`);
  console.log(`  http://127.0.0.1:${PORT}\n`);
});
