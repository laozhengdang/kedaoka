import { db } from '../app/db.mjs';
import { readFileSync } from 'node:fs';

// 清掉测试图，只留一张正式的
db.prepare('DELETE FROM diagram').run();
const c = db.prepare("SELECT id FROM course WHERE name='免疫学'").get();
const svg = readFileSync('data/diagrams/免疫学-单抗制备流程.drawio.svg', 'utf8');
db.prepare('INSERT INTO diagram(id,course_id,title,xml,created_at) VALUES(?,?,?,?,?)')
  .run('dia_demo', c.id, '单抗制备流程', svg, new Date().toISOString());
console.log('已重建，剩余图:', db.prepare('SELECT id,title FROM diagram').all());
