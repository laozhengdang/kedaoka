// ai.mjs —— 接大模型：配置、调用、把逐页原文变成"术语 + 定义 + 关系"
//
// 设计要点（对应文档 D61 / D82）：
//   - 只支持 OpenAI 兼容的 /chat/completions，DeepSeek / Kimi / 智谱 / OpenAI 都能填
//   - 严格 JSON 输出，解析失败只重试一次，仍失败就丢弃这一批（不许瞎猜）
//   - 同样的输入有缓存（request_hash → response），重跑不重复花钱
//   - 'mock' 是完全离线的假提供商，用来在没有 key 时验证整条链路

import { createHash } from 'node:crypto';
import { db, getProfile, setProfile, uid, nowIso } from './db.mjs';
import { linkDiagramToCards } from './api.mjs';

// ---------------- 配置 ----------------
export function getAiConfig() {
  const p = getProfile();
  return {
    baseUrl: p.ai_base_url || 'https://api.deepseek.com/v1',
    model: p.ai_model || 'deepseek-chat',
    apiKey: p.ai_api_key || '',
    pagesPerRequest: Number(p.ai_pages_per_request) || 3,
    review: p.ai_review !== false,
  };
}

export function saveAiConfig(cfg) {
  if (cfg.baseUrl !== undefined) setProfile('ai_base_url', String(cfg.baseUrl).trim());
  if (cfg.model !== undefined) setProfile('ai_model', String(cfg.model).trim());
  if (cfg.apiKey !== undefined) setProfile('ai_api_key', String(cfg.apiKey).trim());
  if (cfg.pagesPerRequest !== undefined) setProfile('ai_pages_per_request', Number(cfg.pagesPerRequest) || 3);
  return getAiConfig();
}

export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ---------------- 缓存 ----------------
db.exec(`CREATE TABLE IF NOT EXISTS ai_cache (
  request_hash TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  model TEXT,
  ts TEXT NOT NULL
)`);

function cacheGet(hash) {
  const r = db.prepare('SELECT response FROM ai_cache WHERE request_hash=?').get(hash);
  return r ? r.response : null;
}

function cachePut(hash, text, model) {
  db.prepare('INSERT OR REPLACE INTO ai_cache(request_hash,response,model,ts) VALUES(?,?,?,?)')
    .run(hash, text, model, nowIso());
}

// ---------------- 调用 ----------------
async function chat(cfg, messages, { maxTokens = 2000, temperature = 0.1 } = {}) {
  if (cfg.baseUrl === 'mock') return { text: mockReply(messages), cached: false };

  const hash = createHash('sha256')
    .update(JSON.stringify({ baseUrl: cfg.baseUrl, model: cfg.model, messages, maxTokens, temperature }))
    .digest('hex');
  const hit = cacheGet(hash);
  if (hit) return { text: hit, cached: true };

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content ?? '';
  if (text) cachePut(hash, text, cfg.model);
  recordUsage(j?.usage);
  return { text, cached: false, usage: j?.usage };
}

// 测试连接：发一句极短的请求
export async function testConnection() {
  const cfg = getAiConfig();
  if (cfg.baseUrl !== 'mock' && !cfg.apiKey) throw new Error('还没填 API Key');
  const { text, cached } = await chat(cfg, [
    { role: 'system', content: '你是一个简洁的助手，只输出 JSON。' },
    { role: 'user', content: '回复 {"ok":true}' },
  ], { maxTokens: 50 });
  return { ok: true, cached, sample: text.slice(0, 80), model: cfg.model, baseUrl: cfg.baseUrl };
}

// ---------------- 余额查询 ----------------
// DeepSeek 有官方接口 GET /user/balance；其它 OpenAI 兼容家的余额一般要走网页登录态，
// 拿 API Key 查不到，所以那些就直接说"不支持"。
let balanceCache = { at: 0, data: null };

