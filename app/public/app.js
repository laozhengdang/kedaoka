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
  const prof = STATE.profession || '兽医学';
  const ids = (STATE.professions || []).filter((p) => p.name === prof).map((p) => p.id);
  const list = STATE.courses.filter((c) => !ids.length || ids.includes(c.profession_id));
  for (const c of list) {
    const started = c.today.total > 0;
    const left = Math.max(0, c.today.total - c.today.done);
    const row = el('div', `course ${started ? 'on' : ''} ${STATE.current === c.id ? 'active' : ''}`);
    row.innerHTML = `<span class="dot"></span><span class="name">${esc(c.name)}</span>
      <span class="n">${started ? left : '–'}</span>`;
    row.onclick = () => { location.hash = `#/course/${c.id}`; };
    box.appendChild(row);
  }
  if (!list.length) {
    box.appendChild(el('div', 'empty', STATE.courses.length
      ? `「${esc(prof)}」下还没有课程`
      : '还没有课程<br><br>点下面「新建学科」'));
  }
}

// ---------------- 第一栏：工具 ----------------
const FOCUS = { running: false, t0: 0, acc: 0, milestones: [], full: false };

// 时钟绘制（工具区小钟 + 专注界面大钟一起刷）
function paintClockGlobal() {
  const ms = FOCUS.acc + (FOCUS.running ? Date.now() - FOCUS.t0 : 0);
  const s = Math.floor(ms / 1000);
  const label = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const text = $('#timerText');
  if (text) text.textContent = label;
  const big = $('#focusClock');
  if (big) big.textContent = label;
  const btn = $('#btnTimer');
  if (btn) btn.classList.toggle('running', FOCUS.running);
  const hint = $('#timerHint');
  if (hint) hint.textContent = FOCUS.running ? '计时中 · 再次点开可暂停' : '点一下进入专注计时';
}

function bindTools() {
  // 独立计时器：点一下进入独占全屏的专注界面
  const btn = $('#btnTimer');
  btn.onclick = () => openFocus();

  // 科目（方向）+ 新建科目
  const pick = $('#profPick');
  const names = (STATE.professions || []).map((p) => p.name);
  for (const n of ['兽医学', '草业科学', '动物科学']) if (!names.includes(n)) names.push(n);
  pick.innerHTML = names
    .map((n) => `<option${n === (STATE.profession || '兽医学') ? ' selected' : ''}>${esc(n)}</option>`)
    .join('') + '<option value="__new">＋ 新建科目…</option>';
  pick.onchange = async () => {
    if (pick.value === '__new') { pick.value = STATE.profession || '兽医学'; openNewProf(); return; }
    const name = pick.value;
    await api('POST', '/api/profession', { name });
    STATE.profession = name;
    renderSidebar();
    toast(`已切换到「${name}」，AI 提示词同步换成该专业`);
  };

  // 主题下拉
  const tp = $('#themePick');
  paintThemeChips();
  tp.onchange = async () => {
    if (tp.value === 'custom') { openThemeModal(); return; }
    applyTheme(tp.value);
    await api('POST', '/api/settings', { theme: tp.value });
    const b = await api('GET', '/api/bootstrap');
    STATE.profile = b.profile;
    applyTheme(tp.value);
  };

  bindFocus();
  bindThemeModal();
  bindNewProf();
  if (!window.__toolsTicked) {
    window.__toolsTicked = true;
    setInterval(() => { if (FOCUS.running) paintClockGlobal(); }, 500);
  }
  paintClockGlobal();
}

// ---------- 专注计时器 ----------
function openFocus() {
  const scr = $('#focusScreen');
  scr.classList.remove('hidden');
  if (window.nativeApi && window.nativeApi.setFullscreen) window.nativeApi.setFullscreen(true);
  FOCUS.full = true;
  const toggle = $('#focusToggle');
  toggle.textContent = FOCUS.running ? '暂停' : '开始';
  $('#focusMsg').textContent = FOCUS.running ? '正在专注…' : '点「开始」就进入专注';
}

function closeFocus() {
  $('#focusScreen').classList.add('hidden');
  if (window.nativeApi && window.nativeApi.setFullscreen) window.nativeApi.setFullscreen(false);
  FOCUS.full = false;
  $('#focusMsg').textContent = '';
  $('#focusMsg').classList.remove('hit');
}

function bindFocus() {
  const toggle = $('#focusToggle');
  toggle.onclick = () => {
    if (FOCUS.running) {
      FOCUS.acc += Date.now() - FOCUS.t0;
      FOCUS.running = false;
      toggle.textContent = '继续';
      $('#focusMsg').textContent = '已暂停';
    } else {
      FOCUS.t0 = Date.now();
      FOCUS.running = true;
      toggle.textContent = '暂停';
      $('#focusMsg').textContent = '正在专注…';
      $('#focusMsg').classList.remove('hit');
    }
  };
  $('#focusExit').onclick = closeFocus;

  // 里程碑鼓励
  const REWARD = [
    [30 * 60, '已经坐了 30 分钟，喝口水，接着来。'],
    [60 * 60, '整整 1 小时了。你今天比昨天更稳。'],
    [90 * 60, '1 小时 30 分 —— 这个强度已经超过大多数人了。'],
    [120 * 60, '2 小时。真的，去站起来走两步。'],
    [180 * 60, '3 小时，你已经进入状态了，别硬撑，休息 10 分钟。'],
  ];
  setInterval(() => {
    if (!FOCUS.running) return;
    const s = Math.floor((FOCUS.acc + Date.now() - FOCUS.t0) / 1000);
    for (const [at, msg] of REWARD) {
      if (s >= at && !FOCUS.milestones.includes(at)) {
        FOCUS.milestones.push(at);
        const m = $('#focusMsg');
        if (m && !$('#focusScreen').classList.contains('hidden')) {
          m.textContent = msg;
          m.classList.add('hit');
        }
        toast(msg);
      }
    }
  }, 1000);
}

// 键盘：Esc 退出专注
window.addEventListener('keydown', (e) => {
  const scr = $('#focusScreen');
  if (e.key === 'Escape' && scr && !scr.classList.contains('hidden')) {
    e.preventDefault();
    closeFocus();
  }
});

// ---------- 新建科目：让 AI 现编提示词 ----------
let NEW_PROF = null;

function openNewProf() {
  NEW_PROF = null;
  $('#newProfName').value = '';
  $('#newProfOut').classList.add('hidden');
  $('#newProfOut').textContent = '';
  $('#newProfActions').classList.add('hidden');
  $('#newProfModal').classList.remove('hidden');
  $('#newProfName').focus();
}

function bindNewProf() {
  $('#newProfClose').onclick = () => $('#newProfModal').classList.add('hidden');
  $('#newProfGen').onclick = async () => {
    const name = $('#newProfName').value.trim();
    if (!name) return toast('先填专业名称');
    const out = $('#newProfOut');
    out.classList.remove('hidden');
    out.textContent = `正在让 AI 为「${name}」写判断依据…`;
    $('#newProfActions').classList.add('hidden');
    try {
      const r = await api('POST', '/api/profession/hint', { name });
      NEW_PROF = r;
      out.textContent =
        `术语范围：${r.hint}\n\n` +
        `例子：${(r.examples || []).join('、') || '—'}\n\n` +
        `不抽这些：${(r.avoid || []).join('；') || '—'}`;
      $('#newProfActions').classList.remove('hidden');
    } catch (e) {
      out.textContent = '生成失败：' + (e.message || e);
    }
  };
  $('#newProfSave').onclick = async () => {
    if (!NEW_PROF) return;
    const name = NEW_PROF.name;
    await api('POST', '/api/profession', { name });
    STATE.profession = name;
    const b = await api('GET', '/api/bootstrap');
    STATE.professions = b.professions || [];
    STATE.courses = b.courses;
    $('#newProfModal').classList.add('hidden');
    bindTools();          // 重新渲染科目下拉
    renderSidebar();
    toast(`已新建「${name}」并切换过去`);
  };
}

