// app.js —— 前端（原生 JS，无构建）

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

let STATE = { profile: null, courses: [], current: null, queue: null };
let REVIEW = null;

async function api(method, path, body) {
  // 桌面版：走 Electron IPC；网页版：走本地 HTTP
  if (window.nativeApi && window.nativeApi.invoke) {
    const out = await window.nativeApi.invoke(method, path, body);
    if (out && out.error) throw new Error(out.error);
    return out;
  }
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

// 任何没被 catch 的错误都要看得见，不许再"静默失败"
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && (e.reason.message || e.reason)) || '未知错误';
  toast('出错了：' + msg);
  console.error('[unhandled]', e.reason);
});

// ---------------- 侧栏 ----------------
function renderSidebar() {
  const box = $('#courseList');
  box.innerHTML = '';
  for (const c of STATE.courses) {
    const started = c.today.total > 0;
    const left = Math.max(0, c.today.total - c.today.done);
    const row = el('div', `course ${started ? 'on' : ''} ${STATE.current === c.id ? 'active' : ''}`);
    row.innerHTML = `<span class="dot"></span><span class="name">${esc(c.name)}</span>
      <span class="n">${started ? left : '–'}</span>`;
    row.onclick = () => { location.hash = `#/course/${c.id}`; };
    box.appendChild(row);
  }
  if (!STATE.courses.length) {
    box.appendChild(el('div', 'empty', '还没有课程<br><br>点下面「导入课件」'));
  }
}

// ---------------- 路由 ----------------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const b = await api('GET', '/api/bootstrap');
  STATE.profile = b.profile;
  STATE.courses = b.courses;
  if (window.nativeApi && window.nativeApi.dataDir) {
    STATE.dataDir = await window.nativeApi.dataDir();
  }
  renderSidebar();
  bindChrome();
  route();
}

// 图片地址：桌面版拼 file://，网页版走 /img/
function imgUrl(rel) {
  if (!rel) return '';
  if (STATE.dataDir) {
    const p = (STATE.dataDir + '/' + rel).replace(/\\/g, '/');
    return 'file:///' + p.split('/').map(encodeURIComponent).join('/');
  }
  return '/img/' + rel.split('/').map(encodeURIComponent).join('/');
}

function bindChrome() {
  $('#btnCollapse').onclick = () => {
    $('#sidebar').classList.toggle('collapsed');
  };
  $('#btnSettings').onclick = () => { location.hash = '#/settings'; };
  $('#btnImport').onclick = openImport;
  $('#importClose').onclick = () => $('#importModal').classList.add('hidden');
  $('#importGo').onclick = doImport;
}

