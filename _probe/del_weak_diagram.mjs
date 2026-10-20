import { db } from '../app/db.mjs';

const rows = db.prepare("SELECT id, title FROM diagram WHERE title LIKE '%仙鹤草%'").all();
for (const r of rows) {
  db.prepare('DELETE FROM diagram WHERE id=?').run(r.id);
  db.prepare('DELETE FROM card_diagram WHERE diagram_id=?').run(r.id);
  console.log('已删除弱图:', r.title);
}
console.log('剩余:');
for (const r of db.prepare('SELECT c.name AS course, d.title FROM diagram d JOIN course c ON c.id=d.course_id ORDER BY c.name').all()) {
  console.log('  ', r.course, '|', r.title);
}
