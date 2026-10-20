// db.mjs —— 数据库：建表 + 迁移 + 常用操作
// 用 Node 24 内置的 node:sqlite，不需要编译任何原生模块。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 数据目录：打包后可被 MIAOMIAO_DATA 指到 exe 旁边；开发时在仓库的 data/
const DATA_DIR = process.env.MIAOMIAO_DATA || join(HERE, '..', 'data');
export const DB_PATH = join(DATA_DIR, 'db', 'app.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 轻量迁移：老库里缺的列，启动时补上（不改动已有数据）
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS profession (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course (
  id TEXT PRIMARY KEY,
  profession_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'concept',
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_file (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  pages INTEGER NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  page_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  has_formula INTEGER NOT NULL DEFAULT 0,
  chapter TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_file ON page(file_id, page_no);

-- 一个概念只有一个首选词，其他是别名（SKOS 式，见文档 24.3）
CREATE TABLE IF NOT EXISTS concept (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS term (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'preferred',
  origin TEXT NOT NULL DEFAULT 'ppt'
);
CREATE INDEX IF NOT EXISTS idx_term_text ON term(text);
CREATE INDEX IF NOT EXISTS idx_term_concept ON term(concept_id);

CREATE TABLE IF NOT EXISTS card (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  image_path TEXT,
  source_page INTEGER,
  source_text TEXT,
  importance INTEGER NOT NULL DEFAULT 3,
  origin TEXT NOT NULL DEFAULT 'ppt',
  status TEXT NOT NULL DEFAULT 'active',
  is_title INTEGER NOT NULL DEFAULT 0,
  file_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_course ON card(course_id);

CREATE TABLE IF NOT EXISTS card_state (
  card_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'new',
  interval_days REAL NOT NULL DEFAULT 0,
  due_at TEXT,
  streak_forgot INTEGER NOT NULL DEFAULT 0,
  leech INTEGER NOT NULL DEFAULT 0,
  last_rating INTEGER,
  last_review_at TEXT,
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  rating INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  human_importance INTEGER,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_log_card ON review_log(card_id, ts);

CREATE TABLE IF NOT EXISTS relation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  from_concept TEXT NOT NULL,
  to_concept TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cause'
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relation(from_concept);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relation(to_concept);

CREATE TABLE IF NOT EXISTS daily_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL,
  date TEXT NOT NULL,
  card_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  UNIQUE(course_id, date, card_id)
);

-- 机制图：存 .drawio 的原始 XML，应用自己渲染（节点可点，跳卡片）
CREATE TABLE IF NOT EXISTS diagram (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  xml TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 卡片 ↔ 机制图：一张图可以服务多个概念，一个概念也可以配多张图
CREATE TABLE IF NOT EXISTS card_diagram (
  card_id TEXT NOT NULL,
  diagram_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, diagram_id)
);

-- P-1 学习偏好：全局，跨课程
CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT);
`;

db.exec(SCHEMA);
ensureColumn('card', 'file_id', 'file_id TEXT');
ensureColumn('source_file', 'kind', "kind TEXT NOT NULL DEFAULT 'theory'");
// 批次管理：移除某一批课件时把 active 置 0，不删数据（可恢复）
ensureColumn('source_file', 'active', 'active INTEGER NOT NULL DEFAULT 1');
// 每个专业可以有自己的"术语范围"提示词（AI 生成，存在 profession.term_hint）
ensureColumn('profession', 'term_hint', 'term_hint TEXT');

// 队列支持"再来一轮"：给 daily_queue 加 round，并把唯一约束改成四列
if (!db.prepare('PRAGMA table_info(daily_queue)').all().map((c) => c.name).includes('round')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_queue_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT NOT NULL,
      date TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      card_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      UNIQUE(course_id, date, round, card_id)
    );
    INSERT OR IGNORE INTO daily_queue_v2(course_id,date,round,card_id,position,done)
      SELECT course_id,date,0,card_id,position,done FROM daily_queue;
    DROP TABLE daily_queue;
    ALTER TABLE daily_queue_v2 RENAME TO daily_queue;
  `);
}

export const DEFAULT_PROFILE = {
  daily_new_max: 10,
  daily_review_max: 5,
  new_card_quota: { text: 7, image: 3 },
  review_time: '20:00',
  show_week: true,
  show_progress: true,
  show_streak: true,
  theme_accent: '#003399',
  splash: true,
};

export function getProfile() {
  const rows = db.prepare('SELECT key, value FROM profile').all();
  const out = { ...DEFAULT_PROFILE };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

export function setProfile(key, value) {
  db.prepare('INSERT INTO profile(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

// 学习日的分界不是午夜，而是凌晨 4 点（学生经常刷到半夜）
export const DAY_START_HOUR = 4;

export function today(now = new Date()) {
  const d = new Date(now.getTime() - DAY_START_HOUR * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = '') {
  return prefix + crypto.randomUUID().slice(0, 8);
}
