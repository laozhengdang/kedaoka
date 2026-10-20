async function viewExam(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const ch = await api('GET', `/api/chapters/${courseId}`);
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  m.appendChild(w);

  // ---------- 第一步：配置 ----------
  let scope = '';
  let count = 20;
  let mins = 0;
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="exBack">← 返回课程</button>
    </div>
    <h1>模拟卷 · ${esc(cname)}</h1>
    <div class="detail">
      <div class="row" style="align-items:center;gap:10px;margin-bottom:14px">
        <label style="width:64px">范围</label>
        <select id="exScope" class="tool-select" style="max-width:420px">
          <option value="">整门课</option>
          ${ch.chapters.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}（${c.n} 个概念）</option>`).join('')}
        </select>
      </div>
      <div class="row" style="align-items:center;gap:10px;margin-bottom:14px">
        <label style="width:64px">题量</label>
        <span id="exCountPick">
          <button class="small" data-n="10">10 题</button>
          <button class="small primary" data-n="20">20 题</button>
          <button class="small" data-n="30">30 题</button>
          <button class="small" data-n="50">50 题</button>
        </span>
      </div>
      <div class="row" style="align-items:center;gap:10px">
        <label style="width:64px">时长</label>
        <span id="exMinPick">
          <button class="small primary" data-m="0">不限时</button>
          <button class="small" data-m="20">20 分钟</button>
          <button class="small" data-m="40">40 分钟</button>
          <button class="small" data-m="60">60 分钟</button>
        </span>
      </div>
      <p class="hint" style="margin-top:12px">答题时可以先标疑题，最后一起看。交卷后每道题都会给解析。</p>
    </div>
    <div class="row" style="margin-top:18px">
      <button id="exStart" class="primary">开始做题</button>
    </div>`;
  $('#exBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  w.querySelectorAll('#exCountPick [data-n]').forEach((b) => {
    b.onclick = () => {
      count = Number(b.dataset.n);
      w.querySelectorAll('#exCountPick [data-n]').forEach((x) => x.classList.toggle('primary', x === b));
    };
  });
  w.querySelectorAll('#exMinPick [data-m]').forEach((b) => {
    b.onclick = () => {
      mins = Number(b.dataset.m);
      w.querySelectorAll('#exMinPick [data-m]').forEach((x) => x.classList.toggle('primary', x === b));
    };
  });
  $('#exStart').onclick = async () => {
    scope = $('#exScope').value;
    const d = await api('POST', `/api/exam/${courseId}/start`, { n: count, chapter: scope, minutes: mins });
    runExamSheet(courseId, cname, d, w);
  };
}