async function route() {
  endReview();
  const h = location.hash || '#/';
  const parts = h.replace(/^#\//, '').split('/');
  if (parts[0] === 'course' && parts[1]) return viewCourse(parts[1]);
  if (parts[0] === 'browse' && parts[1]) return viewBrowse(parts[1]);
  if (parts[0] === 'graph' && parts[1]) return viewGraph(parts[1]);
  if (parts[0] === 'card' && parts[1]) return viewCard(parts[1]);
  if (parts[0] === 'summary' && parts[1]) return viewSummary(parts[1]);
  if (parts[0] === 'settings') return viewSettings();
  return viewHome();
}

// ---------------- 首页 ----------------
async function viewHome() {
  STATE.current = null;
  renderSidebar();
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  const totalLeft = STATE.courses.reduce((a, c) => a + Math.max(0, c.today.total - c.today.done), 0);
  w.innerHTML = `
    <h1>今天</h1>
    <p class="sub">${STATE.courses.length} 门课程 · 待刷 ${totalLeft} 张</p>`;
  if (!STATE.courses.length) {
    w.appendChild(el('div', 'empty', '还没有课程。点左下「导入课件」开始。'));
  } else {
    for (const c of STATE.courses) {
      const card = el('div', 'today-card');
      const left = Math.max(0, c.today.total - c.today.done);
      card.innerHTML = `
        <div class="sub">${esc(c.name)}</div>
        <div class="big-num">${c.today.total ? left : '—'}</div>
        <div class="bar"><i style="width:${c.today.total ? c.today.done / c.today.total * 100 : 0}%"></i></div>
        <div class="sub">${c.today.total ? `已完成 ${c.today.done} / ${c.today.total}` : `共 ${c.cards} 张卡`}</div>`;
      const row = el('div', 'row');
      row.style.justifyContent = 'center';
      row.style.marginTop = '16px';
      const b = el('button', 'primary', c.today.total ? (left ? '继续' : '看结算') : '开始今天的 15 张');
      b.onclick = () => { location.hash = `#/course/${c.id}`; };
      row.appendChild(b);
      card.appendChild(row);
      w.appendChild(card);
    }
  }
  m.appendChild(w);
}

// ---------------- 课程页 ----------------
async function viewCourse(id) {
  STATE.current = id;
  const d = await api('GET', `/api/course/${id}`);
  STATE.queue = d.queue;
  renderSidebar();
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  const consumedAll = d.queue.total > 0 && d.queue.done >= d.queue.total;

  w.innerHTML = `
    <h1>${esc(d.course.name)}</h1>
    <p class="sub">共 ${d.course.cards || ''} 张卡 · ${d.course.mode === 'calc' ? '计算型' : '概念型'}</p>
    <div class="tabs">
      <div class="tab active" data-t="today">今天</div>
      <div class="tab" data-t="repo">仓库</div>
      <div class="tab" data-t="graph">关系图</div>
    </div>
    <div id="tabBody"></div>`;
  m.appendChild(w);

  w.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      if (t.dataset.t === 'repo') location.hash = `#/browse/${id}`;
      if (t.dataset.t === 'graph') location.hash = `#/graph/${id}`;
    };
  });

  const body = w.querySelector('#tabBody');
  if (!d.queue.total) {
    body.innerHTML = `<div class="today-card">
      <div class="sub">今天还没开始</div>
      <div class="big-num" style="margin:10px 0">15</div>
      <div class="sub">新卡 10 · 复习 5</div></div>`;
    const b = el('button', 'primary', '开始今天的 15 张');
    b.style.marginTop = '18px';
    b.onclick = async () => {
      await api('POST', `/api/start/${id}`);
      location.reload();
    };
    body.querySelector('.today-card').appendChild(b);
  } else if (consumedAll) {
    body.innerHTML = `<div class="today-card"><div class="big-num">✓</div>
      <div class="sub">今天完成 ${d.queue.done} / ${d.queue.total}</div></div>`;
    const row = el('div', 'row');
    row.style.marginTop = '16px';
    row.style.justifyContent = 'center';
    const b1 = el('button', 'primary', '看结算');
    b1.onclick = () => { location.hash = `#/summary/${id}`; };
    row.appendChild(b1);
    body.querySelector('.today-card').appendChild(row);
  } else {
    const left = d.queue.total - d.queue.done;
    body.innerHTML = `<div class="today-card">
      <div class="big-num">${left}</div>
      <div class="bar"><i style="width:${d.queue.done / d.queue.total * 100}%"></i></div>
      <div class="sub">已完成 ${d.queue.done} / ${d.queue.total}</div></div>`;
    const b = el('button', 'primary', '继续');
    b.style.marginTop = '18px';
    b.onclick = () => startReview(id);
    body.querySelector('.today-card').appendChild(b);
  }
}

// ---------------- 复习 ----------------
async function startReview(courseId) {
  const d = await api('GET', `/api/course/${courseId}`);
  // 队列接口返回的是 card_id，这里统一成 id，避免下面到处写两种名字
  const cards = d.queue.cards
    .filter((c) => !c.done)
    .map((c) => ({ ...c, id: c.card_id }));
  if (!cards.length) { location.hash = `#/summary/${courseId}`; return; }
  REVIEW = {
    courseId, cards, i: 0, phase: 'ask', rating: null,
    t0: Date.now(), cardT0: Date.now(), timer: null, autoDue: false,
  };
  openReview();
}

