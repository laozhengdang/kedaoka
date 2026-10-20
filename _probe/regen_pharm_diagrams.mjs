import { db } from '../app/db.mjs';
import { callApi } from '../app/api.mjs';

// 清掉药理学那两张方向反了的图，重新生成
const c = db.prepare("SELECT id FROM course WHERE name='药理学'").get();
const olds = db.prepare('SELECT id, title FROM diagram WHERE course_id=?').all(c.id);
for (const o of olds) {
  db.prepare('DELETE FROM diagram WHERE id=?').run(o.id);
  db.prepare('DELETE FROM card_diagram WHERE diagram_id=?').run(o.id);
  console.log('删除旧图:', o.title);
}

const t0 = Date.now();
const { job } = await callApi('POST', '/api/diagram-gen/' + c.id, { all: true });
let j;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  j = await callApi('GET', '/api/diagram-job/' + job);
  if (j.status !== 'running') break;
}
console.log('重画:', j.status, '| 张数', j.made, '| 挂卡', j.created, '|', Math.round((Date.now() - t0) / 1000) + 's');
for (const line of j.log || []) console.log('  ' + line);

for (const d of callApi('GET', '/api/diagrams/' + c.id).diagrams) {
  const g = callApi('GET', '/api/diagram/' + d.id);
  const hasIn = new Set(g.edges.map((e) => e.to));
  const roots = g.nodes.filter((n) => !hasIn.has(n.id)).map((n) => n.text);
  console.log(`\n${d.title}`);
  console.log('  起点:', roots.join('、'));
}
