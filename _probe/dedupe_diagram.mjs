import { db } from '../app/db.mjs';

const rows = db.prepare('SELECT id, title, created_at FROM diagram ORDER BY created_at').all();
console.log('现有:', rows.map((r) => r.title).join(' | '));

// 同名只留最新一张
const seen = new Map();
for (const r of rows) {
  if (seen.has(r.title)) {
    db.prepare('DELETE FROM diagram WHERE id=?').run(r.id);
    db.prepare('DELETE FROM card_diagram WHERE diagram_id=?').run(r.id);
    console.log('删除重复:', r.id, r.title);
  } else {
    seen.set(r.title, r.id);
  }
}
console.log('剩余:', db.prepare('SELECT title FROM diagram').all().map((r) => r.title));