function openReview() {
  teardownReview();
  const box = el('div');
  box.id = 'review';
  box.innerHTML = `
    <div class="rev-top">
      <span id="revProg"></span>
      <span class="timer" id="revTimer">0:00</span>
      <span>
        <button class="small ghost" id="btnBrokenText">释义有误</button>
        <button class="small ghost" id="btnBrokenImg">图配错</button>
        <button class="small ghost" id="btnQuit">退出</button>
      </span>
    </div>
    <div class="rev-body"><div class="rev-inner" id="revInner"></div></div>
    <div class="rev-foot">
      <span>1–4 选档 · 空格下一张 · Esc 退出</span>
      <span id="revHint"></span>
    </div>`;
  document.body.appendChild(box);
  $('#btnQuit').onclick = () => { endReview(); route(); };
  $('#btnBrokenText').onclick = () => markBroken('text');
  $('#btnBrokenImg').onclick = () => markBroken('image');
  renderCard();
  REVIEW.timer = setInterval(tick, 250);
}

// 只拆 DOM 和计时器，不动 REVIEW（openReview 里要用）
function teardownReview() {
  if (REVIEW && REVIEW.timer) clearInterval(REVIEW.timer);
  const old = $('#review');
  if (old) old.remove();
}

// 真正结束一次复习
function endReview() {
  teardownReview();
  REVIEW = null;
}

function tick() {
  if (!REVIEW) return;
  const sec = Math.floor((Date.now() - REVIEW.t0) / 1000);
  const t = $('#revTimer');
  if (!t) return;
  t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  if (REVIEW.phase === 'ask' && !REVIEW.autoDue) {
    const cardSec = Math.floor((Date.now() - REVIEW.cardT0) / 1000);
    if (cardSec >= 90) {
      REVIEW.autoDue = true;
      t.classList.add('over');
      t.title = '这张已超时';
      // 默认策略：自动翻面 + 记③模糊（auto=1），见文档 17.9
      chooseRating(3, true);
    }
  }
}

function renderCard() {
  const r = REVIEW;
  if (!r || !r.cards) return;
  const c = r.cards[r.i];
  if (!c) return finishReview();
  const inner = $('#revInner');
  $('#revProg').textContent = `${r.i + 1} / ${r.cards.length}`;
  if (!inner) return;

  if (r.phase === 'ask') {
    inner.innerHTML = `
      <div class="term">${esc(c.front)}</div>
      <div class="meta">${'★'.repeat(c.importance)}${'☆'.repeat(5 - c.importance)} · 第 ${c.source_page} 页</div>
      <div class="choices">
        <button class="choice" data-r="1">记得<small>以后不用再考</small><span class="kbd">1</span></button>
        <button class="choice" data-r="2">记得<small>不用看概念</small><span class="kbd">2</span></button>
        <button class="choice" data-r="3">模糊<small>要看概念</small><span class="kbd">3</span></button>
        <button class="choice" data-r="4">不会<small>完全不记得</small><span class="kbd">4</span></button>
      </div>`;
    inner.querySelectorAll('.choice').forEach((b) => {
      b.onclick = () => chooseRating(Number(b.dataset.r));
    });
  } else if (r.phase === 'importance') {
    inner.innerHTML = `
      <div class="term">${esc(c.front)}</div>
      <div class="meta">这是重点吗？（判断 AI 判得准不准）</div>
      <div class="choices" style="grid-template-columns:1fr 1fr;max-width:420px;margin:0 auto">
        <button class="choice" data-i="5">是重点<small>提高星级</small><span class="kbd">1</span></button>
        <button class="choice" data-i="2">不是<small>降低星级</small><span class="kbd">2</span></button>
      </div>`;
    inner.querySelectorAll('.choice').forEach((b) => {
      b.onclick = () => { REVIEW.humanImportance = Number(b.dataset.i); showAnswer(); };
    });
  } else {
    inner.innerHTML = `
      <div class="term">${esc(c.front)}</div>
      <div class="meta">第 ${c.source_page} 页 · ${'★'.repeat(c.importance)}</div>
      <div class="answer"><div class="label">课件原文</div>${esc(c.back || '（这一页没有抽到上下文）')}</div>
      ${c.image_path ? `<div class="cardimg"><img src="${imgUrl(c.image_path)}" alt="配图" loading="lazy"></div>` : ''}
      <div class="row" style="justify-content:center;margin-top:26px">
        <button class="primary" id="btnNext">下一张 <span class="kbd">空格</span></button>
      </div>`;
    $('#btnNext').onclick = nextCard;
  }
}

