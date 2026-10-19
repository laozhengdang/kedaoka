// ai.mjs —— 接大模型：配置、调用、把逐页原文变成"术语 + 定义 + 关系"
//
// 设计要点（对应文档 D61 / D82）：
//   - 只支持 OpenAI 兼容的 /chat/completions，DeepSeek / Kimi / 智谱 / OpenAI 都能填
//   - 严格 JSON 输出，解析失败只重试一次，仍失败就丢弃这一批（不许瞎猜）
//   - 同样的输入有缓存（request_hash → response），重跑不重复花钱
//   - 'mock' 是完全离线的假提供商，用来在没有 key 时验证整条链路

import { createHash } from 'node:crypto';
import { db, getProfile, setProfile, uid, nowIso } from './db.mjs';

// ---------------- 配置 ----------------
export function getAiConfig() {
  const p = getProfile();
  return {
    baseUrl: p.ai_base_url || 'https://api.deepseek.com/v1',
    model: p.ai_model || 'deepseek-chat',
    apiKey: p.ai_api_key || '',
    pagesPerRequest: Number(p.ai_pages_per_request) || 3,
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

// ---------------- 提示词 ----------------
const SYSTEM = `你是中国农业大学动物医学专业的助教，负责把课件原文整理成复习卡片。
只输出 JSON，不要任何解释或 Markdown 代码块。

对给定的课件原文，抽取真正的"专业术语"，规则：
1. 只抽术语，不要章节标题（如"第一章""第一节""主要内容""本类药物的种类""实验目的"）、不要整句话、不要药名后面跟的剂量数字。
2. 术语名必须是原文里**完整出现**的词，不能多字也不能少字（例如原文是"克隆"就不要写成"为克隆"）。
3. 去掉序号、项目符号、括号里的英文；纯英文缩写可保留。
4. 每个术语给：
   - name: 规范名称
   - type: entity（细胞/器官/物质）| process（机制/过程）| disease | lesion | attribute（数值/分类/性质）
   - definition: 1~2 句中文，尽量用原文措辞，不超过 80 字；原文没讲清就写"（课件未详述）"
   - importance: 1~5 的整数，按"老师强调程度"（红色/加粗/反复出现/在考点清单里 → 高）
   - aliases: 原文出现的别名、英文名、缩写，数组
5. relations: 如果这一页明确写了"A 包括 B、C"或"A 导致 B"或"A 分为 B/C"，输出 {from, to, kind}，
   kind 只能是 contains | prerequisite | contrast | ordered_steps。没有就空数组。
6. 宁可少抽，不要凑数。抽不准的不要。

输出：
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

// ---------------- 精修一门课 ----------------
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

  const pages = db.prepare(`
    SELECT p.page_no, p.text FROM page p
    JOIN source_file f ON f.id = p.file_id
    WHERE f.course_id = ? AND length(p.text) > 20
    ORDER BY p.page_no`).all(courseId);

  job.total = pages.length;
  const batch = Math.max(1, cfg.pagesPerRequest || 3);
  const chunks = [];
  for (let i = 0; i < pages.length; i += batch) chunks.push(pages.slice(i, i + batch));

  for (const chunk of chunks) {
    job.log.push(`处理第 ${chunk[0].page_no}–${chunk[chunk.length - 1].page_no} 页…`);
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const { text, cached } = await chat(cfg, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserPrompt(chunk) },
      ], { maxTokens: 2200 });
      parsed = parseJson(text);
      if (cached) job.log.push('  （命中缓存，没花钱）');
      if (!parsed) job.log.push('  输出不是合法 JSON，重试');
    }
    if (!parsed) { job.log.push('  这一批丢弃'); job.done += chunk.length; continue; }

    applyTerms(courseId, parsed, chunk, job);
    job.done += chunk.length;
    job.log.push(`  得到 ${(parsed.terms || []).length} 个术语`);
  }

  job.status = 'done';
  const archived = cleanupHeadings(courseId);
  if (archived) job.log.push(`顺手藏起了 ${archived} 个"章节标题"式的假词条`);
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

function applyTerms(courseId, parsed, chunk, job) {
  const pageOf = new Map();
  for (const c of chunk) pageOf.set(c.page_no, c.text);
  const firstPage = chunk[0].page_no;

  for (const t of parsed.terms || []) {
    const name = normalizeName(t.name);
    if (!name || name.length < 2 || name.length > 30) continue;
    // 明显是章节标题的就跳过
    if (/^第[一二三四五六七八九十0-9]+[章节]/.test(name)) continue;

    const page = Number(t.page) || firstPage;
    const exists = db.prepare(
      'SELECT id, concept_id FROM card WHERE course_id=? AND front=?').get(courseId, name);
    if (exists) {
      db.prepare(`UPDATE card SET back=?, importance=?, origin='ai' WHERE id=?`)
        .run(t.definition || '', Number(t.importance) || 3, exists.id);
      job.updated += 1;
      continue;
    }
    const conceptId = uid('cp_');
    db.prepare('INSERT INTO concept(id,course_id,type,created_at) VALUES(?,?,?,?)')
      .run(conceptId, courseId, t.type || 'unknown', nowIso());
    db.prepare('INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)')
      .run(conceptId, name, 'preferred', 'ai');
    for (const a of t.aliases || []) {
      const al = normalizeName(a);
      if (al && al !== name) {
        db.prepare('INSERT INTO term(concept_id,text,kind,origin) VALUES(?,?,?,?)')
          .run(conceptId, al, 'alt', 'ai');
      }
    }
    const cardId = uid('card_');
    db.prepare(`INSERT INTO card(id,course_id,concept_id,front,back,image_path,source_page,source_text,
      importance,origin,status,is_title,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,'ai','active',0,?)`)
      .run(cardId, courseId, conceptId, name, t.definition || '', page, t.definition || '',
        Number(t.importance) || 3, nowIso());
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