// ---------- 自定义主题 ----------
let THEME_TMP = null;

function parseCustom() {
  try {
    const raw = STATE.profile && STATE.profile.theme_custom;
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function openThemeModal() {
  const c = parseCustom();
  $('#cBg').value = c.bg || '#fbfbf9';
  $('#cPanel').value = c.panel || '#ffffff';
  $('#cInk').value = c.ink || '#1b1b1b';
  $('#cAccent').value = c.accent || '#003399';
  THEME_TMP = { ...c };
  $('#bgName').textContent = c.bgImage ? c.bgImage.split('/').pop() : '未选';
  $('#themeModal').classList.remove('hidden');
}

function bindThemeModal() {
  $('#themeClose').onclick = () => {
    $('#themeModal').classList.add('hidden');
    paintThemeChips();
  };
  $('#btnBgPick').onclick = async () => {
    if (!window.nativeApi || !window.nativeApi.pickImage) return toast('网页版不支持选图');
    const files = await window.nativeApi.pickImage();
    if (!files || !files.length) return;
    const rel = await window.nativeApi.importBackground(files[0]);
    THEME_TMP.bgImage = rel;
    $('#bgName').textContent = rel.split('/').pop();
  };
  $('#btnBgClear').onclick = () => {
    THEME_TMP.bgImage = '';
    $('#bgName').textContent = '未选';
  };
  $('#themeApply').onclick = async () => {
    const c = {
      bg: $('#cBg').value,
      panel: $('#cPanel').value,
      ink: $('#cInk').value,
      accent: $('#cAccent').value,
      bgImage: (THEME_TMP && THEME_TMP.bgImage) || '',
    };
    await api('POST', '/api/settings', { theme: 'custom', theme_custom: JSON.stringify(c) });
    const b = await api('GET', '/api/bootstrap');
    STATE.profile = b.profile;
    applyTheme('custom');
    $('#themeModal').classList.add('hidden');
    toast('自定义主题已应用');
  };
  $('#themeReset').onclick = async () => {
    await api('POST', '/api/settings', { theme: 'paper', theme_custom: '' });
    const b = await api('GET', '/api/bootstrap');
    STATE.profile = b.profile;
    applyTheme('paper');
    $('#themeModal').classList.add('hidden');
    toast('已恢复默认配色');
  };
}

function paintThemeChips() {
  const cur = (STATE.profile && STATE.profile.theme) || 'paper';
  const sel = $('#themePick');
  if (sel) sel.value = ['paper', 'warm', 'dark', 'custom'].includes(cur) ? cur : 'paper';
  document.querySelectorAll('[data-theme-pick]').forEach((chip) => {
    chip.dataset.on = chip.dataset.themePick === cur ? '1' : '0';
  });
}

// ---------------- 路由 ----------------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const b = await api('GET', '/api/bootstrap');
  STATE.profile = b.profile;
  STATE.courses = b.courses;
  STATE.professions = b.professions || [];
  STATE.profession = b.profession || '兽医学';
  if (window.nativeApi && window.nativeApi.dataDir) {
    STATE.dataDir = await window.nativeApi.dataDir();
  }
  applyTheme(STATE.profile.theme || 'paper');
  renderSidebar();
  bindChrome();
  bindTools();
  route();
}

// 换肤：内置三套走 data-theme，自定义直接覆盖 CSS 变量
function applyTheme(theme) {
  const t = ['paper', 'warm', 'dark', 'custom'].includes(theme) ? theme : 'paper';
  const root = document.documentElement;
  document.documentElement.dataset.theme = t === 'custom' ? 'paper' : t;
  for (const v of ['--bg', '--panel', '--ink', '--accent']) root.style.removeProperty(v);
  document.body.classList.remove('has-bg');
  document.body.style.backgroundImage = '';
  document.body.style.backgroundColor = '';

  if (t === 'custom') {
    const c = parseCustom();
    if (c.bg) root.style.setProperty('--bg', c.bg);
    if (c.panel) root.style.setProperty('--panel', c.panel);
    if (c.ink) root.style.setProperty('--ink', c.ink);
    if (c.accent) root.style.setProperty('--accent', c.accent);
    if (c.bgImage) {
      const url = imgUrl(c.bgImage);
      document.body.style.backgroundImage = `url("${url}")`;
      document.body.style.backgroundColor = c.bg || '';
      document.body.classList.add('has-bg');
    }
  }
  STATE.profile.theme = t;
  paintThemeChips();
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
  const setCollapsed = (on) => {
    $('#sidebar').classList.toggle('collapsed', on);
    const t = $('#btnToggleCourses');
    if (t) t.textContent = on ? '› 显示课程栏' : '‹ 收起课程栏';
    try { localStorage.setItem('coursesCollapsed', on ? '1' : '0'); } catch { /* noop */ }
  };
  $('#btnCollapse').onclick = () => setCollapsed(true);
  $('#btnToggleCourses').onclick = () => setCollapsed(!$('#sidebar').classList.contains('collapsed'));
  try {
    if (localStorage.getItem('coursesCollapsed') === '1') setCollapsed(true);
    else setCollapsed(false);
  } catch { /* noop */ }
  $('#btnSettings').onclick = () => { location.hash = '#/settings'; };
  $('#btnNewCourse').onclick = openNewCourse;
  $('#newCourseClose').onclick = () => $('#newCourseModal').classList.add('hidden');
  $('#newCourseGo').onclick = doNewCourse;
  $('#importClose').onclick = () => $('#importModal').classList.add('hidden');
  $('#importGo').onclick = doImport;
  $('#importPick').onclick = pickImportFile;
  bindDragDrop();
}

// ---------- 选文件 / 拖文件 ----------
async function pickImportFile() {
  if (!window.nativeApi || !window.nativeApi.pickFiles) {
    toast('网页版没有文件选择器，请用桌面版');
    return;
  }
  const files = await window.nativeApi.pickFiles();
  if (!files || !files.length) return;
  $('#importPath').value = files[0];
  $('#importPicked').textContent = files.length > 1 ? `已选 ${files.length} 个（先导入第 1 个）` : '';
  if (files.length > 1) toast(`选了 ${files.length} 个，当前只导入第一个`);
}

// 拖拽整个窗口：把文件字节交给主进程落盘，拿到真实绝对路径
let dragOverlay = null;
function bindDragDrop() {
  const showHint = (on) => {
    if (on && !dragOverlay) {
      dragOverlay = el('div', 'drop-hint', '松手就导入');
      document.body.appendChild(dragOverlay);
    } else if (!on && dragOverlay) {
      dragOverlay.remove();
      dragOverlay = null;
    }
  };
  window.addEventListener('dragenter', (e) => { e.preventDefault(); showHint(true); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); showHint(true); });
  window.addEventListener('dragleave', (e) => {
    if (e.clientX <= 0 || e.clientY <= 0) showHint(false);
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    showHint(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    $('#importModal').classList.remove('hidden');
    await intakeDropped(files);
  });
}

async function intakeDropped(files) {
  const log = $('#importLog');
  if (!window.nativeApi || !window.nativeApi.dropFile) {
    log.textContent = '网页版读不到真实路径，请用桌面版。';
    return;
  }
  log.textContent = '正在接收文件…';
  const paths = [];
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const p = await window.nativeApi.dropFile(f.name, new Uint8Array(buf));
      paths.push(p);
    } catch (err) {
      log.textContent = '接收失败：' + (err.message || err);
      return;
    }
  }
  $('#importPath').value = paths[0];
  $('#importPicked').textContent = paths.length > 1 ? `还有 ${paths.length - 1} 个待导入` : '';
  log.textContent = `已接收：\n${paths.join('\n')}\n点「开始导入」继续。`;
  if (paths.length > 1) toast(`收到 ${paths.length} 个文件，先导入第一个`);
}