function chooseRating(rating, auto = false) {
  if (!REVIEW || REVIEW.phase !== 'ask') return;
  REVIEW.rating = rating;
  REVIEW.autoRating = auto;
  if (rating >= 3) {
    REVIEW.phase = 'importance';
    renderCard();
  } else {
    // ①② 直接下一张（文档 §17.1）
    submitRating(false).then(nextCard);
  }
}

function showAnswer() {
  REVIEW.phase = 'answer';
  renderCard();
  // ③④：先记录，答案展示后再继续
  submitRating(Boolean(REVIEW.autoRating));
}

async function submitRating(auto) {
  const r = REVIEW;
  const c = r.cards[r.i];
  const latency = Date.now() - r.cardT0;
  await api('POST', '/api/review', {
    cardId: c.id,
    rating: r.rating,
    humanImportance: r.humanImportance ?? null,
    latencyMs: latency,
    auto: auto ? 1 : 0,
  });
  r.humanImportance = null;
}

function nextCard() {
  if (!REVIEW) return;
  REVIEW.i += 1;
  REVIEW.phase = 'ask';
  REVIEW.rating = null;
  REVIEW.autoDue = false;
  REVIEW.humanImportance = null;
  REVIEW.cardT0 = Date.now();
  const t = $('#revTimer');
  if (t) t.classList.remove('over');
  if (REVIEW.i >= REVIEW.cards.length) return finishReview();
  renderCard();
}

async function markBroken(kind) {
  if (!REVIEW) return;
  const c = REVIEW.cards[REVIEW.i];
  await api('POST', `/api/card/${c.id}/broken`, {});
  toast(kind === 'image' ? '已标记「图配错」，从队列移除' : '已标记「释义有误」，从队列移除');
  nextCard();
}

async function finishReview() {
  const courseId = REVIEW.courseId;
  endReview();
  toast('今天刷完了');
  location.hash = `#/summary/${courseId}`;
}

// 键盘
window.addEventListener('keydown', (e) => {
  if (!REVIEW) return;
  if (e.key === 'Escape') { endReview(); route(); return; }
  if (REVIEW.phase === 'ask' && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault();
    chooseRating(Number(e.key));
  } else if (REVIEW.phase === 'importance' && ['1', '2'].includes(e.key)) {
    // 1 = 是重点，2 = 不是
    e.preventDefault();
    REVIEW.humanImportance = e.key === '1' ? 5 : 2;
    showAnswer();
  } else if (REVIEW.phase === 'answer' && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    nextCard();
  }
});

// ---------------- 结算 ----------------
async function viewSummary(id) {
  const s = await api('GET', `/api/summary/${id}`);
  const d = await api('GET', `/api/course/${id}`);
  STATE.current = id;
  renderSidebar();
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  const dist = s.dist;
  w.innerHTML = `
    <h1>今天完成 ✓</h1>
    <p class="sub">${esc(d.course.name)} · ${s.date}</p>
    <div class="today-card" style="text-align:left">
      <div class="big-num" style="text-align:center">${s.total} / ${d.queue.total}</div>
      <div class="sub" style="text-align:center;margin-bottom:18px">张</div>
      <div>记得且不再考 <b>${dist[1] || 0}</b></div>
      <div>记得不看不看概念 <b>${dist[2] || 0}</b></div>
      <div>模糊 <b>${dist[3] || 0}</b></div>
      <div>完全不记得 <b>${dist[4] || 0}</b></div>
    </div>`;
  const row = el('div', 'row');
  row.style.marginTop = '16px';
  const b1 = el('button', 'primary', '回课程');
  b1.onclick = () => { location.hash = `#/course/${id}`; };
  const b2 = el('button', 'ghost', '看仓库');
  b2.onclick = () => { location.hash = `#/browse/${id}`; };
  row.append(b1, b2);
  w.appendChild(row);
  m.appendChild(w);
}

