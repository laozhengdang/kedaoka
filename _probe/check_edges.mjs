import { db } from '../app/db.mjs';
import { callApi } from '../app/api.mjs';

const c = db.prepare("SELECT id FROM course WHERE name='药理学'").get();
const list = callApi('GET', '/api/diagrams/' + c.id);
for (const d of list.diagrams) {
  const g = callApi('GET', '/api/diagram/' + d.id);
  console.log(d.title, '节点', g.nodes.length, '边', g.edges.length);
  console.log('  前3边:', JSON.stringify(g.edges.slice(0, 3)));
  console.log('  前3节点id:', g.nodes.slice(0, 3).map((n) => n.id + ':' + n.text).join(' | '));
  const xml = db.prepare('SELECT xml FROM diagram WHERE id=?').get(d.id).xml;
  console.log('  XML 片段:', xml.slice(xml.indexOf('edge="1"') - 60, xml.indexOf('edge="1"') + 80));
}