export async function fetchBalance(force = false) {
  const cfg = getAiConfig();
  if (!cfg.apiKey) return { supported: false, reason: '还没填 API Key' };
  if (Date.now() - balanceCache.at < 60_000 && !force && balanceCache.data) return balanceCache.data;

  const base = cfg.baseUrl.replace(/\/$/, '');
  if (!/deepseek/i.test(base)) {
    return {
      supported: false,
      reason: '这个接口不提供余额查询（DeepSeek 才能查）',
      baseUrl: cfg.baseUrl,
    };
  }
  const root = base.replace(/\/v1$/, '');
  const res = await fetch(`${root}/user/balance`, {
    headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`查余额失败 ${res.status}：${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const info = (j.balance_infos || [])[0] || {};
  const data = {
    supported: true,
    available: Boolean(j.is_available),
    currency: info.currency || 'CNY',
    total: Number(info.total_balance || 0),
    granted: Number(info.granted_balance || 0),
    topped: Number(info.topped_up_balance || 0),
    at: new Date().toISOString(),
  };
  balanceCache = { at: Date.now(), data };
  return data;
}

// 记录每次调用的 token 用量（估算花销用，不影响主流程）
db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
  date TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date)
)`);

function recordUsage(usage) {
  if (!usage) return;
  const d = new Date().toISOString().slice(0, 10);
  try {
    db.prepare(`INSERT INTO ai_usage(date,calls,prompt_tokens,completion_tokens) VALUES(?,1,?,?)
      ON CONFLICT(date) DO UPDATE SET calls=calls+1,
        prompt_tokens=prompt_tokens+excluded.prompt_tokens,
        completion_tokens=completion_tokens+excluded.completion_tokens`)
      .run(d, Number(usage.prompt_tokens || 0), Number(usage.completion_tokens || 0));
  } catch { /* 记不上就算了 */ }
}

export function getUsageSummary() {
  const d = new Date().toISOString().slice(0, 10);
  const today = db.prepare('SELECT * FROM ai_usage WHERE date=?').get(d) || { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  const all = db.prepare('SELECT COALESCE(SUM(calls),0) c, COALESCE(SUM(prompt_tokens+completion_tokens),0) t FROM ai_usage').get();
  return { today, all };
}
// 专业方向会改变提示词：兽医学/草业/动科 各自举的例子不一样，
// 否则模型会把"动物医学"的常识硬套到草业课上。
const MAJOR_HINT = {
  兽医学: '疾病、病变、药物、免疫、病原、诊断',
  草业科学: '牧草、草地、放牧、刈割、分蘖、粗蛋白、干草调制、草地退化、载畜量',
  动物科学: '饲料、营养、消化率、料肉比、日增重、繁殖、育种、畜舍环境',
  动物医学: '疾病、病变、药物、免疫、病原、诊断',
};

function majorName() {
  const p = getProfile().profession || '兽医学';
  return String(p);
}

// 优先用专业自己在库里存的提示词（AI 生成），没有就退回内置表
function majorHint() {
  const name = majorName();
  try {
    const row = db.prepare('SELECT term_hint FROM profession WHERE name=?').get(name);
    if (row && row.term_hint) {
      const parsed = JSON.parse(row.term_hint);
      if (parsed && parsed.hint) return parsed.hint;
    }
  } catch { /* 读不到就用内置的 */ }
  return MAJOR_HINT[name] || `该专业（${name}）考试常考的核心概念`;
}

// 新建专业时，让 AI 现编一套"该抽什么术语"的判断依据
export async function genProfessionHint(name) {
  const cfg = getAiConfig();
  if (cfg.baseUrl !== 'mock' && !cfg.apiKey) throw new Error('还没配置 API Key，先去设置里填');
  const sys = `你是中国农业大学的教学顾问。用户要新建一个专业方向："${name}"。
请写出这个专业的课件里"哪些词算专业术语、考试会考"的判断依据，供 AI 抽取复习卡片时使用。

要求：
- hint：一句话，列出这个专业考试常考的概念类别，用顿号隔开，不超过 60 字
- examples：6~10 个该专业真实会出现的术语例子（不要编造生僻词）
- avoid：3~5 类在这个专业里不算术语的常见干扰项

只输出 JSON：
{"hint":"","examples":[],"avoid":[]}`;
  const { text } = await chat(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: `专业名称：${name}` },
  ], { maxTokens: 600 });
  const parsed = parseJson(text);
  if (!parsed || !parsed.hint) throw new Error('AI 没给出可用的提示词，再试一次');
  return {
    hint: String(parsed.hint).slice(0, 200),
    examples: Array.isArray(parsed.examples) ? parsed.examples.slice(0, 10) : [],
    avoid: Array.isArray(parsed.avoid) ? parsed.avoid.slice(0, 6) : [],
  };
}

export function saveProfessionHint(name, data) {
  const row = db.prepare('SELECT id FROM profession WHERE name=?').get(name);
  const json = JSON.stringify(data);
  if (row) {
    db.prepare('UPDATE profession SET term_hint=? WHERE id=?').run(json, row.id);
    return row.id;
  }
  const id = uid('prof_');
  db.prepare('INSERT INTO profession(id,name,term_hint) VALUES(?,?,?)').run(id, name, json);
  return id;
}

export function getProfessionHint(name) {
  const row = db.prepare('SELECT term_hint FROM profession WHERE name=?').get(name);
  if (!row || !row.term_hint) return null;
  try { return JSON.parse(row.term_hint); } catch { return null; }
}

const SYSTEM = () => `你是中国农业大学${majorName()}专业的助教，负责把课件原文整理成"能考"的复习卡片。
本课程属于${majorName()}，判断"是不是术语"时请以${majorHint()}这类概念为准，不要套用别的专业。
只输出 JSON，不要解释，不要 Markdown 代码块。

【抽什么】
只抽"考试会问到的名词性概念"：术语、细胞、器官、物质、机制/过程名、疾病、病变、指标。
每页最多抽 5 个，宁缺毋滥。

【绝对不要抽】
- 章节标题："第一章""第一节""主要内容""本章要点""实验目的""思考题"
- 表格的纯表头："起效时间""持续时间""抗酸强度""半衰期"
- 带"的"的操作短语："抗原物质的鉴别、定位、分析和提纯""抗血清的分离与保存""多抗的纯化与标记"
- 带顿号或逗号的拼接列表（术语名里不允许出现"、"或"，"）
- 整句话、页码、人名、书名

【要抽的（容易漏）】
- 作用/功能类的词：祛痰作用、缓泻作用、制酵作用、健胃作用、收敛作用 —— 这些就是考点

【名字要求】
必须是原文里**完整出现**的词，不能多字也不能少字：原文是"克隆"就不能写成"为克隆"。
去掉序号、项目符号、括号里的英文；纯英文缩写可以保留。

【定义要求】
- 1~2 句中文，用原文措辞，不超过 80 字。
- **原文这一页没讲清它的含义，就不要抽这个术语**（不是让你写"课件未详述"，而是直接不抽）。
- 定义里不要出现"本页讲了""如图所示"这类空话。

【字段】
name, type（entity|process|disease|lesion|attribute）, definition, importance（1~5 整数）,
aliases（原文出现的别名/英文/缩写，数组）, page（页码）

importance 判断标准：老师标红/加粗、反复出现、出现在考点清单、是本章核心概念 → 4~5；
一般性名词 → 3；只在举例里提一句 → 1~2。

【关系】
只有原文明确写了"A 包括/分为 B、C"或"A 导致 B"才输出，kind 只能是
contains | prerequisite | contrast | ordered_steps。没有就空数组。

{"terms":[{"name":"","type":"","definition":"","importance":3,"aliases":[],"page":1}],
 "relations":[{"from":"","to":"","kind":"contains"}]}`;

function buildUserPrompt(chunks) {
  const parts = chunks.map((c) => `【第 ${c.page_no ?? c.page} 页】\n${String(c.text || '').slice(0, 1800)}`);
  return `课件原文如下（可能跨页）：\n\n${parts.join('\n\n')}\n\n请按系统提示输出 JSON。`;
}

function parseJson(text) {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
    }
    return null;
  }
}