// ---------------- 关系图 ----------------
async function viewGraph(id) {
  STATE.current = id;
  renderSidebar();
  const d = await api('GET', `/api/graph/${id}`);
  const cname = (STATE.courses.find((x) => x.id === id) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <h1>${esc(cname)} · 关系图</h1>
    <div class="tabs">
      <div class="tab" data-t="today">今天</div>
      <div class="tab" data-t="repo">仓库</div>
      <div class="tab active">关系图</div>
    </div>
    <p class="sub">按课件的真实章节结构生成。点任意名词跳到它的卡片。</p>
    <div class="tree" id="tree"></div>
    <h2>包含关系</h2>
    <div id="edges"></div>`;
  m.appendChild(w);

  w.querySelector('[data-t="today"]').onclick = () => { location.hash = `#/course/${id}`; };
  w.querySelector('[data-t="repo"]').onclick = () => { location.hash = `#/browse/${id}`; };

  const tree = w.querySelector('#tree');
  const chapters = d.chapters || [];
  chapters.forEach((ch, ci) => {
    const lastCh = ci === chapters.length - 1;
    const head = el('div', 'tree-root');
    head.innerHTML = `<span class="branch">${lastCh ? '└' : '├'}─ </span><span class="node title">${esc(ch.name)}</span><span class="pg">${ch.count} 项</span>`;
    tree.appendChild(head);
    ch.pages.forEach((pg, pi) => {
      const lastPg = pi === ch.pages.length - 1;
      const p = el('div', 'tree-child');
      p.innerHTML = `<span class="branch">${lastCh ? '  ' : '│ '}${lastPg ? '└' : '├'}─ </span><span class="pg">p${pg.page}</span>`;
      tree.appendChild(p);
      pg.cards.forEach((k, ki) => {
        const last = ki === pg.cards.length - 1;
        const r = el('div', 'tree-child');
        r.innerHTML = `<span class="branch">${lastCh ? '  ' : '│ '}${lastPg ? '  ' : '│ '}${last ? '└' : '├'}─ </span>` +
          `<a data-go="${k.id}">${esc(k.front)}</a>` +
          `<span class="star">${'★'.repeat(k.importance)}</span>`;
        tree.appendChild(r);
      });
    });
  });
  if (!chapters.length) tree.appendChild(el('div', 'empty', '还没有可以成树的内容'));

  const edges = w.querySelector('#edges');
  if (!(d.edges || []).length) {
    edges.appendChild(el('div', 'sub', '暂未抽到（接上 AI 后这里会变成完整的概念关系网）'));
  } else {
    for (const e of d.edges) {
      const r = el('div', 'tree-child');
      r.innerHTML = `<a data-go="${e.from_id}">${esc(e.from_front)}</a> ──包含──▶ <a data-go="${e.to_id}">${esc(e.to_front)}</a>`;
      edges.appendChild(r);
    }
  }

  w.querySelectorAll('[data-go]').forEach((a) => {
    a.onclick = () => { location.hash = `#/card/${a.dataset.go}`; };
  });
}

// ---------------- 仓库 ----------------
async function viewBrowse(id, q = '', filter = 'all') {
  STATE.current = id;
  renderSidebar();
  const d = await api('GET', `/api/browse/${id}?q=${encodeURIComponent(q)}&filter=${filter}`);
  const m = $('#main');
  m.innerHTML = '';
  const cname = (STATE.courses.find((x) => x.id === id) || {}).name || '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <h1>${esc(cname)}</h1>
    <div class="tabs">
      <div class="tab" data-t="today">今天</div>
      <div class="tab active">仓库</div>
    </div>
    <input id="q" placeholder="搜索术语（支持拼音首字母以后加）" value="${esc(q)}">
    <div class="row" style="margin-bottom:8px">
      <button class="small ${filter === 'all' ? 'primary' : ''}" data-f="all">全部 ${d.total}</button>
      <button class="small ${filter === 'weak' ? 'primary' : ''}" data-f="weak">只看薄弱的</button>
      <button class="small ${filter === 'star4' ? 'primary' : ''}" data-f="star4">只看 4★ 以上</button>
    </div>
    <p class="sub">点击术语查看释义（默认折叠，先自己回想一遍）</p>
    <div id="list"></div>`;
  m.appendChild(w);
  w.querySelector('[data-t="today"]').onclick = () => { location.hash = `#/course/${id}`; };
  w.querySelector('#q').oninput = debounce((e) => viewBrowse(id, e.target.value, filter), 220);
  w.querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => viewBrowse(id, q, b.dataset.f);
  });

  const list = w.querySelector('#list');
  const groups = d.groups || {};
  for (const pg of Object.keys(groups).sort((a, b) => Number(a) - Number(b))) {
    list.appendChild(el('div', 'group-title', `第 ${pg} 页`));
    for (const c of groups[pg]) {
      const row = el('div', 'cardrow');
      row.innerHTML = `<span class="t">${esc(c.front)}</span>
        <span class="star">${'★'.repeat(c.importance)}</span>
        <span class="pg">${c.st === 'graduated' ? '已毕业' : c.st === 'new' ? '新' : c.st}</span>`;
      row.onclick = () => { location.hash = `#/card/${c.id}`; };
      list.appendChild(row);
    }
  }
  if (!Object.keys(groups).length) list.appendChild(el('div', 'empty', '没找到'));
}