// ---------- 新建学科 ----------
function openNewCourse() {
  $('#newCourseModal').classList.remove('hidden');
  $('#newCourseName').value = '';
  $('#newCourseProf').value = '';
  $('#newCourseName').focus();
}

async function doNewCourse() {
  const name = $('#newCourseName').value.trim();
  if (!name) return toast('先填学科名');
  try {
    const r = await api('POST', '/api/course', {
      name,
      profession: $('#newCourseProf').value.trim() || '兽医学',
    });
    $('#newCourseModal').classList.add('hidden');
    const b = await api('GET', '/api/bootstrap');
    STATE.courses = b.courses;
    renderSidebar();
    toast(`已创建学科「${r.name}」`);
    location.hash = `#/course/${r.id}`;
  } catch (e) {
    toast('创建失败：' + (e.message || e));
  }
}

async function route() {
  endReview();
  const h = location.hash || '#/';
  const parts = h.replace(/^#\//, '').split('/');
  if (parts[0] === 'course' && parts[1]) return viewCourse(parts[1]);
  if (parts[0] === 'browse' && parts[1]) return viewBrowse(parts[1]);
  if (parts[0] === 'graph' && parts[1]) return viewGraph(parts[1]);
  if (parts[0] === 'card' && parts[1]) return viewCard(parts[1]);
  if (parts[0] === 'exam' && parts[1]) return viewExam(parts[1]);
  if (parts[0] === 'diagram' && parts[1]) return viewDiagram(parts[1], parts[2] || '');
  if (parts[0] === 'broken' && parts[1]) return viewBroken(parts[1]);
  if (parts[0] === 'outline' && parts[1]) return viewOutline(parts[1]);
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
    <p class="sub">${STATE.courses.length} 门课程 · 待刷 ${totalLeft} 张</p>
    ${ST (STATE.profile.quote || '')}`;
  if (!STATE.courses.length) {
    w.appendChild(el('div', 'empty', '还没有课程。点左下「新建学科」开始。'));
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
    <p class="sub">共 ${d.course.cards || ''} 张卡 · 理论 ${d.course.kinds?.theory || 0} / 实验 ${d.course.kinds?.lab || 0}
      · ${d.course.mode === 'calc' ? '计算型' : '概念型'}</p>
    <div class="row" style="margin:10px 0 4px">
      <button id="btnImportHere" class="small primary">＋ 导入课件到本学科</button>
      <button id="btnRefine" class="small">用 AI 重新整理术语</button>
      <button id="btnOutline" class="small">一键复习清单</button>
      <button id="btnExam" class="small">模拟考</button>
      <button id="btnBroken" class="small">待修</button>
      <button id="btnDiagrams" class="small">机制图</button>
    </div>
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
  const rb = w.querySelector('#btnRefine');
  if (rb) rb.onclick = () => startRefine(id);
  const ib = w.querySelector('#btnImportHere');
  if (ib) ib.onclick = () => openImport(d.course.name);
  const ob = w.querySelector('#btnOutline');
  if (ob) ob.onclick = () => startOutline(id);
  const eb = w.querySelector('#btnExam');
  if (eb) eb.onclick = () => { location.hash = `#/exam/${id}`; };
  const bb = w.querySelector('#btnBroken');
  if (bb) bb.onclick = () => { location.hash = `#/broken/${id}`; };
  const db2 = w.querySelector('#btnDiagrams');
  if (db2) db2.onclick = () => { location.hash = `#/diagram/${id}`; };

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
      <div class="sub">今天完成 ${d.queue.done} / ${d.queue.total}</div>
      ${d.queue.left ? `<div class="sub" style="margin-top:6px">今天还有 ${d.queue.left} 张新卡没排上</div>` : ''}</div>`;
    const row = el('div', 'row');
    row.style.marginTop = '16px';
    row.style.justifyContent = 'center';
    const b1 = el('button', 'primary', '看结算');
    b1.onclick = () => { location.hash = `#/summary/${id}`; };
    const b2 = el('button', 'small', '再来一轮（随机 20 张）');
    b2.onclick = async () => {
      b2.disabled = true;
      b2.textContent = '正在排卡…';
      const r = await api('POST', `/api/queue/extra/${id}`, { count: 20 });
      toast(`已排好第 ${r.round + 1} 轮，共 ${r.count} 张`);
      await viewCourse(id);
    };
    row.appendChild(b1);
    row.appendChild(b2);
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
      <span class="rev-clocks">
        <span class="timer" id="revTimer" title="这张卡用时">0:00</span>
        <span class="timer session" id="revSession" title="本轮累计（不限时）">本轮 0:00</span>
      </span>
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
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const sessSec = Math.floor((Date.now() - REVIEW.t0) / 1000);
  const sess = $('#revSession');
  if (sess) sess.textContent = `本轮 ${fmt(sessSec)}`;

  const t = $('#revTimer');
  if (!t) return;
  const cardSec = Math.floor((Date.now() - REVIEW.cardT0) / 1000);
  t.textContent = fmt(cardSec);

  // 卡片计时器：超时只提醒，不替用户作答
  if (REVIEW.phase === 'ask' && !REVIEW.autoDue) {
    const limit = Number(STATE.profile?.card_timer_sec || 90);
    const on = STATE.profile?.card_timer !== false;
    if (on && cardSec >= limit) {
      REVIEW.autoDue = true;         // 只用来避免重复触发
      t.classList.add('over');
      t.title = '这张已超时';
      const hint = $('#revHint');
      if (hint) hint.textContent = '这张超时了，凭直觉选一个就行';
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
      <div class="meta">${stars(c.importance)} · 第 ${c.source_page} 页</div>
      <div class="choices">
        <button class="choice r1" data-r="1">记得<small>以后不用再考</small><span class="kbd">1</span></button>
        <button class="choice r2" data-r="2">记得<small>不用看概念</small><span class="kbd">2</span></button>
        <button class="choice r3" data-r="3">模糊<small>要看概念</small><span class="kbd">3</span></button>
        <button class="choice r4" data-r="4">不会<small>完全不记得</small><span class="kbd">4</span></button>
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
      <div class="meta">第 ${c.source_page} 页 · ${stars(c.importance)}</div>
      <div class="answer"><div class="label">课件原文</div>${esc(c.back || '（这一页没有抽到上下文）')}</div>
      <div id="revDia"></div>
      ${c.image_path ? `<div class="cardimg"><img src="${imgUrl(c.image_path)}" alt="配图" loading="lazy"></div>` : ''}
      <div class="row" style="justify-content:center;margin-top:26px">
        <button class="primary" id="btnNext">下一张 <span class="kbd">空格</span></button>
      </div>`;
    $('#btnNext').onclick = nextCard;
    // 这张卡挂了机制图就画在释义下面（最多两张，别把屏幕占满）
    const shelf = $('#revDia');
    for (const dg of (c.diagrams || []).slice(0, 2)) {
      const holder = el('div', 'rev-dia');
      const cap = el('div', 'sub', dg.title);
      holder.appendChild(cap);
      const canvas = el('div');
      holder.appendChild(canvas);
      shelf.appendChild(holder);
      api('GET', `/api/diagram/${dg.id}`).then((data) => paintDiagram(canvas, data, { scale: 0.8 }));
    }
  }
  playEnter(inner);
}

// 每次重画内容都重新触发一次入场动画（先摘掉 class，强制回流，再戴上）
function playEnter(node) {
  if (!node) return;
  node.classList.remove('enter');
  void node.offsetWidth;
  node.classList.add('enter');
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

// ---------------- 考试模式 ----------------
async function viewExam(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const q = Number(new URLSearchParams((location.hash.split('?')[1] || '')).get('n')) || 20;
  const d = await api('GET', `/api/exam/${courseId}?n=${q}`);
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  if (!d.cards.length) {
    w.innerHTML = `<h1>模拟考</h1><p class="sub">这门课还没有可考的卡片。</p>`;
    m.appendChild(w);
    return;
  }
  let i = 0;
  let revealed = false;
  const marks = [];   // true=对 false=错

  w.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <span class="sub" id="exCount"></span>
      <button class="ghost small" id="exQuit">退出考试</button>
    </div>
    <div class="today-card exam-card">
      <div class="ex-term" id="exFront"></div>
      <div class="ex-ans" id="exBack"></div>
      <div class="sub" id="exSrc"></div>
    </div>
    <div class="row" style="justify-content:center;margin-top:18px">
      <button id="exShow" class="primary">看答案（空格）</button>
      <button id="exRight" class="small" style="display:none">答对了（←）</button>
      <button id="exWrong" class="small" style="display:none">答错了（→）</button>
    </div>`;
  m.appendChild(w);

  const paint = () => {
    const c = d.cards[i];
    $('#exCount').textContent = `${i + 1} / ${d.cards.length}　答对 ${marks.filter(Boolean).length}`;
    $('#exFront').textContent = c.front;
    $('#exBack').textContent = c.back || '（没有释义）';
    $('#exBack').style.visibility = revealed ? 'visible' : 'hidden';
    $('#exSrc').textContent = c.chapter ? `${c.chapter} · 第 ${c.source_page} 页` : `第 ${c.source_page} 页`;
    $('#exShow').style.display = revealed ? 'none' : '';
    $('#exRight').style.display = revealed ? '' : 'none';
    $('#exWrong').style.display = revealed ? '' : 'none';
  };

  const answer = async (ok) => {
    const c = d.cards[i];
    marks.push(ok);
    await api('POST', `/api/exam/${courseId}/result`, { cardId: c.id, correct: ok });
    i += 1;
    revealed = false;
    if (i >= d.cards.length) return finish();
    paint();
  };

  const finish = () => {
    const right = marks.filter(Boolean).length;
    w.innerHTML = `
      <h1>考完了</h1>
      <p class="sub">${esc(d.course)} · ${d.cards.length} 题</p>
      <div class="today-card" style="text-align:center">
        <div class="big-num">${right} / ${d.cards.length}</div>
        <div class="sub">正确率 ${Math.round(right / d.cards.length * 100)}%</div>
        <p class="hint" style="margin-top:10px">答错的题已经按「完全不记得」重置，明天会重新出现。</p>
      </div>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button id="exAgain" class="primary small">再来一套</button>
        <button id="exBack" class="ghost small">回课程</button>
      </div>`;
    $('#exAgain').onclick = () => { location.hash = `#/exam/${courseId}`; location.reload(); };
    $('#exBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  };

  $('#exShow').onclick = () => { revealed = true; paint(); };
  $('#exRight').onclick = () => answer(true);
  $('#exWrong').onclick = () => answer(false);
  $('#exQuit').onclick = () => { location.hash = `#/course/${courseId}`; };

  const key = (e) => {
    if (!document.body.contains(w)) { window.removeEventListener('keydown', key); return; }
    if (e.key === ' ') { e.preventDefault(); if (!revealed) { revealed = true; paint(); } }
    if (e.key === 'ArrowLeft' && revealed) answer(true);
    if (e.key === 'ArrowRight' && revealed) answer(false);
  };
  window.addEventListener('keydown', key);
  paint();
}

// ---------------- 待修队列 ----------------
async function viewBroken(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const d = await api('GET', `/api/broken/${courseId}`);
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="bkBack">← 返回课程</button>
    </div>
    <h1>待修 · ${esc(cname)}</h1>
    <p class="sub">你标记过「释义有误 / 图配错」的卡片。修好点恢复，没救的点删除。</p>
    <div class="detail" id="bkList"></div>`;
  m.appendChild(w);
  $('#bkBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  const list = $('#bkList');
  if (!d.total) { list.innerHTML = '<p class="sub">没有待修的卡，干净。</p>'; return; }
  for (const c of d.cards) {
    const row = el('div', 'cardrow');
    row.innerHTML = `<span class="t">${esc(c.front)}</span>
      <span class="pg">第 ${c.source_page} 页</span>`;
    const ok = el('button', 'small', '恢复');
    ok.onclick = async () => {
      await api('POST', `/api/card/${c.id}/restore`, {});
      toast('已恢复到复习队列');
      viewBroken(courseId);
    };
    const go = el('button', 'ghost small', '查看');
    go.onclick = () => { location.hash = `#/card/${c.id}`; };
    const box = el('span');
    box.style.marginLeft = 'auto';
    box.append(go, ok);
    row.appendChild(box);
    list.appendChild(row);
  }
}

// ---------------- 机制图 ----------------
async function viewDiagram(courseId, diagramId) {
  STATE.current = courseId;
  renderSidebar();
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const list = await api('GET', `/api/diagrams/${courseId}`);
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="diaBack">← 返回课程</button>
      <button class="small" id="diaImport">导入 .drawio 文件</button>
    </div>
    <h1>${esc(cname)} · 机制图</h1>
    <p class="sub">节点文字对得上卡片就能点开。在 draw.io 里画好、导出 .drawio 文件后导进来。</p>
    <div class="row" id="diaList" style="flex-wrap:wrap;gap:8px"></div>
    <div id="diaStageHolder" style="margin-top:18px"></div>`;
  m.appendChild(w);
  $('#diaBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  $('#diaImport').onclick = () => importDiagram(courseId);

  const listBox = $('#diaList');
  if (!list.total) {
    listBox.innerHTML = '<span class="sub">还没有机制图</span>';
  } else {
    for (const d of list.diagrams) {
      const b = el('button', 'small' + (d.id === diagramId ? ' primary' : ''), d.title);
      b.onclick = () => { location.hash = `#/diagram/${courseId}/${d.id}`; };
      listBox.appendChild(b);
    }
  }

  if (diagramId) await renderDiagram(diagramId);
  else if (list.diagrams.length) await renderDiagram(list.diagrams[0].id);
}

async function importDiagram(courseId) {
  if (!window.nativeApi || !window.nativeApi.pickFiles) return toast('网页版不支持选文件');
  const files = await window.nativeApi.pickFiles();
  if (!files || !files.length) return;
  const isDrawio = /\.(drawio|xml)$/i.test(files[0]);
  if (!isDrawio) return toast('请选 .drawio 文件（在 draw.io 里 文件→保存为 .drawio）');
  const xml = await window.nativeApi.readText(files[0]);
  const title = files[0].split(/[\\/]/).pop().replace(/\.drawio$/i, '');
  const r = await api('POST', `/api/diagram/${courseId}`, { xml, title });
  toast(`已导入「${r.title}」`);
  location.hash = `#/diagram/${courseId}/${r.id}`;
  await viewDiagram(courseId, r.id);
}

async function renderDiagram(diagramId) {
  const holder = $('#diaStageHolder');
  const d = await api('GET', `/api/diagram/${diagramId}`);
  paintDiagram(holder, d, {});
}

// 把一张机制图画进任意容器（页面 / 卡片释义 / 复习背面都用它）
function paintDiagram(holder, d, opts = {}) {
  if (!holder) return;
  if (!d.nodes || !d.nodes.length) {
    holder.innerHTML = '<p class="sub">这张图里没解析出节点。</p>';
    return;
  }
  const pad = 24;
  const minX = Math.min(...d.nodes.map((n) => n.x)) - pad;
  const minY = Math.min(...d.nodes.map((n) => n.y)) - pad;
  const W = Math.max(...d.nodes.map((n) => n.x + n.w)) + pad - minX;
  const H = Math.max(...d.nodes.map((n) => n.y + n.h)) + pad - minY;

  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const paths = [];
  for (const e of (d.edges || [])) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const ax = a.x + a.w / 2, ay = a.y + a.h;
    const bx = b.x + b.w / 2, by = b.y;
    let p;
    if (Math.abs(ax - bx) < 8) p = `M ${ax} ${ay} L ${bx} ${by}`;
    else {
      const my = (ay + by) / 2;
      p = `M ${ax} ${ay} L ${ax} ${my} L ${bx} ${my} L ${bx} ${by}`;
    }
    paths.push(`<path d="${p}" fill="none" stroke="var(--edge)" stroke-width="1.4"
      ${e.dashed ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#arrow-${d.diagram ? d.diagram.id : 'x'})"/>`);
  }
  const mid = `arrow-${(d.diagram && d.diagram.id) || 'x'}`;

  const nodesHtml = d.nodes.map((n) => {
    const cls = 'dia-node' + (n.cardId ? ' linked' : '');
    const style = `left:${n.x - minX}px;top:${n.y - minY}px;width:${n.w}px;height:${n.h}px;` +
      `background:${n.fill};border-color:${n.stroke};border-radius:${n.rounded ? 8 : 3}px;` +
      `font-size:${n.fontSize}px;${n.bold ? 'font-weight:600;' : ''}`;
    return `<div class="${cls}" style="${style}" data-card="${n.cardId || ''}">${esc(n.text)}</div>`;
  }).join('');

  holder.innerHTML = `
    <div class="dia-wrap">
      <div class="dia-stage" style="width:${W}px;height:${H}px">
        <svg class="dia-edges" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
          <defs><marker id="${mid}" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)"/></marker></defs>
          ${paths.join('')}
        </svg>
        ${nodesHtml}
      </div>
    </div>`;

  const wrap = holder.querySelector('.dia-wrap');
  const stage = holder.querySelector('.dia-stage');
  const fit = () => {
    const k = Math.min(1, (wrap.clientWidth - 2) / W) * (opts.scale || 1);
    stage.style.transform = `scale(${k})`;
    wrap.style.height = `${H * k}px`;
  };
  requestAnimationFrame(fit);

  holder.querySelectorAll('.dia-node.linked').forEach((n) => {
    n.onclick = () => { location.hash = `#/card/${n.dataset.card}`; };
  });
}

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
  const b3 = el('button', 'small', '再来一轮（随机 20 张）');
  b3.onclick = async () => {
    b3.disabled = true;
    b3.textContent = '正在排卡…';
    const r = await api('POST', `/api/queue/extra/${id}`, { count: 20 });
    toast(`已排好第 ${r.round + 1} 轮，共 ${r.count} 张`);
    location.hash = `#/course/${id}`;
    await viewCourse(id);
  };
  row.append(b1, b2, b3);
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
          `<span class="star">${stars(k.importance)}</span>`;
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
async function viewBrowse(id, q = '', filter = 'all', silent = false, kind = '') {
  STATE.current = id;
  renderSidebar();
  const d = await api('GET', `/api/browse/${id}?q=${encodeURIComponent(q)}&filter=${filter}${kind ? '&kind=' + kind : ''}`);
  const m = $('#main');
  m.innerHTML = '';
  const cname = (STATE.courses.find((x) => x.id === id) || {}).name || '';
  const w = el('div', 'wrap' + (silent ? ' no-anim' : ''));
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
    <div class="row" style="margin-bottom:10px">
      <button class="small ${!kind ? 'primary' : ''}" data-k="">理论+实验</button>
      <button class="small ${kind === 'theory' ? 'primary' : ''}" data-k="theory">只看理论课</button>
      <button class="small ${kind === 'lab' ? 'primary' : ''}" data-k="lab">只看实验课</button>
    </div>
    <p class="sub">点击术语查看释义（默认折叠，先自己回想一遍）</p>
    <div id="list"></div>`;
  m.appendChild(w);
  w.querySelector('[data-t="today"]').onclick = () => { location.hash = `#/course/${id}`; };
  const qEl = w.querySelector('#q');
  qEl.oninput = debounce((e) => viewBrowse(id, e.target.value, filter, true, kind), 220);
  if (silent) { qEl.focus(); const n = qEl.value.length; qEl.setSelectionRange(n, n); }
  w.querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => viewBrowse(id, q, b.dataset.f, false, kind);
  });
  w.querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => viewBrowse(id, q, filter, false, b.dataset.k);
  });

  const list = w.querySelector('#list');
  const groups = d.groups || {};
  for (const pg of Object.keys(groups).sort((a, b) => Number(a) - Number(b))) {
    list.appendChild(el('div', 'group-title', `第 ${pg} 页`));
    for (const c of groups[pg]) {
      const row = el('div', 'cardrow');
      const where = c.chapter ? `${esc(c.chapter)} · 第 ${c.source_page} 页` : `第 ${c.source_page} 页`;
      row.innerHTML = `<span class="t">${esc(c.front)}</span>
        <span class="star">${stars(c.importance)}</span>
        <span class="pg" title="${esc(c.fileName || '')}">${where}</span>`;
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
      <button class="ghost small" id="btnBack">← 返回仓库</button>
    </div>
    <div class="detail">
      <div class="term">${esc(c.front)}</div>
      <div class="meta">${stars(c.importance)} · 第 ${c.source_page} 页 · ${c.st}</div>
      <div class="body" id="cardBody">${esc(c.back)}</div>
      <div id="cardDia"></div>
      <div id="diaPickBox" style="margin-top:6px">
        <button id="btnAttachDia" class="ghost small">＋ 给这张卡挂一张机制图</button>
        <div id="diaPickList" class="hidden" style="margin-top:8px"></div>
      </div>
      ${c.image_path ? `<div class="cardimg"><img src="${imgUrl(c.image_path)}" alt="配图" loading="lazy"></div>` : ''}
      ${d.samePage.length ? `<div class="rel"><div class="sub" style="margin-bottom:4px">同一页的其他概念</div>
        ${d.samePage.map((x) => `<a data-go="${x.id}">${esc(x.front)}</a>`).join(' · ')}</div>` : ''}
      ${d.relations.length ? `<div class="rel"><div class="sub" style="margin-bottom:4px">相关概念</div>
        ${d.relations.map((r) => `<a data-go="${r.from_card === c.id ? r.to_card : r.from_card}">${esc(r.from_card === c.id ? r.to_front : r.from_front)}</a>`).join(' · ')}</div>` : ''}
      <div class="src">出处：${d.source && d.source.chapter ? esc(d.source.chapter) + ' · ' : ''}第 ${c.source_page} 页${d.source && d.source.fileName ? ' · ' + esc(d.source.fileName) : ''} · origin=${c.origin}</div>
      <div class="row" style="margin-top:18px">
        <button id="btnEdit" class="small">修改</button>
        <button id="btnMerge" class="small">并入其它卡（别名合并）</button>
      </div>
      <div id="mergeBox" class="hidden" style="margin-top:16px">
        <p class="hint">输入另一张卡的名字，把它并到那张上去。原标题会存成别名，关系也会一起搬过去。</p>
        <input id="mergeQ" placeholder="输入要并入的术语名，例如 抗原表位">
        <div id="mergeList" class="detail" style="margin-top:8px"></div>
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
  const backBtn = $('#btnBack');
  if (backBtn) backBtn.onclick = () => { location.hash = `#/browse/${c.course_id}`; };

  // 机制图：挂在释义下面；没有就显示一个"挂一张"的入口
  const diaBox = $('#cardDia');
  if (d.diagrams && d.diagrams.length) {
    diaBox.innerHTML = '<div class="sub" style="margin:16px 0 8px">机制图</div>';
    for (const dg of d.diagrams) {
      const one = el('div', 'card-dia');
      const head = el('div', 'row');
      head.style.justifyContent = 'space-between';
      head.innerHTML = `<span class="sub">${esc(dg.title)}</span>`;
      const rm = el('button', 'ghost small', '移除');
      rm.onclick = async () => {
        await api('POST', `/api/card/${c.id}/diagram-remove`, { diagramId: dg.id });
        toast('已移除');
        viewCard(c.id);
      };
      head.appendChild(rm);
      one.appendChild(head);
      const holder = el('div');
      one.appendChild(holder);
      diaBox.appendChild(one);
      api('GET', `/api/diagram/${dg.id}`).then((data) => paintDiagram(holder, data, { scale: 0.92 }));
    }
  }

  $('#btnAttachDia').onclick = async () => {
    const box = $('#diaPickList');
    box.classList.toggle('hidden');
    if (box.classList.contains('hidden')) return;
    const list = await api('GET', `/api/diagrams/${c.course_id}`);
    box.innerHTML = '';
    if (!list.total) {
      box.innerHTML = '<p class="sub">这门课还没有机制图。到课程页「机制图」里导入 .drawio 文件。</p>';
      return;
    }
    for (const dg of list.diagrams) {
      if ((d.diagrams || []).some((x) => x.id === dg.id)) continue;
      const row = el('div', 'cardrow');
      row.innerHTML = `<span class="t">${esc(dg.title)}</span>`;
      const add = el('button', 'small', '挂上');
      add.onclick = async () => {
        await api('POST', `/api/card/${c.id}/diagram`, { diagramId: dg.id });
        toast('已挂上');
        viewCard(c.id);
      };
      row.appendChild(add);
      box.appendChild(row);
    }
    if (!box.children.length) box.innerHTML = '<p class="sub">这门课的图都挂过了</p>';
  };
  $('#btnEdit').onclick = () => $('#editor').classList.toggle('hidden');
  $('#eCancel').onclick = () => $('#editor').classList.add('hidden');
  $('#eSave').onclick = async () => {
    await api('POST', `/api/card/${id}`, { front: $('#eFront').value, back: $('#eBack').value });
    toast('已保存（标为人工修改）');
    viewCard(id);
  };
  $('#btnMerge').onclick = () => {
    const box = $('#mergeBox');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) $('#mergeQ').focus();
  };
  const doSearch = debounce(async () => {
    const q = $('#mergeQ').value.trim();
    const list = $('#mergeList');
    if (!q) { list.innerHTML = ''; return; }
    const r = await api('GET', `/api/browse/${c.course_id}?q=${encodeURIComponent(q)}`);
    const items = r.cards.filter((x) => x.id !== c.id).slice(0, 8);
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<p class="sub">没找到同名的卡</p>'; return; }
    for (const it of items) {
      const row = el('div', 'cardrow');
      row.innerHTML = `<span class="t">${esc(it.front)}</span>
        <span class="pg">第 ${it.source_page} 页</span>`;
      row.onclick = async () => {
        if (!confirm(`把「${c.front}」并到「${it.front}」？`)) return;
        try {
          const res = await api('POST', `/api/card/${c.id}/merge`, { intoId: it.id });
          toast(`已并入「${res.into}」，"${res.alias}" 存为别名`);
          location.hash = `#/card/${it.id}`;
          viewCard(it.id);
        } catch (e) { toast('合并失败：' + (e.message || e)); }
      };
      list.appendChild(row);
    }
  }, 260);
  $('#mergeQ').oninput = doSearch;
}