// 离线假数据：用来在没有 key 的情况下验证整条链路
function mockReply(messages) {
  const user = messages.find((m) => m.role === 'user')?.content || '';
  const pages = [...user.matchAll(/【第 (\d+) 页】\n([\s\S]*?)(?=【第 \d+ 页】|$)/g)];
  const terms = [];
  for (const m of pages) {
    const pno = Number(m[1]);
    const text = m[2];
    // 只在 mock 里做极简抽取：取中文短句片段当"术语"
    const cands = [...text.matchAll(/[\u4e00-\u9fff]{3,8}/g)].slice(0, 2);
    for (const c of cands) {
      terms.push({
        name: c[0], type: 'entity',
        definition: `（mock）第 ${pno} 页出现的概念。`,
        importance: 3, aliases: [], page: pno,
      });
    }
  }
  return JSON.stringify({ terms, relations: [] });
}

// ---------------- 复核（第二道工序） ----------------
// 抽取是"宁多勿漏"的初筛，复核是"把它当考试判卷"：
// 逐条判断是不是专业术语、要不要留、名字该叫什么。
const REVIEW_SYSTEM = () => `你是${majorName()}专业的出题老师，正在审核一份"复习术语清单"。
这门课属于${majorName()}，判断"会不会考"时以${majorHint()}这类内容为准。
清单是一段课件里的候选词。请逐条判断：**这个词，考试会不会考**？会考就留。

【留（keep=true）——只要考试问得出来就留】
- 药物作用：祛痰作用、缓泻作用、制酵作用、健胃作用、收敛作用、抑菌作用…（这就是药理考点，必须留）
- 药理分类：H2受体阻断药、质子泵抑制药、M1胆碱受体阻断药、抗酸药…
- 药名：通用名、常用商品名（雷尼替丁、奥美拉唑、思密达…）
- 病理变化、疾病、病变、指标、性质：效价、特异性、亲和力、碱储、反跳现象…
- 细胞、器官、物质、机制、过程、细胞系、培养基

【删（keep=false）——只删这些】
- 章节/小节标题：第一章、第二节、主要内容、本章要点、思考题、实验目的、小结、概述
- **表格的纯列名/行名**：起效时间、持续时间、抗酸强度、半衰期 这类只作为表格表头存在的词
- **带"的"的操作短语**：抗血清的分离与保存、单抗的类及亚类鉴定、多抗的纯化与标记
- 句子碎片/半截词：为克隆、简称、称为、建立、局限性、见病症、可继
- 人名、书名、文件名、页眉页脚、页码

【特别注意，别误删】
- 以"作用"结尾的词**不要**因为"听起来太泛"就删。祛痰作用、缓泻作用、收敛作用都是要考的知识点。
- 只有当它**完全脱离语境**、单独出现且没有任何修饰时（"作用""方法""不良反应"）才删。
- 宁可多留一个可用的词，也不要误删一个考点。

另外给 canonical：如果这个词是错字/多字/少字（例如"为克隆"应为"克隆"），给出正确写法；
本来就对就填原词。

只输出 JSON：
{"verdicts":[{"name":"原词","canonical":"规范写法","keep":true,"reason":"不超过15字的理由"}]}`;