// ---------------- 卡片详情 / 编辑器 ----------------
async function viewCard(id) {
  const d = await api('GET', `/api/card/${id}`);
  const c = d.card;
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <button class="ghost small" onclick="history.back()">← 返回</button>
    </div>
    <div class="detail">
      <div class="term">${esc(c.front)}</div>
      <div class="meta">${'★'.repeat(c.importance)}${'☆'.repeat(5 - c.importance)} · 第 ${c.source_page} 页 · ${c.st}</div>
      <div class="body" id="cardBody">${esc(c.back)}</div>
      ${c.image_path ? `<div class="cardimg"><img src="${imgUrl(c.image_path)}" alt="配图" loading="lazy"></div>` : ''}
      ${d.samePage.length ? `<div class="rel"><div class="sub" style="margin-bottom:4px">同一页的其他概念</div>
        ${d.samePage.map((x) => `<a data-go="${x.id}">${esc(x.front)}</a>`).join(' · ')}</div>` : ''}
      ${d.relations.length ? `<div class="rel"><div class="sub" style="margin-bottom:4px">相关概念</div>
        ${d.relations.map((r) => `<a data-go="${r.from_card === c.id ? r.to_card : r.from_card}">${esc(r.from_card === c.id ? r.to_front : r.from_front)}</a>`).join(' · ')}</div>` : ''}
      <div class="src">出处：第 ${c.source_page} 页 · origin=${c.origin}</div>
      <div class="row" style="margin-top:18px">
        <button id="btnEdit" class="small">修改</button>
        <button id="btnStar" class="small">⭐ 加入今天的队列</button>
      </div>
      <div id="editor" class="hidden" style="margin-top:18px">
        <input id="eFront" value="${esc(c.front)}">
        <textarea id="eBack">${esc(c.back)}</textarea>
        <div class="row">
          <button id="eSave" class="primary small">保存</button>
          <button id="eCancel" class="ghost small">取消</button>
        </div>
      </div>
    </div>`;
  m.appendChild(w);

  w.querySelectorAll('[data-go]').forEach((a) => {
    a.onclick = () => { location.hash = `#/card/${a.dataset.go}`; };
  });
  $('#btnEdit').onclick = () => $('#editor').classList.toggle('hidden');
  $('#eCancel').onclick = () => $('#editor').classList.add('hidden');
  $('#eSave').onclick = async () => {
    await api('POST', `/api/card/${id}`, { front: $('#eFront').value, back: $('#eBack').value });
    toast('已保存（标为人工修改）');
    viewCard(id);
  };
  $('#btnStar').onclick = () => toast('已加入队列（下一版实现精确插入）');
}

