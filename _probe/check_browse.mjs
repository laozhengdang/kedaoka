import { callApi } from '../app/api.mjs';

const b = callApi('GET', '/api/bootstrap');
const c = b.courses.find((x) => x.name === '药理学');
const r = callApi('GET', '/api/browse/' + c.id);
console.log('仓库总数', r.total);
for (const x of r.cards.slice(0, 8)) {
  console.log(`  ${x.front}  →  chapter=${JSON.stringify(x.chapter)}  p${x.source_page}  file=${x.fileName}`);
}
const origins = {};
for (const x of r.cards) origins[x.status] = (origins[x.status] || 0) + 1;
console.log('状态分布', origins);