async function reviewTerms(cfg, terms, chunks) {
  if (!terms.length) return terms;
  const pageBits = chunks.map((c) => `【第 ${c.page_no ?? c.page} 页】${String(c.text || '').slice(0, 500)}`).join('\n');
  const list = terms.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
  const { text } = await chat(cfg, [
    { role: 'system', content: REVIEW_SYSTEM() },
    { role: 'user', content: `候选词：\n${list}\n\n它们出自这些页：\n${pageBits}\n\n请输出 JSON。` },
  ], { maxTokens: 1500, temperature: 0 });
  const parsed = parseJson(text);
  if (!parsed || !Array.isArray(parsed.verdicts)) return terms;   // 复核失败就退回初筛结果
  const byName = new Map();
  for (const v of parsed.verdicts) byName.set(normalizeName(v.name), v);
  const out = [];
  const dropped = [];
  for (const t of terms) {
    const v = byName.get(normalizeName(t.name));
    if (!v) { out.push(t); continue; }               // 没判到的保留（保守）
    if (v.keep === false) { dropped.push({ name: t.name, reason: v.reason || '复核删除', page: t.page || 0 }); continue; }
    const canon = normalizeName(v.canonical || '');
    out.push({ ...t, name: canon && canon !== normalizeName(t.name) ? canon : t.name,
      aliases: [...(t.aliases || []), ...(canon && canon !== normalizeName(t.name) ? [t.name] : [])] });
  }
  return { kept: out, dropped };
}

// ---------------- 复习清单（一键生成） ----------------
db.exec(`CREATE TABLE IF NOT EXISTS outline (
  course_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);

const outlineJobs = new Map();

export function getOutlineJob(id) {
  return outlineJobs.get(id) || { status: 'unknown' };
}

export function getSavedOutline(courseId) {
  const r = db.prepare('SELECT content, created_at FROM outline WHERE course_id=?').get(courseId);
  return r ? { content: r.content, createdAt: r.created_at } : { content: '', createdAt: '' };
}

const OUTLINE_SYSTEM = () => `你是${majorName()}专业的助教，正在给学生写"考前必备清单"。
这门课属于${majorName()}，组织术语的先后顺序请按${majorHint()}的逻辑来。
给你一门课的全部术语（按章节分组，每个词后面是课件里的解释）。
请写一份可以直接打印背的复习清单，要求：

1. 按章节顺序组织，用"## 第X章 / 章节名"做小标题。
2. 每章下面用列表列出该章所有术语：**术语**：一句话解释（可压缩原文，但不能改变意思）。
3. 每章末尾加一行"本章逻辑"：用一两句话把这一章的术语串起来（谁导致谁、谁包括谁、先做什么后做什么）。
4. 全文最后加"## 融会贯通"：用 5~10 句话把整门课主线讲一遍，明确哪些是前置、哪些并列、哪些容易混淆。
5. 只输出 Markdown 正文，不写客套话，不编造清单里没有的术语。`;

export function startOutline(courseId) {
  const id = uid('outline_');
  const job = { id, status: 'running', log: [], content: '', error: '' };
  outlineJobs.set(id, job);
  (async () => {
    const cfg = getAiConfig();
    if (cfg.baseUrl !== 'mock' && !cfg.apiKey) throw new Error('还没配置 API Key');
    const rows = db.prepare(`
      SELECT c.front, c.back, c.importance, c.source_page, pg.chapter, sf.path AS file_path
      FROM card c
      LEFT JOIN page pg ON pg.page_no=c.source_page
        AND pg.file_id IN (SELECT id FROM source_file WHERE course_id=c.course_id)
      LEFT JOIN source_file sf ON sf.id=pg.file_id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      ORDER BY c.source_page`).all(courseId);
    if (!rows.length) throw new Error('这门课还没有卡片，先导入并整理');

    const byChapter = new Map();
    for (const r of rows) {
      const fn = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
      const m = fn.match(/第[一二三四五六七八九十0-9]+[章节]/);
      const fallback = fn.replace(/\.[^.]+$/, '').replace(/^[0-9０-９]+[-\s._、]*/, '').trim().slice(0, 24);
      const ch = r.chapter || (m ? m[0] : fallback) || '未分章';
      if (!byChapter.has(ch)) byChapter.set(ch, []);
      byChapter.get(ch).push(r);
    }
    job.log.push(`共 ${rows.length} 个术语，分 ${byChapter.size} 章`);
    let text = '';
    for (const [ch, list] of byChapter) {
      text += `## 章：${ch}\n`;
      for (const r of list) text += `- ${r.front}：${(r.back || '').slice(0, 110)}\n`;
      text += '\n';
    }
    const { text: out } = await chatText(cfg, [
      { role: 'system', content: OUTLINE_SYSTEM() },
      { role: 'user', content: text.slice(0, 24000) },
    ], { maxTokens: 4000 });
    job.content = out;
    db.prepare('INSERT OR REPLACE INTO outline(course_id,content,created_at) VALUES(?,?,?)')
      .run(courseId, out, nowIso());
    job.status = 'done';
    job.log.push('清单已生成');
  })().catch((e) => {
    job.status = 'failed';
    job.error = String((e && e.message) || e);
    job.log.push('失败：' + job.error);
  });
  return id;
}