// ---------- 第二步：作答（答题卡 + 倒计时） ----------
function runExamSheet(courseId, cname, d, w) {
  const cards = d.cards;
  const marks = new Array(cards.length).fill(null);  // true/false/null
  const flags = new Array(cards.length).fill(false); // 疑题
  let i = 0;
  let revealed = false;
  const t0 = Date.now();

  w.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <span class="sub" id="exProg"></span>
      <span class="row" style="gap:12px;align-items:center">
        <span class="timer" id="exClock">—</span>
        <button class="ghost small" id="exQuit">交卷并退出</button>
      </span>
    </div>
    <div class="exam-layout">
      <div class="today-card exam-card">
        <div class="ex-term" id="exFront"></div>
        <div class="ex-ans" id="exBack"></div>
        <div class="sub" id="exSrc"></div>
      </div>
      <div class="exam-card-grid" id="exGrid"></div>
    </div>
    <div class="row" style="justify-content:center;margin-top:16px">
      <button id="exShow" class="primary">看答案（空格）</button>
      <button id="exRight" class="small" style="display:none">答对了（←）</button>
      <button id="exWrong" class="small" style="display:none">答错了（→）</button>
      <button id="exFlag" class="ghost small">标记疑题</button>
    </div>`;

  const deadline = d.minutes ? t0 + d.minutes * 60000 : 0;
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const clock = setInterval(() => {
    const el2 = $('#exClock');
    if (!el2) { clearInterval(clock); return; }
    if (!deadline) { el2.textContent = '不限时'; return; }
    const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    el2.textContent = fmt(left);
    el2.classList.toggle('over', left < 300);
    if (left === 0) { clearInterval(clock); toast('时间到了，可以直接交卷'); }
  }, 500);

  const paint = () => {
    const c = cards[i];
    $('#exProg').textContent = `${i + 1} / ${cards.length}　答对 ${marks.filter((x) => x === true).length}　标记 ${flags.filter(Boolean).length}`;
    $('#exFront').textContent = c.front;
    $('#exBack').textContent = c.back || '（没有释义）';
    $('#exBack').style.visibility = revealed ? 'visible' : 'hidden';
    $('#exSrc').textContent = c.chapter ? `${c.chapter} · 第 ${c.source_page} 页` : `第 ${c.source_page} 页`;
    $('#exShow').style.display = revealed ? 'none' : '';
    $('#exRight').style.display = revealed ? '' : 'none';
    $('#exWrong').style.display = revealed ? '' : 'none';
    $('#exFlag').textContent = flags[i] ? '取消标记' : '标记疑题';

    // 答题卡
    const grid = $('#exGrid');
    grid.innerHTML = '<div class="sub" style="margin-bottom:6px">答题卡</div>';
    const box = el('div', 'exam-grid');
    cards.forEach((c2, k) => {
      const b = el('button', 'exam-cell');
      b.textContent = String(k + 1);
      if (marks[k] === true) b.classList.add('ok');
      if (marks[k] === false) b.classList.add('bad');
      if (flags[k]) b.classList.add('flag');
      if (k === i) b.classList.add('cur');
      b.onclick = () => { i = k; revealed = marks[k] !== null; paint(); };
      box.appendChild(b);
    });
    grid.appendChild(box);
    const submit = el('button', 'primary small', '交卷');
    submit.style.marginTop = '10px';
    submit.onclick = () => finishExam();
    grid.appendChild(submit);
  };

  const answer = async (ok) => {
    const c = cards[i];
    marks[i] = ok;
    await api('POST', '/api/exam/answer', { attemptId: d.attemptId, cardId: c.id, correct: ok });
    // 跳到下一道没答的题
    const next = marks.findIndex((x, k) => x === null && k > i);
    const anyUndone = marks.findIndex((x) => x === null);
    i = next >= 0 ? next : (anyUndone >= 0 ? anyUndone : i);
    revealed = false;
    if (marks.every((x) => x !== null)) return finishExam();
    paint();
  };

  const finishExam = async () => {
    clearInterval(clock);
    const used = Math.round((Date.now() - t0) / 60000);
    const r = await api('POST', '/api/exam/finish', { attemptId: d.attemptId, minutes: used });
    showExamResult(courseId, cname, r, w, used, d.scope);
  };

  $('#exShow').onclick = () => { revealed = true; paint(); };
  $('#exRight').onclick = () => answer(true);
  $('#exWrong').onclick = () => answer(false);
  $('#exFlag').onclick = () => { flags[i] = !flags[i]; paint(); };
  $('#exQuit').onclick = () => finishExam();

  const key = (e) => {
    if (!document.body.contains(w)) { window.removeEventListener('keydown', key); return; }
    if (e.key === ' ') { e.preventDefault(); if (!revealed) { revealed = true; paint(); } }
    if (e.key === 'ArrowLeft' && revealed) answer(true);
    if (e.key === 'ArrowRight' && revealed) answer(false);
    if (e.key === 'f') { e.preventDefault(); flags[i] = !flags[i]; paint(); }
  };
  window.addEventListener('keydown', key);
  paint();
}

// ---------- 第三步：成绩与逐题解析 ----------
function showExamResult(courseId, cname, r, w, usedMin, scope) {
  const pct = r.total ? Math.round((r.right / r.total) * 100) : 0;
  w.innerHTML = `
    <h1>交卷 · ${pct} 分</h1>
    <p class="sub">${esc(cname)} · ${esc(scope || '整门课')} · ${r.total} 题 · 用时约 ${usedMin} 分钟</p>
    <div class="today-card" style="text-align:center">
      <div class="big-num">${r.right} / ${r.total}</div>
      <div class="sub">答对 ${r.right} 题，答错 ${r.total - r.right} 题</div>
      <p class="hint" style="margin-top:10px">答错的已按「完全不记得」打回复习队列，明天会重新出现。</p>
    </div>
    <h2 style="margin-top:24px">逐题解析</h2>
    <div class="detail" id="exDetail"></div>
    <div class="row" style="justify-content:center;margin-top:18px">
      <button id="exAgain" class="primary small">再考一套</button>
      <button id="exWrongBook" class="small">看错题本</button>
      <button id="exBackC" class="ghost small">回课程</button>
    </div>`;
  const box = $('#exDetail');
  r.detail.forEach((x, k) => {
    const ok = x.correct;
    const row = el('div', 'exam-row ' + (ok ? 'ok' : 'bad'));
    row.innerHTML = `
      <div class="exam-row-head">
        <span class="exam-no">${k + 1}</span>
        <span class="t">${esc(x.card ? x.card.front : '（卡片已删除）')}</span>
        <span class="tag">${ok ? '对' : '错'}</span>
      </div>
      <div class="exam-row-body">${esc(x.card ? (x.card.back || '（没有释义）') : '')}</div>`;
    box.appendChild(row);
  });
  $('#exAgain').onclick = () => viewExam(courseId);
  $('#exWrongBook').onclick = () => { location.hash = `#/wrong/${courseId}`; };
  $('#exBackC').onclick = () => { location.hash = `#/course/${courseId}`; };
}

// ---------------- 错题本 ----------------
async function viewWrong(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const d = await api('GET', `/api/wrong/${courseId}`);
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="wbBack">← 返回课程</button>
    </div>
    <h1>错题本 · ${esc(cname)}</h1>
    <p class="sub">最近 30 次模拟卷里做错过的题，错得多的排前面。</p>
    <div class="detail" id="wbList"></div>`;
  m.appendChild(w);
  $('#wbBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  const list = $('#wbList');
  if (!d.total) { list.innerHTML = '<p class="sub">还没有错题。去考一次试试。</p>'; return; }
  const cards = [...d.cards].sort((a, b) => b.times - a.times);
  for (const c of cards) {
    const row = el('div', 'cardrow');
    row.innerHTML = `<span class="t">${esc(c.front)}</span>
      <span class="pg">错 ${c.times} 次 · 第 ${c.source_page} 页</span>`;
    row.onclick = () => { location.hash = `#/card/${c.id}`; };
    list.appendChild(row);
  }
}