// ---------------- 设置 ----------------
async function viewSettings() {
  const d = await api('GET', '/api/settings');
  const ai = await api('GET', '/api/ai/config');
  const p = d.profile;
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <h1>设置</h1>
    <h2>AI 接口</h2>
    <div class="detail" id="aiPanel"></div>
    <h2>外观</h2>
    <div class="detail">
      <p class="hint">配色在第一栏「主题」里切换，这里只管首页那句话。</p>
      <div class="row" style="align-items:center;gap:12px;margin-top:10px">
        <label style="width:140px">首页一句话</label>
        <input id="pQuote" value="${esc(p.quote || '')}" placeholder="留空则不显示（可用「正文 —— 出处」）">
      </div>
      <p class="hint">写在首页顶上，给自己打气用。</p>
    </div>
    <h2>计时器</h2>
    <div class="detail">
      <label><input type="checkbox" id="pTimer" ${p.card_timer !== false ? 'checked' : ''}> 每张卡计时（超时只提醒，不替你作答）</label>
      <div class="row" style="align-items:center;gap:12px;margin-top:10px">
        <label style="width:140px">超时阈值（秒）</label>
        <input id="pTimerSec" type="number" value="${Number(p.card_timer_sec) || 90}" style="width:120px">
      </div>
      <p class="hint">复习界面右上还有「本轮累计」计时，那个不限时，只是让你知道坐了多久。</p>
    </div>
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
    </div>`;
  m.appendChild(w);  $('#pSave').onclick = async () => {
    await api('POST', '/api/settings', {
      daily_new_max: Number($('#pNew').value) || 10,
      daily_review_max: Number($('#pRev').value) || 5,
      show_week: $('#pWeek').checked,
      show_progress: $('#pProg').checked,
      show_streak: $('#pStreak').checked,
      splash: $('#pSplash').checked,
      theme: STATE.profile.theme || 'paper',
      quote: $('#pQuote').value.trim(),
      card_timer: $('#pTimer').checked,
      card_timer_sec: Number($('#pTimerSec').value) || 90,
    });
    toast('已保存');
    const b = await api('GET', '/api/bootstrap');
    STATE.profile = b.profile;
    applyTheme(STATE.profile.theme || 'paper');
  };

  // 主题：点了立刻生效并保存
  w.querySelectorAll('[data-theme-pick]').forEach((chip) => {
    const on = chip.dataset.themePick === (STATE.profile.theme || 'paper');
    chip.dataset.on = on ? '1' : '0';
    chip.onclick = async () => {
      const t = chip.dataset.themePick;
      applyTheme(t);
      w.querySelectorAll('[data-theme-pick]').forEach((x) => { x.dataset.on = x === chip ? '1' : '0'; });
      await api('POST', '/api/settings', { theme: t });
      const b = await api('GET', '/api/bootstrap');
      STATE.profile = b.profile;
    };
  });

  // ---- AI 配置 ----
  renderAiPanel(ai);
}

// AI 接口面板：未接入 → 表单；接入中 → 进度；成功 → 明确的成功页；失败 → 原因 + 重试
async function renderAiPanel(cfg) {
  const box = $('#aiPanel');
  if (!box) return;

  if (cfg && cfg.hasKey && cfg.status !== 'editing') {
    // 已接入状态（后端确认过 key 在）
    box.innerHTML = `
      <div class="ai-ok">
        <div class="ai-ok-icon">✓</div>
        <div>
          <div class="ai-ok-title">已经接入 AI</div>
          <div class="sub">${esc(cfg.model)} · ${esc(cfg.baseUrl)} · 密钥 ${esc(cfg.keyMask || '已保存')}</div>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button id="aiRecheck" class="primary small">再测一次</button>
        <button id="aiEdit" class="small">修改配置</button>
        <button id="aiGoCourse" class="ghost small">去选一门课试试 ›</button>
      </div>
      <pre id="aiTestOut" class="log hidden"></pre>`;
    $('#aiRecheck').onclick = () => runAiTest(cfg);
    $('#aiEdit').onclick = () => renderAiPanel({ ...cfg, hasKey: cfg.hasKey, status: 'editing' });
    $('#aiGoCourse').onclick = () => { location.hash = '#/'; };
    return;
  }

  box.innerHTML = `
    <p class="hint">接上模型之后，导入/整理时会由 AI 读原文判断"哪些是术语"，比按颜色猜准得多。
      推荐 DeepSeek（便宜够用）。任何 OpenAI 兼容接口都能填。</p>
    <div class="row" style="align-items:center;gap:12px;margin-bottom:6px">
      <label style="width:100px">接口地址</label>
      <input id="aiBase" value="${esc(cfg?.baseUrl || 'https://api.deepseek.com/v1')}" placeholder="https://api.deepseek.com/v1">
    </div>
    <div class="row" style="align-items:center;gap:12px;margin-bottom:6px">
      <label style="width:100px">模型</label>
      <input id="aiModel" value="${esc(cfg?.model || 'deepseek-chat')}" placeholder="deepseek-chat">
    </div>
    <div class="row" style="align-items:center;gap:12px;margin-bottom:6px">
      <label style="width:100px">API Key</label>
      <input id="aiKey" type="password" placeholder="${cfg?.hasKey ? '已保存 ' + esc(cfg.keyMask) + '（留空不改）' : 'sk-... 粘贴到这里'}">
    </div>
    <div class="row" style="align-items:center;gap:12px">
      <label style="width:100px">每批页数</label>
      <input id="aiPer" type="number" value="${cfg?.pagesPerRequest || 3}" style="width:100px">
    </div>
    <div class="row" style="margin-top:14px">
      <button id="aiSaveTest" class="primary">保存并测试连接</button>
      <button id="aiCancel" class="ghost small">取消</button>
    </div>
    <div id="aiStatus" class="ai-status hidden"></div>`;

  if (cfg?.status === 'editing') {
    $('#aiCancel').onclick = async () => renderAiPanel(await api('GET', '/api/ai/config'));
  } else {
    $('#aiCancel').onclick = () => { location.hash = '#/'; };
  }

  $('#aiSaveTest').onclick = async () => {
    const btn = $('#aiSaveTest');
    const st = $('#aiStatus');
    const key = $('#aiKey').value.trim();
    if (!key && !cfg?.hasKey) {
      st.className = 'ai-status bad';
      st.textContent = '请先粘贴 API Key（形如 sk-...）';
      return;
    }
    btn.disabled = true;
    btn.textContent = '正在连接…';
    st.className = 'ai-status';
    st.textContent = '正在保存并连接，请稍候（约 2 秒）…';
    try {
      const body = {
        baseUrl: $('#aiBase').value.trim(),
        model: $('#aiModel').value.trim(),
        pagesPerRequest: Number($('#aiPer').value) || 3,
      };
      if (key) body.apiKey = key;
      const saved = await api('POST', '/api/ai/config', body);
      const r = await api('POST', '/api/ai/test', {});
      st.className = 'ai-status good';
      st.innerHTML = `连接成功：${esc(r.model)} · ${esc(r.baseUrl)}`;
      await new Promise((res) => setTimeout(res, 600));
      renderAiPanel({ ...saved, status: 'ok' });
      toast('AI 已接入 ✓');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '保存并测试连接';
      st.className = 'ai-status bad';
      st.innerHTML = `连接失败：${esc(e.message || String(e))}
        <br><span class="sub">常见原因：Key 复制不全 / Key 没余额 / 接口地址或模型名写错。</span>`;
    }
  };
}

async function runAiTest(cfg) {
  const out = $('#aiTestOut');
  if (out) { out.classList.remove('hidden'); out.textContent = '测试中…'; }
  try {
    const r = await api('POST', '/api/ai/test', {});
    if (out) out.textContent = `连接正常\n模型：${r.model}\n地址：${r.baseUrl}\n返回：${r.sample}`;
    toast('连接正常 ✓');
  } catch (e) {
    if (out) out.textContent = '连接失败：' + (e.message || e);
    toast('连接失败');
  }
}

// ---------------- AI 精修 ----------------
async function startRefine(courseId) {
  const cfg = await api('GET', '/api/ai/config');
  if (!cfg.hasKey && cfg.baseUrl !== 'mock') {
    toast('还没配置 API Key');
    location.hash = '#/settings';
    return;
  }
  const { job } = await api('POST', `/api/refine/${courseId}`, {});
  showRefineBox(job);
}

function showRefineBox(jobId) {
  const box = el('div', 'modal');
  box.id = 'refineBox';
  box.innerHTML = `
    <div class="modal-box" style="width:640px">
      <h3>AI 正在重新整理术语</h3>
      <p class="hint">同一份原文只会调用一次，重复跑不重复花钱。</p>
      <div class="bar"><i id="refBar" style="width:0%"></i></div>
      <div class="sub" id="refStat">准备中…</div>
      <pre class="log" id="refLog" style="max-height:240px"></pre>
      <div class="row"><button id="refClose" class="ghost small">关闭窗口（后台继续）</button></div>
    </div>`;
  document.body.appendChild(box);
  $('#refClose').onclick = () => box.remove();

  const timer = setInterval(async () => {
    const j = await api('GET', `/api/refine-job/${jobId}`);
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    const bar = $('#refBar');
    if (bar) bar.style.width = pct + '%';
    const st = $('#refStat');
    if (st) st.textContent = `${j.done}/${j.total} 页 · 新增 ${j.created || 0} · 更新 ${j.updated || 0}`;
    const log = $('#refLog');
    if (log) log.textContent = (j.log || []).slice(-20).join('\n');
    if (j.status !== 'running') {
      clearInterval(timer);
      if (j.status === 'done') {
        toast(`AI 整理完成：新增 ${j.created} 张`);
        const b = await api('GET', '/api/bootstrap');
        STATE.courses = b.courses;
        renderSidebar();
        setTimeout(() => { box.remove(); route(); }, 1200);
      } else {
        toast('AI 整理失败：' + (j.error || '未知错误'));
      }
    }
  }, 900);
}

// ---------------- 一键复习清单 ----------------
async function startOutline(courseId) {
  const cfg = await api('GET', '/api/ai/config');
  if (!cfg.hasKey && cfg.baseUrl !== 'mock') {
    toast('生成清单需要 AI，先去设置里填 Key');
    location.hash = '#/settings';
    return;
  }
  const { job } = await api('POST', `/api/outline/${courseId}`, {});
  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:760px">
      <h3>正在整理复习清单</h3>
      <p class="hint">把整门课的术语按章节排好，并写一段"融会贯通"的主线。</p>
      <pre class="log" id="olLog">准备中…</pre>
      <div class="row"><button id="olClose" class="ghost small">关闭窗口（后台继续）</button></div>
    </div>`;
  document.body.appendChild(box);
  $('#olClose').onclick = () => box.remove();
  const timer = setInterval(async () => {
    const j = await api('GET', `/api/outline-job/${job}`);
    const log = $('#olLog');
    if (log) log.textContent = (j.log || []).join('\n') || '准备中…';
    if (j.status !== 'running') {
      clearInterval(timer);
      box.remove();
      if (j.status === 'done') { toast('清单已生成'); viewOutline(courseId); }
      else toast('生成失败：' + (j.error || '未知错误'));
    }
  }, 1200);
}