// 不走 JSON 模式的普通文本调用
async function chatText(cfg, messages, { maxTokens = 2000, temperature = 0.3 } = {}) {
  if (cfg.baseUrl === 'mock') {
    return { text: '# （mock）复习清单\n\n## 第 1 章\n- 示例术语：示例解释\n' };
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  recordUsage(j?.usage);
  return { text: j?.choices?.[0]?.message?.content || '' };
}

// ---------------- AI 自动画机制图 ----------------
const diagramJobs = new Map();

export function getDiagramJob(id) {
  return diagramJobs.get(id) || { status: 'unknown' };
}

const DIAGRAM_SYSTEM = () => `你是${majorName()}专业的助教，要把一章的知识点画成一张"机制图"，让学生一眼看懂它们怎么串起来。

给你的是一章里的概念清单和它们的解释。请挑出 8~14 个**彼此有逻辑关系**的概念，排出流程图。

关系只允许这几种走向：
- 因果（A 导致 B）、流程（先 A 后 B）、构成（A 包括 B）、并列对比（A 与 B 对立）

规则：
- 只能用清单里出现的概念名，不要自己造词，不要改写名字
- **箭头方向统一表示"导致 / 进而"**：疾病、病因、生理过程放上游（图的上方），
  药物、治疗手段、结果放下游（图的下方）。不要把"X 药治疗 Y 病"画成 药→病，
  要写成 Y 病（靶点）→ X 药 的"干预"关系
- **要画出链条，不要画成"一个中心发散出去的火柴棍"**：
  每层最好 2~4 个概念，允许一条链走 3~5 层（A→B→C→D）
- 一个概念直接连出去的下游**不超过 4 个**；如果确实有很多后果，
  挑出最能代表"下一步"的那 3~4 个
- 不要画出环（A→B→A）
- 概念少于 8 个就全用上，不要硬凑

只输出 JSON：
{"title":"不超过12字的图名","nodes":[{"label":"概念名"}],
 "edges":[{"from":"概念名","to":"概念名","kind":"cause|flow|contain|contrast"}]}`;

export function startDiagramGen(courseId, opts = {}) {
  const id = uid('dgen_');
  const job = { id, status: 'running', log: [], created: 0, made: 0, error: '', title: '', diagramId: '' };
  diagramJobs.set(id, job);
  (async () => {
    const cfg = getAiConfig();
    if (cfg.baseUrl !== 'mock' && !cfg.apiKey) throw new Error('还没配置 API Key');

    const rows = db.prepare(`
      SELECT c.front, c.back, c.source_page, sf.path AS file_path, pg.chapter
      FROM card c
      LEFT JOIN page pg ON pg.id = (
        SELECT p2.id FROM page p2 WHERE p2.file_id = COALESCE(c.file_id, p2.file_id)
          AND p2.page_no = c.source_page
          AND p2.file_id IN (SELECT id FROM source_file WHERE course_id = c.course_id)
        ORDER BY p2.id LIMIT 1)
      LEFT JOIN source_file sf ON sf.id = pg.file_id
      WHERE c.course_id=? AND c.status='active' AND c.is_title=0
      ORDER BY c.source_page`).all(courseId);

    const chOf = (r) => {
      if (r.chapter) return r.chapter;
      const fn = r.file_path ? String(r.file_path).split(/[\\/]/).pop() : '';
      const m = fn.match(/第[一二三四五六七八九十0-9]+[章节]/);
      return m ? m[0] : fn.replace(/\.[^.]+$/, '').replace(/^[0-9０-９]+[-\s._、]*/, '').trim();
    };

    // 需要画哪几章：指定一章 / 整门课一章 / 每一章各一张
    let targets = [];
    if (opts.all) {
      const byCh = new Map();
      for (const r of rows) {
        const k = chOf(r) || '未分章';
        if (!byCh.has(k)) byCh.set(k, []);
        byCh.get(k).push(r);
      }
      targets = [...byCh.entries()]
        .filter(([k, list]) => k !== '未分章' && list.length >= 3)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6)
        .map(([k]) => k);
      job.log.push(`整门课分 ${targets.length} 章，逐章画（最多 6 张）`);
    } else {
      targets = [opts.chapter || ''];
    }

    for (const chapter of targets) {
      let pool = rows;
      if (chapter) pool = rows.filter((r) => chOf(r) === chapter || (!chOf(r) && chapter === '未分章'));
      if (pool.length < 3) { job.log.push(`「${chapter || '全课'}」概念不足，跳过`); continue; }

      job.log.push(`画「${chapter || '整门课'}」：候选 ${pool.length} 个概念`);
      const list = pool.slice(0, 70)
        .map((r) => `- ${r.front}：${String(r.back || '').slice(0, 60)}`).join('\n');

      const { text } = await chat(cfg, [
        { role: 'system', content: DIAGRAM_SYSTEM() },
        { role: 'user', content: `课程：${majorName()}\n章节：${chapter || '全课'}\n\n概念清单：\n${list}` },
      ], { maxTokens: 1800 });

      const parsed = parseJson(text);
      if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length < 3) {
        job.log.push('  这一章 AI 没排出可用的图，跳过');
        continue;
      }
      const names = new Set(pool.map((r) => r.front));
      const uniq = [...new Set(parsed.nodes.map((n) => String(n.label || '').trim())
        .filter((n) => n && names.has(n)))];
      if (uniq.length < 3) { job.log.push('  AI 用了清单里没有的名字，跳过'); continue; }

      const edges = (parsed.edges || [])
        .map((e) => ({ from: String(e.from || '').trim(), to: String(e.to || '').trim(), kind: e.kind || 'flow' }))
        .filter((e) => uniq.includes(e.from) && uniq.includes(e.to) && e.from !== e.to);

      const xml = buildDiagramXml(uniq, edges, parsed.title);
      const did = uid('dia_');
      const title = String(parsed.title || `${chapter || '机制图'}`).slice(0, 40);
      db.prepare('INSERT INTO diagram(id,course_id,title,xml,created_at) VALUES(?,?,?,?,?)')
        .run(did, courseId, title, xml, nowIso());
      const linked = linkDiagramToCards(did, courseId, xml);
      job.created += linked;
      job.made += 1;
      job.title = title;
      job.diagramId = did;
      job.log.push(`  生成「${title}」：${uniq.length} 个概念、${edges.length} 条关系、挂到 ${linked} 张卡`);
    }

    if (!job.made) throw new Error('一张图都没画出来');
    job.status = 'done';
  })().catch((e) => {
    job.status = 'failed';
    job.error = String((e && e.message) || e);
    job.log.push('失败：' + job.error);
  });
  return id;
}

