import { db } from '../app/db.mjs';
import { callApi } from '../app/api.mjs';

// 同名只留最新
const rows = db.prepare('SELECT id, title, created_at FROM diagram ORDER BY created_at').all();
const seen = new Map();
for (const r of rows) {
  if (seen.has(r.title)) {
    db.prepare('DELETE FROM diagram WHERE id=?').run(r.id);
    db.prepare('DELETE FROM card_diagram WHERE diagram_id=?').run(r.id);
    console.log('删除重复:', r.title);
  } else seen.set(r.title, r.id);
}

const courses = db.prepare('SELECT id, name FROM course').all();
for (const c of courses) {
  const list = callApi('GET', '/api/diagrams/' + c.id);
  console.log(`\n【${c.name}】${list.total} 张`);
  for (const d of list.diagrams) {
    const g = callApi('GET', '/api/diagram/' + d.id);
    const linked = g.nodes.filter((n) => n.cardId).length;
    console.log(`  ${d.title}：${g.nodes.length} 节点 / ${g.edges.length} 关系 / ${linked} 可点`);
    console.log('    ' + g.nodes.map((n) => n.text).join('、'));
  }
}
