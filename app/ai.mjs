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
const SYSTEM = `你是中国农业大学动物医学专业的助教，负责把课件原文整理成"能考"的复习卡片。
只输出 JSON，不要解释，不要 Markdown 代码块。

【抽什么】
只抽"考试会问到的名词性概念"：术语、细胞、器官、物质、机制/过程名、疾病、病变、指标。
每页最多抽 5 个，宁缺毋滥。

【绝对不要抽】
- 章节标题："第一章""第一节""主要内容""本章要点""实验目的""思考题"
- 用途/步骤/方法类的组合短语，例如"抗原物质的鉴别、定位、分析和提纯""抗血清的分离与保存""多抗的纯化与标记"
- 带顿号或逗号的拼接列表（术语名里不允许出现"、"或"，"）
- 整句话、带数字剂量的药名、页码、人名

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
const REVIEW_SYSTEM = `你是动物医学专业的出题老师，正在审核一份"复习术语清单"。
清单是一段课件里的候选词。请逐条判断：这个词是不是**值得学生背的专业术语**。

判为"留"（keep=true）的标准：
- 是一个专业概念、细胞、器官、物质、机制、疾病、病变、指标，学生考试要会用；
- 名字是个名词，不是句子片段。

判为"删"（keep=false）的标准（命中任意一条就删）：
- 章节/小节标题："第一章""第二节""主要内容""本章要点""实验目的""思考题""小结"
- 表格的列名或行名："抗酸强度""起效时间""持续时间""收敛作用""常用抗酸药作用比较"
- 动作/操作名："抗血清的分离与保存""单抗的类及亚类鉴定""多抗的纯化与标记"
- 句子碎片、半截词："为克隆""简称""称为""建立""局限性""可继""见病症"
- 泛指词："药物""作用""方法""特点""分类""用途""不良反应"这种放到任何一章都成立的
- 明显是书名、文件名、人名、页眉页脚

另外给 canonical：如果这个词是错字/多字/少字（例如"为克隆"应为"克隆"），给出正确写法；
本来就对就填原词。

只输出 JSON：
{"verdicts":[{"name":"原词","canonical":"规范写法","keep":true,"reason":"不超过15字的理由"}]}`;

async function reviewTerms(cfg, terms, chunks) {
  if (!terms.length) return terms;
  const pageBits = chunks.map((c) => `【第 ${c.page_no ?? c.page} 页】${String(c.text || '').slice(0, 500)}`).join('\n');
  const list = terms.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
  const { text } = await chat(cfg, [
    { role: 'system', content: REVIEW_SYSTEM },
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
    if (v.keep === false) { dropped.push(`${t.name}（${v.reason || '复核删除'}）`); continue; }
    const canon = normalizeName(v.canonical || '');
    out.push({ ...t, name: canon && canon !== normalizeName(t.name) ? canon : t.name,
      aliases: [...(t.aliases || []), ...(canon && canon !== normalizeName(t.name) ? [t.name] : [])] });
  }
  return { kept: out, dropped };
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

    let terms = parsed.terms || [];
    // 第二道工序：让 AI 自己审一遍（章节标题、表头、动作名、半截词都在这被刷掉）
    if (cfg.review !== false && terms.length) {
      const rev = await reviewTerms(cfg, terms, chunk);
      if (Array.isArray(rev)) {
        terms = rev;
      } else {
        terms = rev.kept;
        if (rev.dropped.length) {
          job.log.push(`  复核删掉 ${rev.dropped.length} 条：${rev.dropped.slice(0, 5).join('；')}`);
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
  const pageOf = new Map();
  for (const c of chunk) pageOf.set(c.page_no, c.text);
  const firstPage = chunk[0].page_no;

  for (const raw of parsed.terms || []) {
    const ok = acceptTerm(raw);
    if (!ok) continue;
    const { name, def, imp, type, aliases } = ok;
    const page = Number(raw.page) || firstPage;

    const exists = db.prepare(
      'SELECT id FROM card WHERE course_id=? AND front=?').get(courseId, name);
    if (exists) {
      db.prepare(`UPDATE card SET back=?, importance=?, origin='ai', status='active' WHERE id=?`)
        .run(def, imp, exists.id);
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
      importance,origin,status,is_title,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,'ai','active',0,?)`)
      .run(cardId, courseId, conceptId, name, def, page, def, imp, nowIso());
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