// 把"概念 + 关系"排成 draw.io 风格的 XML：先分层，再定坐标
function buildDiagramXml(labels, edges, title) {
  // 药物类节点如果跑到最上游，说明 AI 把"X药 治疗 Y 病"画成了 药→病。
  // 这种图读起来是反的（药在上、病在下），整张图翻转一次边方向。
  const drugLike = (s) => /(药|剂|素|抗体|疫苗|抑制剂|阻断药|拮抗药)$/.test(String(s));
  const hasIncoming = new Set(edges.map((e) => e.to));
  const roots = labels.filter((l) => !hasIncoming.has(l));
  const drugRoots = roots.filter(drugLike).length;
  let list = edges;
  if (roots.length && drugRoots >= Math.max(1, Math.ceil(roots.length / 2))) {
    list = edges.map((e) => ({ ...e, from: e.to, to: e.from }));
  }
  edges = list;

  const idx = new Map(labels.map((l, i) => [l, i]));
  const incoming = new Map(labels.map((l) => [l, []]));
  for (const e of edges) incoming.get(e.to)?.push(e.from);

  // 最长路径分层：层次 = 前驱层数 + 1
  const layer = new Map();
  const calc = (name, seen = new Set()) => {
    if (layer.has(name)) return layer.get(name);
    if (seen.has(name)) return 0;
    seen.add(name);
    const preds = incoming.get(name) || [];
    const v = preds.length ? Math.max(...preds.map((p) => calc(p, seen))) + 1 : 0;
    layer.set(name, v);
    return v;
  };
  for (const l of labels) calc(l);

  const byLayer = new Map();
  for (const l of labels) {
    const k = layer.get(l) || 0;
    if (!byLayer.has(k)) byLayer.set(k, []);
    byLayer.get(k).push(l);
  }

  // 层内排序：按前驱的平均位置排（barycenter），能把交叉显著减少
  const order = new Map();
  for (const [, items] of byLayer) items.forEach((l, i) => order.set(l, i));
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 2; pass++) {
    for (const k of layerKeys.slice(1)) {
      const items = byLayer.get(k);
      const score = (l) => {
        const preds = edges.filter((e) => e.to === l)
          .map((e) => order.get(e.from))
          .filter((v) => v !== undefined);
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : order.get(l);
      };
      items.sort((a, b) => score(a) - score(b));
      items.forEach((l, i) => order.set(l, i));
    }
  }

  const NODE_H = 44;
  const ROW_GAP = 18;      // 同一层里换行的间距
  const GAP_Y = 46;        // 层与层的间距
  const COL_GAP = 26;
  const PER_ROW = 4;       // 一层最多横排 4 个，多了往下折
  const pos = {};
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  const widthOf = (l) => Math.min(210, Math.max(112, l.length * 14 + 24));
  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  let y = 30;
  const MAX_ROW_W = 1000;   // 一行最宽多少像素，超了就换行
  for (const k of layers) {
    const items = byLayer.get(k);
    // 按实际宽度装箱：能并排就并排，不再死守 4 个
    const rows = [];
    let cur = [];
    let curW = 0;
    for (const l of items) {
      const wId = widthOf(l);
      const add = cur.length ? COL_GAP + wId : wId;
      if (cur.length && curW + add > MAX_ROW_W) { rows.push(cur); cur = []; curW = 0; }
      cur.push(l);
      curW += cur.length === 1 ? wId : add;
    }
    if (cur.length) rows.push(cur);

    for (const row of rows) {
      const widths = row.map(widthOf);
      let x = 40;
      row.forEach((l, i) => {
        pos[l] = { x, y, w: widths[i], h: NODE_H };
        x += widths[i] + COL_GAP;
      });
      y += NODE_H + ROW_GAP;
    }
    y += GAP_Y - ROW_GAP;
  }

  // 整体左对齐到 40，保证不出负数坐标
  const minX = Math.min(...labels.map((l) => pos[l].x));
  for (const l of labels) pos[l].x += 40 - minX;

  const esc2 = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cell = (l, i) => {
    const p = pos[l];
    const isFirst = layer.get(l) === 0;
    const st = isFirst
      ? 'rounded=1;fillColor=#e8f0fb;strokeColor=#5b8fd6;fontSize=13;'
      : 'rounded=1;fillColor=#fff3d6;strokeColor=#d9a520;fontSize=13;';
    return `<mxCell id="n${i}" value="${esc2(l)}" style="${st}" vertex="1" x="${Math.round(p.x)}" y="${Math.round(p.y)}" w="${Math.round(p.w)}" h="${p.h}"/>`;
  };
  const edgeCell = (e, i) => {
    const dashed = e.kind === 'contrast' ? 'dashed=1;' : '';
    return `<mxCell id="e${i}" edge="1" source="n${idx.get(e.from)}" target="n${idx.get(e.to)}" style="edgeStyle=orthogonalEdgeStyle;${dashed}"/>`;
  };

  return `<mxfile><diagram><mxGraphModel><root>`
    + labels.map(cell).join('')
    + edges.map(edgeCell).join('')
    + `</root></mxGraphModel></diagram></mxfile>`;
}