// ---------------- 设置 ----------------
async function viewSettings() {
  const d = await api('GET', '/api/settings');
  const p = d.profile;
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <h1>设置</h1>
    <h2>学习节奏</h2>
    <div class="detail">
      <div class="row" style="align-items:center;gap:12px">
        <label style="width:140px">每日新卡</label><input id="pNew" type="number" value="${p.daily_new_max}" style="width:120px">
      </div>
      <div class="row" style="align-items:center;gap:12px">
        <label style="width:140px">每日复习卡</label><input id="pRev" type="number" value="${p.daily_review_max}" style="width:120px">
      </div>
      <p class="hint">按课程计算：每门课各自独立（文档 D72）</p>
    </div>
    <h2>显示偏好</h2>
    <div class="detail">
      <label><input type="checkbox" id="pWeek" ${p.show_week ? 'checked' : ''}> 显示周视图</label><br>
      <label><input type="checkbox" id="pProg" ${p.show_progress ? 'checked' : ''}> 显示总进度</label><br>
      <label><input type="checkbox" id="pStreak" ${p.show_streak ? 'checked' : ''}> 显示连续天数</label><br>
      <label><input type="checkbox" id="pSplash" ${p.splash ? 'checked' : ''}> 启动画面</label>
    </div>
    <div class="row" style="margin-top:16px">
      <button id="pSave" class="primary">保存</button>
    </div>
    <h2>高级（折叠）</h2>
    <div class="detail">
      <p class="sub">API 配置、预置仓库、导出——下一版实现。</p>
    </div>`;
  m.appendChild(w);
  $('#pSave').onclick = async () => {
    await api('POST', '/api/settings', {
      daily_new_max: Number($('#pNew').value) || 10,
      daily_review_max: Number($('#pRev').value) || 5,
      show_week: $('#pWeek').checked,
      show_progress: $('#pProg').checked,
      show_streak: $('#pStreak').checked,
      splash: $('#pSplash').checked,
    });
    toast('已保存');
    const b = await api('GET', '/api/bootstrap');
    STATE.profile = b.profile;
  };
}

// ---------------- 导入 ----------------
function openImport() {
  $('#importModal').classList.remove('hidden');
  $('#importLog').textContent = '';
}
async function doImport() {
  const file = $('#importPath').value.trim();
  const courseName = $('#importCourse').value.trim();
  if (!file || !courseName) return toast('路径和课程名都要填');
  $('#importGo').disabled = true;
  $('#importLog').textContent = '解析中…（无 AI，纯本地）';
  const { job } = await api('POST', '/api/import', { file, courseName });
  const poll = setInterval(async () => {
    const j = await api('GET', `/api/job/${job}`);
    $('#importLog').textContent = j.log || '…';
    if (j.status !== 'running') {
      clearInterval(poll);
      $('#importGo').disabled = false;
      if (j.status === 'done') {
        toast('导入完成');
        const b = await api('GET', '/api/bootstrap');
        STATE.courses = b.courses;
        renderSidebar();
        setTimeout(() => { $('#importModal').classList.add('hidden'); }, 900);
      } else {
        toast('导入失败，看日志');
      }
    }
  }, 700);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 点图放大（最小版图片查看器，完整版见文档 24.7）
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.cardimg')) {
    e.target.classList.toggle('zoomed');
  }
});
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