async function viewOutline(courseId) {
  const d = await api('GET', `/api/outline/${courseId}`);
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="olBack">← 返回课程</button>
      <button id="olSave" class="small">导出 Markdown</button>
    </div>
    <h1>${esc(cname)} · 考前必备清单</h1>
    <p class="sub">${d.createdAt ? '生成于 ' + new Date(d.createdAt).toLocaleString('zh-CN') : ''}</p>
    <div class="detail outline" id="olBody"></div>`;
  m.appendChild(w);
  $('#olBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  $('#olBody').innerHTML = mdToHtml(d.content || '（还没有清单，回课程页点「一键复习清单」）');
  $('#olSave').onclick = async () => {
    try {
      const r = await api('POST', '/api/outline-save', { courseId, name: cname });
      toast('已保存：' + (r.path || ''));
    } catch (e) { toast('保存失败：' + (e.message || e)); }
  };
}

// 极简 Markdown 渲染（标题/列表/粗体/段落）
function mdToHtml(md) {
  const lines = String(md).split(/\r?\n/);
  let out = '';
  let inList = false;
  const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let s = esc(line)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
    if (/^###\s+/.test(line)) { closeList(); out += `<h4>${s.replace(/^###\s+/, '')}</h4>`; }
    else if (/^##\s+/.test(line)) { closeList(); out += `<h3>${s.replace(/^##\s+/, '')}</h3>`; }
    else if (/^#\s+/.test(line)) { closeList(); out += `<h2>${s.replace(/^#\s+/, '')}</h2>`; }
    else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${s.replace(/^[-*]\s+/, '')}</li>`;
    } else { closeList(); out += `<p>${s}</p>`; }
  }
  closeList();
  return out;
}

// 导入完成后立刻问一句：要不要顺手用 AI 整理（省得用户自己找按钮）
async function askRefineAfterImport(courseName) {
  const b = await api('GET', '/api/bootstrap');
  const c = b.courses.find((x) => x.name === courseName);
  if (!c) return;
  const cfg = await api('GET', '/api/ai/config');

  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:560px">
      <h3>导入完成 · ${esc(courseName)}</h3>
      <p class="hint">已按课件排版做了一版卡片。要不要现在用 AI 重新整理一遍术语？
        ${cfg.hasKey ? '' : '<br><b>还没配 API Key，先去设置里填。</b>'}</p>
      <div class="row">
        <button id="aiNow" class="primary">现在用 AI 整理</button>
        <button id="aiLater" class="ghost">以后再说</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  $('#aiLater').onclick = () => { box.remove(); location.hash = `#/course/${c.id}`; };
  $('#aiNow').onclick = async () => {
    box.remove();
    if (!cfg.hasKey && cfg.baseUrl !== 'mock') {
      toast('还没配置 API Key');
      location.hash = '#/settings';
      return;
    }
    await startRefine(c.id);
  };
}

// ---------------- 导入 ----------------
// 从学科里点进来时带上学名，输入框锁住，避免导错学科
function openImport(courseName) {
  $('#importModal').classList.remove('hidden');
  $('#importLog').textContent = '';
  const el2 = $('#importCourse');
  const inp = $('#importPath');
  if (courseName) {
    el2.value = courseName;
    el2.readOnly = true;
    el2.style.opacity = '.65';
    $('#importTitle').textContent = `导入课件 · ${courseName}`;
  } else {
    el2.readOnly = false;
    el2.style.opacity = '1';
    $('#importTitle').textContent = '导入课件';
  }
  inp.value = '';
  inp.focus();
}
async function doImport() {
  const file = $('#importPath').value.trim();
  const courseName = $('#importCourse').value.trim();
  if (!file || !courseName) return toast('路径和课程名都要填');
  const kind = document.querySelector('input[name="kind"]:checked')?.value || 'theory';
  $('#importGo').disabled = true;
  $('#importLog').textContent = `解析中…（${kind === 'lab' ? '实验课' : '理论课'}，无 AI，纯本地）`;
  const { job } = await api('POST', '/api/import', { file, courseName, kind });
  const poll = setInterval(async () => {
    const j = await api('GET', `/api/job/${job}`);
    $('#importLog').textContent = j.log || '…';
    if (j.status !== 'running') {
      clearInterval(poll);
      $('#importGo').disabled = false;
      if (j.status === 'done') {
        const b = await api('GET', '/api/bootstrap');
        STATE.courses = b.courses;
        renderSidebar();
        $('#importModal').classList.add('hidden');
        askRefineAfterImport(courseName);
      } else {
        const tail = (j.log || '').split('\n').filter(Boolean).slice(-3).join(' ');
        if (/文件不存在/.test(j.log || '')) {
          toast('找不到这个文件，点「选择文件」重新选一次');
          $('#importLog').textContent = (j.log || '') + '\n\n提示：手动输入的路径可能不完整，请用「选择文件」按钮。';
        } else {
          toast('导入失败：' + (tail || '看日志'));
        }
      }
    }
  }, 700);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 首页那句话：允许写成「正文 —— 出处」，出处用小字
function ST(q) {
  const s = String(q || '').trim();
  if (!s) return '';
  const [body, by] = s.split(/\s*——\s*/);
  return `<div class="quote">${esc(body)}${by ? `<span class="by">—— ${esc(by)}</span>` : ''}</div>`;
}

// 星级：实心用金色，空星用很浅的金灰（不再是灰白一片）
function stars(n) {
  const k = Math.max(0, Math.min(5, Number(n) || 0));
  return `<span class="stars">${'★'.repeat(k)}<span class="dim">${'☆'.repeat(5 - k)}</span></span>`;
}

// 点图放大（最小版图片查看器，完整版见文档 24.7）
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.cardimg')) {
    e.target.classList.toggle('zoomed');
  }
});

// 图片加载失败（文件被删/路径失效）就把那块收起来，别留个破图
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.closest('.cardimg')) {
    t.closest('.cardimg').remove();
  }
}, true);
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