const refineJobs = new Map();

export function getRefineJob(id) {
  return refineJobs.get(id) || { status: 'unknown' };
}

export function startRefine(courseId) {
  const id = uid('refine_');
  const job = { id, status: 'running', log: [], done: 0, total: 0, created: 0, updated: 0, error: '' };
  refineJobs.set(id, job);
  runRefine(courseId, job).catch((e) => {
    job.status = 'failed';
    job.error = String((e && e.message) || e);
    job.log.push('失败：' + job.error);
  });
  return id;
}

async function runRefine(courseId, job) {
  const cfg = getAiConfig();
  if (cfg.baseUrl !== 'mock' && !cfg.apiKey) throw new Error('还没配置 API Key，先去设置里填');

  // 重新整理 = 先把上一次 AI 产出的卡归档，避免新旧混在一起
  const old = db.prepare("SELECT COUNT(*) n FROM card WHERE course_id=? AND origin='ai' AND status='active'").get(courseId).n;
  db.prepare("UPDATE card SET status='archived' WHERE course_id=? AND origin='ai' AND status='active'").run(courseId);
  if (old) job.log.push(`先把上次的 ${old} 张 AI 卡归档，重新来过`);

  const pages = db.prepare(`
    SELECT p.page_no, p.text, p.file_id FROM page p
    JOIN source_file f ON f.id = p.file_id
    WHERE f.course_id = ? AND length(p.text) > 20
    ORDER BY f.imported_at, p.page_no`).all(courseId);

  job.total = pages.length;
  const batch = Math.max(1, cfg.pagesPerRequest || 3);
  const chunks = [];
  for (let i = 0; i < pages.length; i += batch) chunks.push(pages.slice(i, i + batch));

  for (const chunk of chunks) {
    job.log.push(`处理第 ${chunk[0].page_no}–${chunk[chunk.length - 1].page_no} 页…`);
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const { text, cached } = await chat(cfg, [
        { role: 'system', content: SYSTEM() },
        { role: 'user', content: buildUserPrompt(chunk) },
      ], { maxTokens: 2200 });
      parsed = parseJson(text);
      if (cached) job.log.push('  （命中缓存，没花钱）');
      if (!parsed) job.log.push('  输出不是合法 JSON，重试');
    }
    if (!parsed) { job.log.push('  这一批丢弃'); job.done += chunk.length; continue; }

    let terms = parsed.terms || [];
    // 第二道工序：让 AI 自己审一遍（章节标题、表头、动作名、半截词都在这被刷掉）
    if (cfg.review !== false && terms.length) {
      const rev = await reviewTerms(cfg, terms, chunk);
      if (Array.isArray(rev)) {
        terms = rev;
      } else {
        terms = rev.kept;
        if (rev.dropped.length) {
          job.log.push(`  复核删掉 ${rev.dropped.length} 条：${rev.dropped.slice(0, 5).map((x) => `${x.name}（${x.reason}）`).join('；')}`);
          // 存进待审队列，用户可以捞回来
          const ins = db.prepare(
            'INSERT INTO rejected_term(id,course_id,name,reason,page,created_at) VALUES(?,?,?,?,?,?)');
          for (const d of rev.dropped) ins.run(uid('rej_'), courseId, d.name, d.reason, d.page, nowIso());
        }
        job.dropped = (job.dropped || 0) + rev.dropped.length;
      }
    }
    applyTerms(courseId, { ...parsed, terms }, chunk, job);
    job.done += chunk.length;
    job.log.push(`  留下 ${terms.length} 个术语`);
  }

  job.status = 'done';
  const archived = cleanupHeadings(courseId);
  if (archived) job.log.push(`顺手藏起了 ${archived} 个"章节标题"式的假词条`);
  if (job.dropped) job.log.push(`复核一共刷掉 ${job.dropped} 个不是术语的候选`);
  // AI 已经把术语表重建过一遍，旧的"按颜色猜"卡片就退场（归档，不删）
  const oldPpt = db.prepare(
    "SELECT COUNT(*) n FROM card WHERE course_id=? AND origin='ppt' AND status='active'").get(courseId).n;
  db.prepare("UPDATE card SET status='archived' WHERE course_id=? AND origin='ppt' AND status='active'").run(courseId);
  if (oldPpt) job.log.push(`旧的规则卡片 ${oldPpt} 张已归档（AI 版更准）`);
  job.log.push(`完成：新增 ${job.created} 张卡，更新 ${job.updated} 张`);
}

// 把"第三章 / 主要内容 / 实验目的"这类标题从复习里摘掉（不删，只归档）
const HEAD_RE = /^(第[一二三四五六七八九十0-9]+[章节]|主要内容|本章要点|本章重点|思考题|复习思考题|小结|总结|前言|绪论|目录|概述|实验目的|学习目标|重点难点|思考与练习)/;

