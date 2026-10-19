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
  has_formula INTEGER NOT NULL DEFAULT 0
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

-- P-1 学习偏好：全局，跨课程
CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT);
`;

db.exec(SCHEMA);

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

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = '') {
  return prefix + crypto.randomUUID().slice(0, 8);
}
