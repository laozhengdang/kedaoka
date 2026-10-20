// ---------------- 考试模式（定日期，倒推计划） ----------------
async function viewPlan(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const d = await api('GET', `/api/plan/${courseId}`);
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  m.appendChild(w);

  const plan = d.plan;
  const left = plan ? Math.max(0, Math.round((new Date(plan.exam_date) - new Date()) / 86400000)) : 0;
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="plBack">← 返回课程</button>
    </div>
    <h1>考试模式 · ${esc(cname)}</h1>
    <p class="sub">告诉我考试哪天，我算每天得刷多少，并留出复习与缓冲的时间。</p>
    <div class="detail">
      <div class="row" style="align-items:center;gap:12px">
        <label style="width:90px">考试日期</label>
        <input id="plDate" type="date" value="${plan ? plan.exam_date : ''}">
      </div>
      <div class="row" style="margin-top:12px">
        <button id="plCalc" class="primary small">算一下方案</button>
        ${plan ? '<button id="plClear" class="ghost small">取消计划</button>' : ''}
      </div>
      <div id="plOut" style="margin-top:14px">${
        plan ? `<div class="today-card" style="text-align:left">
          <div class="big-num" style="text-align:center">${left}</div>
          <div class="sub" style="text-align:center;margin-bottom:12px">天到考试</div>
          <div>每天新卡目标：<b>${plan.daily_target}</b> 张</div>
          <div>还没毕业：<b>${d.total - d.graduated}</b> / ${d.total} 张</div>
          <div>其中 4★ 以上：<b>${d.fourStar}</b> 张</div>
        </div>` : ''
      }</div>
    </div>`;
  $('#plBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  if (plan) {
    $('#plClear').onclick = async () => {
      await api('POST', `/api/plan/${courseId}/clear`, {});
      toast('已取消考试计划');
      viewPlan(courseId);
    };
  }
  $('#plCalc').onclick = async () => {
    const examDate = $('#plDate').value;
    if (!examDate) return toast('先选考试日期');
    const r = await api('POST', `/api/plan/${courseId}`, { examDate, apply: true });
    const heavy = r.perDay > 60;
    $('#plOut').innerHTML = `
      <div class="today-card" style="text-align:left">
        <div>距考试 <b>${r.days}</b> 天，学习天数按 <b>${r.newDays}</b> 天算（留 40% 给复习与缓冲）</div>
        <div style="margin-top:8px">每天新卡：<b>${r.perDay}</b> 张 · 未毕业 <b>${r.remaining}</b> 张</div>
        ${heavy
    ? `<p class="hint" style="margin-top:10px">每天 ${r.perDay} 张有点猛。两个选择：<br>
         · 只刷 4★ 以上（约 ${d.fourStar} 张），负担降到约 ${Math.max(5, Math.ceil(d.fourStar / r.newDays))} 张/天<br>
         · 或者把考试日期往后挪几天</p>`
    : '<p class="hint" style="margin-top:10px">这个强度可行，关键是每天别断。</p>'}
      </div>`;
  };
}

// ---------------- 学习统计 ----------------
async function viewStats(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const d = await api('GET', `/api/stats/${courseId}`);
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  const grad = (d.byState.find((x) => x.st === 'graduated') || {}).n || 0;
  const max = Math.max(1, ...d.days.map((x) => x.n));
  const bars = d.days.map((x) => {
    const h = Math.max(2, Math.round((x.n / max) * 90));
    return `<div class="stat-col">
      <div class="stat-n">${x.n || ''}</div>
      <div class="stat-bar" style="height:${h}px"></div>
      <div class="stat-day">${x.date.slice(5)}</div>
    </div>`;
  }).join('');
  const chRows = d.chapters.map((c) => {
    const pct = c.total ? Math.round((c.grad || 0) / c.total * 100) : 0;
    return `<div class="row" style="align-items:center;gap:10px;margin:6px 0">
      <span style="width:200px">${esc(c.ch)}</span>
      <span class="bar" style="flex:1"><i style="width:${pct}%"></i></span>
      <span class="sub">${c.grad || 0}/${c.total}</span></div>`;
  }).join('');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="stBack">← 返回课程</button>
    </div>
    <h1>学习统计 · ${esc(cname)}</h1>
    <div class="today-card">
      <div class="sub" style="margin-bottom:10px">最近 7 天复习量</div>
      <div class="stat-chart">${bars}</div>
    </div>
    <div class="detail" style="margin-top:16px">
      <div>总卡片 <b>${d.total}</b> · 已毕业 <b>${grad}</b>（${d.total ? Math.round((grad / d.total) * 100) : 0}%）</div>
      <div style="margin-top:6px">累计复习 <b>${d.reviews.n}</b> 次</div>
    </div>
    <h2 style="margin-top:22px">各章掌握度</h2>
    <div class="detail">${chRows || '<p class="sub">还没有数据</p>'}</div>`;
  m.appendChild(w);
  $('#stBack').onclick = () => { location.hash = `#/course/${courseId}`; };
}

// ---------------- 待审队列（AI 复核刷掉的词） ----------------
async function viewPending(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const d = await api('GET', `/api/pending/${courseId}`);
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="pdBack">← 返回课程</button>
    </div>
    <h1>待审 · ${esc(cname)}</h1>
    <p class="sub">AI 复核时刷掉的候选词。它可能删错了，你可以捞回来。</p>
    <div class="detail" id="pdList"></div>`;
  m.appendChild(w);
  $('#pdBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  const list = $('#pdList');
  if (!d.total) { list.innerHTML = '<p class="sub">没有待审的条目。</p>'; return; }
  for (const it of d.items) {
    const row = el('div', 'cardrow');
    row.innerHTML = `<span class="t">${esc(it.name)}</span>
      <span class="pg">${esc(it.reason || '')}</span>`;
    const box = el('span');
    box.style.marginLeft = 'auto';
    const yes = el('button', 'small', '捞回来');
    yes.onclick = async () => {
      await api('POST', '/api/pending/restore', { itemId: it.id });
      toast('已建卡，记得补释义');
      viewPending(courseId);
    };
    const no = el('button', 'ghost small', '确实不要');
    no.onclick = async () => {
      await api('POST', '/api/pending/drop', { itemId: it.id });
      viewPending(courseId);
    };
    box.append(yes, no);
    row.appendChild(box);
    list.appendChild(row);
  }
}