function cleanupHeadings(courseId) {
  const rows = db.prepare('SELECT id, front FROM card WHERE course_id=? AND status=\'active\'').all(courseId);
  let n = 0;
  for (const r of rows) {
    if (HEAD_RE.test(r.front)) {
      db.prepare("UPDATE card SET status='archived' WHERE id=?").run(r.id);
      n += 1;
    }
  }
  return n;
}

function normalizeName(s) {
  return String(s || '')
    .replace(/^[（(]?[0-9０-９]{1,2}[）).．、:：]\s*/, '')
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

// 这条术语像不像"能考的名词"——不像就丢掉，宁可漏抽也不塞垃圾
const BAD_NAME_RE = /[、，,；;\/／()（）]|^(方法|步骤|过程|主要|用于|包括|分为)/;
// "抗血清的鉴定 / 单抗的类及亚类鉴定 / 分离与保存"这类是操作名，不是概念
const ACTION_TAIL_RE = /(的?)(鉴定|分离|纯化|保存|制备|应用|检测|分类|比较|分析|提纯)$/;
const BAD_DEF_RE = /未详述|本页|如图|见上|同上/;

function acceptTerm(t) {
  const name = normalizeName(t.name);
  if (!name) return null;
  if (name.length < 2 || name.length > 12) return null;
  if (name.length > 10 && /[\u4e00-\u9fff]/.test(name)) return null;
  if (BAD_NAME_RE.test(name)) return null;
  if (HEAD_RE.test(name)) return null;
  if (ACTION_TAIL_RE.test(name)) return null;
  const def = String(t.definition || '').trim();
  if (def.length < 6 || BAD_DEF_RE.test(def)) return null;
  // 定义不能只是"X 的鉴定包括…"这种复述，那等于没解释
  if (/^(该|本)?术语?/.test(def)) return null;
  const imp = Number(t.importance) || 3;
  if (imp < 3) return null;          // 低价值的直接不进复习
  return { name, def, imp, type: t.type || 'unknown', aliases: t.aliases || [] };
}

function applyTerms(courseId, parsed, chunk, job) {
  const firstPage = chunk[0].page_no;
  // 页码 -> 文件：同一批页来自同一个文件时，用它给卡片标出处
  const fileOfPage = new Map();
  for (const c of chunk) if (c.file_id) fileOfPage.set(c.page_no, c.file_id);
  const defaultFile = chunk.length && chunk[0].file_id ? chunk[0].file_id : null;

  for (const raw of parsed.terms || []) {
    const ok = acceptTerm(raw);
    if (!ok) continue;
    const { name, def, imp, type, aliases } = ok;
    const page = Number(raw.page) || firstPage;

    const exists = db.prepare(
      'SELECT id FROM card WHERE course_id=? AND front=?').get(courseId, name);
    const fileId = fileOfPage.get(page) || defaultFile;
    if (exists) {
      db.prepare(`UPDATE card SET back=?, importance=?, origin='ai', status='active',
                  file_id=COALESCE(?, file_id) WHERE id=?`)
        .run(def, imp, fileId, exists.id);
      job.updated += 1;
      continue;
    }
    const conceptId = uid('cp_');
    db.prepare('INSERT INTO concept(id,course_id,type,created_at) VALUES(?,?,?,?)')
      .run(conceptId, courseId, type, nowIso());
    db.prepare('INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)')
      .run(conceptId, name, 'preferred', 'ai');
    for (const a of aliases) {
      const al = normalizeName(a);
      if (al && al !== name && al.length >= 2 && al.length <= 30) {
        db.prepare('INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)')
          .run(conceptId, al, 'alt', 'ai');
      }
    }
    const cardId = uid('card_');
    db.prepare(`INSERT INTO card(id,course_id,concept_id,front,back,image_path,source_page,source_text,
      importance,origin,status,is_title,file_id,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,'ai','active',0,?,?)`)
      .run(cardId, courseId, conceptId, name, def, page, def, imp, fileId, nowIso());
    db.prepare('INSERT INTO card_state(card_id,state,due_at) VALUES(?,?,?)')
      .run(cardId, 'new', nowIso());
    job.created += 1;
  }

  for (const r of parsed.relations || []) {
    const from = normalizeName(r.from);
    const to = normalizeName(r.to);
    if (!from || !to || from === to) continue;
    const a = db.prepare('SELECT concept_id FROM card WHERE course_id=? AND front=?').get(courseId, from);
    const b = db.prepare('SELECT concept_id FROM card WHERE course_id=? AND front=?').get(courseId, to);
    if (!a || !b) continue;
    const kind = ['contains', 'prerequisite', 'contrast', 'ordered_steps'].includes(r.kind) ? r.kind : 'contains';
    const dup = db.prepare(
      'SELECT 1 FROM relation WHERE from_concept=? AND to_concept=? AND kind=?')
      .get(a.concept_id, b.concept_id, kind);
    if (!dup) {
      db.prepare('INSERT INTO relation(course_id,from_concept,to_concept,kind) VALUES(?,?,?,?)')
        .run(courseId, a.concept_id, b.concept_id, kind);
    }
  }
}
