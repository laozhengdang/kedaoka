import { db } from '../app/db.mjs';

const c = db.prepare("select id, name from course where name='药理学'").get();
const files = db.prepare('select path, pages, sha256 from source_file where course_id=?').all(c.id);
console.log('文件数:', files.length);
for (const f of files) {
  console.log('  ', f.path.split(/[\\/]/).pop(), '|', f.pages, '页 |', f.sha256.slice(0, 10));
}
const n = db.prepare("select count(*) as n from card where course_id=? and status='active'").get(c.id).n;
console.log('active 卡数:', n);

const dup = db.prepare(
  "select front, count(*) as n from card where course_id=? and status='active' group by front having n>1"
).all(c.id);
console.log('同名重复:', dup.length ? dup : '无');

// 页面级重复：同一页号来自两份文件
const pages = db.prepare(`
  select pg.page_no, count(*) as n from page pg
  join source_file sf on sf.id=pg.file_id
  where sf.course_id=? group by pg.page_no having n>1 limit 5`).all(c.id);
console.log('同页号来自多份文件:', pages.length ? pages : '无');
