import { db } from '../app/db.mjs';

const c = db.prepare("select id from course where name='免疫学'").get();
console.log('queue 记录:');
for (const r of db.prepare(
  "select date, count(*) as n, sum(done) as done from daily_queue where course_id=? group by date order by date desc limit 8"
).all(c.id)) console.log('  ', r.date, '共', r.n, '完成', r.done);

console.log('card_state 分布:');
for (const r of db.prepare(`
  select coalesce(s.state,'none') st, count(*) n from card c
  left join card_state s on s.card_id=c.id
  where c.course_id=? and c.status='active' and c.is_title=0 group by st`).all(c.id)) {
  console.log('  ', r.st, r.n);
}

console.log('今天:', new Date().toString().slice(0, 24));
console.log('最近复习记录:');
for (const r of db.prepare(`
  select l.ts, l.rating, c.front from review_log l join card c on c.id=l.card_id
  where c.course_id=? order by l.ts desc limit 5`).all(c.id)) {
  console.log('  ', r.ts, r.rating, r.front);
}
