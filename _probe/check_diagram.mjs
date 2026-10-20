import { readFileSync } from 'node:fs';
import { callApi } from '../app/api.mjs';

const b = callApi('GET', '/api/bootstrap');
const c = b.courses.find((x) => x.name === '免疫学');

// 用刚才从 draw.io 导出的 .drawio.svg（压缩格式）测试能不能读
const svg = readFileSync('data/diagrams/免疫学-单抗制备流程.drawio.svg', 'utf8');
const r = await callApi('POST', '/api/diagram/' + c.id, { xml: svg, title: '单抗制备流程（draw.io 导出）' });
console.log('导入:', r.ok, r.id);

const g = callApi('GET', '/api/diagram/' + r.id);
console.log('节点数:', g.nodes.length, '连线数:', g.edges.length);
for (const n of g.nodes) {
  console.log(`  ${n.text}  @(${n.x},${n.y}) ${n.w}x${n.h}  ${n.cardId ? '→ 可点卡片' : ''}`);
}
console.log('连线:', g.edges.map((e) => `${e.source}->${e.target}`).join(', '));
