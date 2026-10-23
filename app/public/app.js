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
const FOCUS = { running: false, t0: 0, acc: 0, milestones: [], full: false, minutes: 0 };

// 时钟绘制（工具区小钟 + 专注界面大钟一起刷；倒计时模式下显示剩余）
function paintClockGlobal() {
  const elapsed = FOCUS.acc + (FOCUS.running ? Date.now() - FOCUS.t0 : 0);
  let label;
  if (FOCUS.minutes) {
    const left = Math.max(0, FOCUS.minutes * 60000 - elapsed);
    const s = Math.ceil(left / 1000);
    label = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    if (left === 0 && FOCUS.running) {
      FOCUS.running = false;
      FOCUS.acc = elapsed;
      const m = $('#focusMsg');
      if (m) { m.textContent = '时间到了。这一轮结束，起来走两步。'; m.classList.add('hit'); }
    }
  } else {
    const s = Math.floor(elapsed / 1000);
    label = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  const text = $('#timerText');
  if (text) text.textContent = label;
  const big = $('#focusClock');
  if (big) big.textContent = label;
  const btn = $('#btnTimer');
  if (btn) btn.classList.toggle('running', FOCUS.running);
  const hint = $('#timerHint');
  if (hint) {
    hint.textContent = FOCUS.minutes
      ? `倒计时 ${FOCUS.minutes} 分钟 · 点一下${FOCUS.running ? '暂停' : '继续'}`
      : (FOCUS.running ? '计时中 · 再次点开可暂停' : '点一下进入专注计时');
  }
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
  bindBalance();
  const calcBtn = $('#btnCalc');
  if (calcBtn) calcBtn.onclick = () => { if (window.MiaoCalcUI) window.MiaoCalcUI.openCalculator(); };
  const calcHandle = $('#calcHandle');
  if (calcHandle) calcHandle.onclick = () => { if (window.MiaoCalcUI) window.MiaoCalcUI.openCalculator({ dock: 'right' }); };
  document.querySelectorAll('#focusPresets [data-m]').forEach((b) => {
    b.onclick = () => {
      const m = Number(b.dataset.m);
      FOCUS.minutes = m;
      FOCUS.acc = 0;
      FOCUS.t0 = Date.now();
      FOCUS.running = m > 0;
      FOCUS.milestones = [];
      document.querySelectorAll('#focusPresets [data-m]').forEach((x) => x.classList.toggle('primary', x === b));
      const msg = $('#focusMsg');
      if (msg) {
        msg.textContent = m > 0 ? `倒计时 ${m} 分钟，开始` : '已切回正计时';
        msg.classList.remove('hit');
      }
      paintClockGlobal();
    };
  });
  if (!window.__toolsTicked) {
    window.__toolsTicked = true;
    setInterval(() => { if (FOCUS.running) paintClockGlobal(); }, 500);
  }
  paintClockGlobal();
}

// ---------- 余额显示 ----------
async function loadBalance(force = false) {
  const btn = $('#btnBalance');
  const text = $('#balanceText');
  if (!btn || !text) return;
  try {
    const b = await api('GET', `/api/ai/balance${force ? '?force=1' : ''}`);
    btn.classList.remove('low', 'dead');
    if (!b.supported) {
      btn.classList.add('dead');
      text.textContent = '未接入';
      btn.title = b.reason || '未配置';
      return;
    }
    const money = Number(b.total || 0);
    text.textContent = `${b.currency === 'CNY' ? '¥' : ''}${money.toFixed(2)}`;
    if (money < 1) {
      btn.classList.add('low');
      if (!window.__lowWarned) {
        window.__lowWarned = true;
        toast(`温馨提示：你的余额只剩 ${money.toFixed(2)} 元了`);
      }
    }
    btn.title = `可用 ${money.toFixed(2)} 元 · 今日 ${b.usage.today.calls} 次调用 · 点一下刷新`;
  } catch (e) {
    btn.classList.add('dead');
    text.textContent = '查不到';
    btn.title = '查余额失败：' + (e.message || e);
  }
}

function bindBalance() {
  const btn = $('#btnBalance');
  if (!btn) return;
  btn.onclick = async () => {
    const text = $('#balanceText');
    if (text) text.textContent = '…';
    await loadBalance(true);
  };
  loadBalance(false);
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
  // 版本号：桌面版从主进程拿；拿不到就写 1
  try {
    if (window.nativeApi && window.nativeApi.appVersion) STATE.appVersion = await window.nativeApi.appVersion();
  } catch { /* 忽略 */ }
  STATE.appVersion = STATE.appVersion || '1';
  setTimeout(() => silentUpdateCheck(), 1500);

  const b = await api('GET', '/api/bootstrap');
  STATE.profile = b.profile;
  STATE.courses = b.courses;
  STATE.professions = b.professions || [];
  STATE.profession = b.profession || '兽医学';
  if (window.nativeApi && window.nativeApi.dataDir) {
    STATE.dataDir = await window.nativeApi.dataDir();
  }
  applyTheme(STATE.profile.theme || 'paper');
  applyButtonStyle(STATE.profile);
  showSplash(STATE.profile);
  renderSidebar();
  bindChrome();
  bindTools();
  route();
  // 第一次用（没课程、没走过引导）→ 三步引导
  if (!STATE.profile.wizard_done && !STATE.courses.length) {
    setTimeout(() => showWizard(), 2000);
  }
}

// ---------- 首次启动引导 ----------
function showWizard() {
  let step = 1;
  let prof = STATE.profession || '兽医学';
  let courseName = '';
  const box = el('div', 'modal');
  document.body.appendChild(box);

  const paint = () => {
    box.innerHTML = `
      <div class="modal-box" style="width:600px">
        <div class="wiz-steps">
          <span class="${step >= 1 ? 'on' : ''}">1 选专业</span>
          <span class="${step >= 2 ? 'on' : ''}">2 建课程</span>
          <span class="${step >= 3 ? 'on' : ''}">3 配 AI</span>
        </div>
        <div id="wizBody"></div>
        <div class="row" style="margin-top:16px;justify-content:space-between">
          <button id="wizSkip" class="ghost small">跳过引导</button>
          <span>
            ${step > 1 ? '<button id="wizPrev" class="ghost small">上一步</button>' : ''}
            <button id="wizNext" class="primary small">${step === 3 ? '完成' : '下一步'}</button>
          </span>
        </div>
      </div>`;
    const body = box.querySelector('#wizBody');

    if (step === 1) {
      body.innerHTML = `
        <h3>你在学哪个方向？</h3>
        <p class="hint">这会决定 AI 判断"什么算术语"的标准。以后可以随时在左栏切换。</p>
        <div class="row" style="gap:10px;margin-top:12px">
          ${['兽医学', '动物科学', '草业科学'].map((n) => `<button class="small ${n === prof ? 'primary' : ''}" data-p="${n}">${n}</button>`).join('')}
        </div>`;
      body.querySelectorAll('[data-p]').forEach((b) => {
        b.onclick = () => { prof = b.dataset.p; paint(); };
      });
    } else if (step === 2) {
      body.innerHTML = `
        <h3>建第一门课</h3>
        <p class="hint">填课程名（例如 兽医免疫学）。建好后进这门课导入课件。</p>
        <input id="wizCourse" placeholder="课程名" value="${esc(courseName)}">
        <p class="sub" style="margin-top:8px">当前方向：${esc(prof)}</p>`;
      box.querySelector('#wizCourse').oninput = (e) => { courseName = e.target.value; };
    } else {
      body.innerHTML = `
        <h3>要不要接 AI？</h3>
        <p class="hint">不接也能用：导入会按课件排版出一版卡片，只是术语质量差一些。<br>
          接上之后可以：AI 整理术语、逐章画机制图、生成复习清单。</p>
        <div class="row" style="gap:10px;margin-top:12px">
          <button id="wizApi" class="primary small">去设置里填 Key</button>
          <span class="sub">推荐 DeepSeek，一份课件几毛钱</span>
        </div>`;
      box.querySelector('#wizApi').onclick = () => {
        finish(true);
        location.hash = '#/settings';
      };
    }

    box.querySelector('#wizSkip').onclick = () => finish(false);
    const next = box.querySelector('#wizNext');
    if (next) next.onclick = async () => {
      if (step === 2 && !courseName.trim()) return toast('先填个课程名');
      if (step === 2) {
        try {
          const r = await api('POST', '/api/course', { name: courseName.trim(), profession: prof });
          await api('POST', '/api/profession', { name: prof });
          const b = await api('GET', '/api/bootstrap');
          STATE.courses = b.courses;
          STATE.profession = prof;
          renderSidebar();
          window.__wizCourseId = r.id;
        } catch (e) { return toast('建课失败：' + (e.message || e)); }
      }
      if (step < 3) { step += 1; paint(); } else finish(true);
    };
    const prev = box.querySelector('#wizPrev');
    if (prev) prev.onclick = () => { step -= 1; paint(); };
  };

  const finish = async (go) => {
    await api('POST', '/api/settings', { wizard_done: true });
    box.remove();
    const id = window.__wizCourseId;
    if (id && go) location.hash = `#/course/${id}`;
  };

  paint();
}

// ---------------- 名言库 ----------------
// 内置 130+ 条（quotes.js）+ 用户在设置里写的；每次启动随机挑，最近 8 条不重复。
function quotePool(profile) {
  const builtin = Array.isArray(window.QUOTES) ? window.QUOTES : [];
  const custom = Array.isArray(profile && profile.quotes)
    ? profile.quotes.filter(Boolean).map((s) => {
      const [text, ...rest] = String(s).split('——');
      return { t: text.trim(), a: rest.join('——').trim() };
    })
    : [];
  const oneLine = (profile && profile.quote) ? String(profile.quote).trim() : '';
  if (oneLine) {
    const [text, ...rest] = oneLine.split('——');
    custom.unshift({ t: text.trim(), a: rest.join('——').trim() });
  }
  return [...custom, ...builtin];
}

function pickQuote(profile) {
  const pool = quotePool(profile).filter((q) => q && q.t);
  if (!pool.length) return { t: '今天记住的每一个概念，都是考场上少慌的一秒。', a: '' };
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('quote_recent') || '[]'); } catch { recent = []; }
  const fresh = pool.filter((q) => !recent.includes(q.t));
  const list = fresh.length ? fresh : pool;
  const pick = list[Math.floor(Math.random() * list.length)];
  const next = [pick.t, ...recent.filter((x) => x !== pick.t)].slice(0, 8);
  try { localStorage.setItem('quote_recent', JSON.stringify(next)); } catch { /* 忽略 */ }
  return pick;
}

// 暴露给自测 / 控制台（不影响功能）
window.MiaoQuotes = { pick: pickQuote, pool: quotePool, home: homeQuote };

// 首页那句：一次会话内固定，重开会换
function homeQuote(profile) {
  if (!STATE.sessionQuote) STATE.sessionQuote = pickQuote(profile);
  const q = STATE.sessionQuote;
  return q.a ? `${q.t}——${q.a}` : q.t;
}

// 启动画面：一句名言，1.8 秒后淡出，点任意处跳过
function showSplash(profile) {
  if (profile && profile.splash === false) return;
  const box = $('#splash');
  if (!box) return;
  const q = pickQuote(profile);
  $('#splashQuote').textContent = q.t;
  const by = $('#splashAuthor');
  if (by) by.textContent = q.a ? `—— ${q.a}` : '';
  box.classList.remove('hidden');
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    box.classList.add('fade');
    setTimeout(() => box.classList.add('hidden'), 380);
    window.removeEventListener('keydown', close);
    box.removeEventListener('click', close);
  };
  setTimeout(close, 1800);
  window.addEventListener('keydown', close);
  box.addEventListener('click', close);
}

// 换肤：内置三套走 data-theme，自定义直接覆盖 CSS 变量
// 功能按钮：彩色（默认）或纯白
function applyButtonStyle(profile) {
  document.body.classList.toggle('plain-buttons', Boolean(profile && profile.plain_buttons));
}

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
  bindSearch();
  $('#aboutClose').onclick = () => $('#aboutModal').classList.add('hidden');
}

// ---------- 全局检索（Ctrl+K） ----------
function bindSearch() {
  const open = () => {
    $('#searchModal').classList.remove('hidden');
    $('#searchQ').value = '';
    $('#searchList').innerHTML = '<p class="sub">输入关键词，跨所有课程搜索</p>';
    $('#searchQ').focus();
  };
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    if (e.key === 'Escape') $('#searchModal').classList.add('hidden');
  });
  const run = debounce(async () => {
    const q = $('#searchQ').value.trim();
    const box = $('#searchList');
    if (!q) { box.innerHTML = '<p class="sub">输入关键词</p>'; return; }
    const d = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    box.innerHTML = '';
    if (!d.total) { box.innerHTML = '<p class="sub">没搜到</p>'; return; }
    for (const h of d.hits) {
      const row = el('div', 'cardrow');
      row.innerHTML = `<span class="t">${esc(h.front)}</span>
        <span class="pg">${esc(h.course)} · 第 ${h.source_page} 页</span>`;
      row.onclick = () => {
        $('#searchModal').classList.add('hidden');
        location.hash = `#/card/${h.id}`;
      };
      box.appendChild(row);
    }
  }, 200);
  $('#searchQ').oninput = run;
  $('#searchQ').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const first = $('#searchList .cardrow');
      if (first) first.click();
    }
  };
}

function showAbout() {
  const b = $('#aboutBody');
  b.innerHTML = `
    <p><b>课到卡</b> · v${esc(STATE.appVersion || '?')}</p>
    <div class="upd-box">
      <div class="upd-row">
        <span class="upd-cur">当前版本 v${esc(STATE.appVersion || '?')}</span>
        <button id="btnCheckUpdate" class="small">检查更新</button>
      </div>
      <div class="upd-msg" id="updMsg">还没检查</div>
      <div class="upd-actions hidden" id="updActions">
        <button id="btnUpdateNow" class="primary small">下载并自动安装</button>
        <button id="btnUpdatePage" class="ghost small">打开发布页</button>
      </div>
      <div class="upd-bar hidden" id="updBarWrap"><div class="upd-bar-in" id="updBar"></div></div>
    </div>
    <p class="sub">界面版本：${esc(document.lastModified || '未知')}　（这个时间要跟源码一致，否则就是没打包成功）</p>
    <p class="sub">课件 → 知识卡 → 间隔重复复习。所有数据都在本机，不上传。</p>
    <p class="sub">GitHub：github.com/laozhengdang（开源版是空白工具，课程数据不在仓库里）</p>
    <p class="sub">技术：Electron + node:sqlite + Python(PyMuPDF) + 任意 OpenAI 兼容接口</p>
    <p class="sub">许可：个人自用，未附许可证文件；引用第三方：Electron(MIT)、PyMuPDF(AGPL)、MuPDF(AGPL)</p>
    <p class="sub">名言库 / 启动图：尚未实现</p>`;
  $('#aboutModal').classList.remove('hidden');
  bindUpdater($('#aboutBody'));
}

// ---------- 选文件 / 拖文件 ----------
async function pickImportFile() {
  if (!window.nativeApi || !window.nativeApi.pickFiles) {
    toast('网页版没有文件选择器，请用桌面版');
    return;
  }
  const files = await window.nativeApi.pickFiles();
  if (!files || !files.length) return;
  STATE.importQueue = files;
  $('#importPath').value = files[0];
  $('#importPicked').textContent = files.length > 1 ? `已选 ${files.length} 个，会依次导入` : '';
  if (files.length > 1) toast(`选了 ${files.length} 个，点「开始导入」会一个一个来`);
  probeFile(files[0]);
}

// 导入前探测：页数、图片数，顺带估个时长与花费
async function probeFile(path) {
  const box = $('#importLog');
  if (box) box.textContent = '正在读文件…';
  try {
    const p = await api('POST', '/api/probe', { file: path });
    // 粗估：每 3 页一批；每批 1 次抽取 + 1 次复核；DeepSeek 一批约 1～2 分钱
    const batches = Math.ceil(p.pages / 3);
    const calls = batches * 2;
    const yuan = (calls * 0.01).toFixed(1);
    const mins = Math.max(1, Math.round(batches * 2.5 / 60));
    if (box) {
      box.textContent =
        `文件：${p.pages} 页 · ${p.images} 张图 · ${p.sizeMB} MB\n` +
        `本地解析：约 1 分钟（不花钱）\n` +
        `AI 整理：约 ${calls} 次调用、${mins} 分钟、粗估 ${yuan} 元（按 DeepSeek 价，仅供参考）`;
    }
  } catch (e) {
    if (box) box.textContent = '探测失败：' + (e.message || e) + '\n（不影响导入，可以直接开始）';
  }
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
  const CHUNK = 8 * 1024 * 1024;   // 一次 8MB，几百 MB 的课件也不会撑爆 IPC

  for (const f of files) {
    try {
      // ① 优先直接拿真实路径：不复制、不读字节，多大的文件都一样快
      let realPath = '';
      if (window.nativeApi.getDroppedPath) {
        try { realPath = window.nativeApi.getDroppedPath(f) || ''; } catch { realPath = ''; }
      }
      if (realPath) {
        paths.push(realPath);
        log.textContent = `已接收：${f.name}（${(f.size / 1048576).toFixed(1)} MB）`;
        continue;
      }

      // ② 拿不到路径就分块写入
      const { id } = await window.nativeApi.dropBegin(f.name, f.size);
      let written = 0;
      for (let off = 0; off < f.size; off += CHUNK) {
        const end = Math.min(off + CHUNK, f.size);
        const buf = await f.slice(off, end).arrayBuffer();
        await window.nativeApi.dropChunk(id, off, new Uint8Array(buf));
        written = end;
        log.textContent = `正在接收 ${f.name}：${Math.round((written / f.size) * 100)}%（${(written / 1048576).toFixed(1)} / ${(f.size / 1048576).toFixed(1)} MB）`;
      }
      const saved = await window.nativeApi.dropEnd(id);
      paths.push(saved.file);
    } catch (err) {
      log.textContent = '接收失败：' + (err.message || err) + '\n（文件太大时容易失败，可以改用「选择文件」按钮）';
      return;
    }
  }
  STATE.importQueue = paths;
  $('#importPath').value = paths[0];
  $('#importPicked').textContent = paths.length > 1 ? `收到 ${paths.length} 个，会依次导入` : '';
  log.textContent = `已接收：\n${paths.join('\n')}\n点「开始导入」继续。`;
  probeFile(paths[0]);
  if (paths.length > 1) toast(`收到 ${paths.length} 个文件，点「开始导入」会一个一个来`);
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
  if (parts[0] === 'spot' && parts[1]) return viewSpot(parts[1]);
  if (parts[0] === 'wrong' && parts[1]) return viewWrong(parts[1]);
  if (parts[0] === 'plan' && parts[1]) return viewPlan(parts[1]);
  if (parts[0] === 'stats' && parts[1]) return viewStats(parts[1]);
  if (parts[0] === 'pending' && parts[1]) return viewPending(parts[1]);
  if (parts[0] === 'batches' && parts[1]) return viewBatches(parts[1]);
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
    ${ST(homeQuote(STATE.profile))}`;
  if (!STATE.courses.length) {
    const guide = el('div', 'detail');
    guide.innerHTML = `
      <h2>先做这四步</h2>
      <ol class="guide-list">
        <li><b>建一门学科</b>：中间栏底部「＋ 新建学科」，填课程名（例如 兽医免疫学）。</li>
        <li><b>导入课件</b>：进这门课 →「＋ 导入课件到本学科」→ 选 PDF / PPTX，或直接拖进来。</li>
        <li><b>配 AI（可选）</b>：左栏「设置」填 API Key，导入后会由 AI 整理术语、画机制图。</li>
        <li><b>每天刷 10 张</b>：课程页「开始今天的」，四档自评即可。</li>
      </ol>
      <div class="row" style="margin-top:14px">
        <button id="gNew" class="primary">现在就建一门</button>
        <button id="gApi" class="ghost">先去配 API</button>
      </div>`;
    w.appendChild(guide);
    guide.querySelector('#gNew').onclick = () => openNewCourse();
    guide.querySelector('#gApi').onclick = () => { location.hash = '#/settings'; };
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
    <div class="row actions" style="margin:10px 0 4px">
      <button id="btnImportHere" class="small btn-tint btn-c-import">＋ 导入课件到本学科</button>
      <button id="btnRefine" class="small btn-tint btn-c-refine">用 AI 重新整理术语</button>
      <button id="btnOutline" class="small btn-tint btn-c-outline">一键复习清单</button>
      <button id="btnExam" class="small btn-tint btn-c-exam">模拟卷</button>
      <button id="btnBroken" class="small btn-tint btn-c-broken">待修</button>
      <button id="btnDiagrams" class="small btn-tint btn-c-diagram">机制图</button>
      <button id="btnSpot" class="small btn-tint btn-c-spot">考前抽检</button>
      <button id="btnBatches" class="small btn-tint btn-c-batches">课件批次</button>
      <button id="btnWrong" class="small btn-tint btn-c-wrong">错题本</button>
      <button id="btnPlan" class="small btn-tint btn-c-plan">考试模式</button>
      <button id="btnStats" class="small btn-tint btn-c-stats">学习统计</button>
      <button id="btnPending" class="small btn-tint btn-c-pending">待审</button>
      <button id="btnDeleteCourse" class="small btn-danger" title="删除这门课和它的全部卡片">删除这门课</button>
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
  const delBtn = w.querySelector('#btnDeleteCourse');
  if (delBtn) delBtn.onclick = () => confirmDeleteCourse(d.course.id || id, d.course.name, d.course.cards);

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
  const pl = w.querySelector('#btnPlan');
  if (pl) pl.onclick = () => { location.hash = `#/plan/${id}`; };
  const stt = w.querySelector('#btnStats');
  if (stt) stt.onclick = () => { location.hash = `#/stats/${id}`; };
  const pnd = w.querySelector('#btnPending');
  if (pnd) pnd.onclick = () => { location.hash = `#/pending/${id}`; };
  const wb = w.querySelector('#btnWrong');
  if (wb) wb.onclick = () => { location.hash = `#/wrong/${id}`; };
  const sp = w.querySelector('#btnSpot');
  if (sp) sp.onclick = () => { location.hash = `#/spot/${id}`; };
  const bt = w.querySelector('#btnBatches');
  if (bt) bt.onclick = () => { location.hash = `#/batches/${id}`; };

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
    const where = c.chapter ? `${esc(c.chapter)} · 第 ${c.source_page} 页` : `第 ${c.source_page} 页`;
    inner.innerHTML = `
      <div class="term">${esc(c.front)}</div>
      <div class="meta">${stars(c.importance)} · ${where}</div>
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
      <div class="meta">${c.chapter ? esc(c.chapter) + ' · ' : ''}第 ${c.source_page} 页 · ${stars(c.importance)}</div>
      <div class="answer"><div class="label">课件原文</div>${esc(c.back || '（这一页没有抽到上下文）')}</div>
      <div id="revRels"></div>
      <div id="revDia"></div>
      ${c.image_path ? `<div class="cardimg"><img src="${imgUrl(c.image_path)}" data-card-id="${c.id}" alt="配图" loading="lazy"></div>` : ''}
      <div class="row" style="justify-content:center;margin-top:26px">
        <button class="primary" id="btnNext">下一张 <span class="kbd">空格</span></button>
      </div>`;
    $('#btnNext').onclick = nextCard;
    // 名词解释下面挂上「包含哪些子概念 / 属于哪个大类」，点一下能看那张卡的释义
    fillRelations($('#revRels'), c.id);
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

// ---------------- 单张自测 / 查看原文 ----------------
function quizSingleCard(c, host) {
  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:560px;text-align:center">
      <div class="ex-term" style="font-size:34px">${esc(c.front)}</div>
      <div class="ex-ans" id="qOneBack" style="visibility:hidden">${esc(c.back || '（没有释义）')}</div>
      <div class="row" style="justify-content:center;margin-top:18px">
        <button id="qShow" class="primary">看答案</button>
        <button id="qRight" class="small" style="display:none">记得</button>
        <button id="qWrong" class="small" style="display:none">不记得</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  $('#qShow').onclick = () => {
    $('#qOneBack').style.visibility = 'visible';
    $('#qShow').style.display = 'none';
    $('#qRight').style.display = '';
    $('#qWrong').style.display = '';
  };
  const rate = async (ok) => {
    await api('POST', '/api/review', { cardId: c.id, rating: ok ? 2 : 4 });
    toast(ok ? '记了「记得」' : '已按「完全不会」重置');
    box.remove();
  };
  $('#qRight').onclick = () => rate(true);
  $('#qWrong').onclick = () => rate(false);
}

async function showPageText(cardId) {
  const d = await api('GET', `/api/page-text/${cardId}`);
  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:680px">
      <h3>原文 · 第 ${d.page} 页</h3>
      <p class="sub">${d.chapter ? esc(d.chapter) + ' · ' : ''}${esc(d.fileName)}</p>
      <pre class="log" style="max-height:52vh;white-space:pre-wrap">${esc(d.text || '（这一页没抽到文字，可能是图片页）')}</pre>
      <div class="row"><button id="pgClose" class="ghost">关闭</button></div>
    </div>`;
  document.body.appendChild(box);
  $('#pgClose').onclick = () => box.remove();
}

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
      <div style="margin-top:6px">累计复习 <b>${d.reviews.n}</b> 次 · 累计用时约 <b>${Math.round((d.reviews.ms || 0) / 60000)}</b> 分钟</div>
    </div>
    <h2 style="margin-top:22px">最近 7 天标记「模糊」的词</h2>
    <p class="sub">这些是你说"要看概念"的，点开能看释义。</p>
    <div class="detail" id="fuzzyList">${(d.fuzzy || []).map((f) => `
      <div class="cardrow" data-card="${f.id}">
        <span class="t">${esc(f.front)}</span>
        <span class="pg">模糊 ${f.times} 次 · 第 ${f.page} 页</span>
      </div>`).join('') || '<p class="sub">这周没有标「模糊」的词。</p>'}</div>
    <h2 style="margin-top:22px">各章掌握度</h2>
    <div class="detail">${chRows || '<p class="sub">还没有数据</p>'}</div>`;
  m.appendChild(w);
  $('#stBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  w.querySelectorAll('#fuzzyList [data-card]').forEach((row) => {
    row.onclick = () => { location.hash = `#/card/${row.dataset.card}`; };
  });
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
      <button class="small primary" id="diaGen">让 AI 画一张</button>
    </div>
    <h1>${esc(cname)} · 机制图</h1>
    <p class="sub">节点文字对得上卡片就能点开。在 draw.io 里画好、导出 .drawio 文件后导进来。</p>
    <div class="row" id="diaList" style="flex-wrap:wrap;gap:8px"></div>
    <div id="diaStageHolder" style="margin-top:18px"></div>`;
  m.appendChild(w);
  $('#diaBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  $('#diaImport').onclick = () => importDiagram(courseId);
  $('#diaGen').onclick = () => generateDiagram(courseId);

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

// 精修后自动逐章画图（导入流程里勾了"顺便画图"就走这里）
async function drawAllChapters(courseId) {
  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:600px">
      <h3>AI 正在画机制图</h3>
      <p class="hint">逐章挑概念、排关系，每章一张，最多 6 张。</p>
      <pre class="log" id="dallLog">准备中…</pre>
    </div>`;
  document.body.appendChild(box);
  const { job } = await api('POST', `/api/diagram-gen/${courseId}`, { all: true });
  const timer = setInterval(async () => {
    const j = await api('GET', `/api/diagram-job/${job}`);
    const log = $('#dallLog');
    if (log) log.textContent = (j.log || []).join('\n') || '准备中…';
    if (j.status !== 'running') {
      clearInterval(timer);
      box.remove();
      if (j.status === 'done') {
        toast(`画好 ${j.made} 张机制图，挂到 ${j.created} 张卡`);
        location.hash = `#/diagram/${courseId}/${j.diagramId}`;
      } else {
        toast('画图失败：' + (j.error || '未知错误'));
      }
    }
  }, 1200);
}

// AI 画图：选章节（或不选=整门课），生成一张关系图
async function generateDiagram(courseId, presetChapter = '') {
  const cfg = await api('GET', '/api/ai/config');
  if (!cfg.hasKey && cfg.baseUrl !== 'mock') {
    toast('画图要用 AI，先去设置里填 Key');
    location.hash = '#/settings';
    return;
  }
  const ch = await api('GET', `/api/chapters/${courseId}`);
  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:560px">
      <h3>让 AI 画一张机制图</h3>
      <p class="hint">AI 会从这门课里挑出 8~14 个有逻辑关系的概念，排出因果/流程，然后自动挂到对应卡片上。</p>
      <div class="row" style="align-items:center;gap:10px">
        <label style="width:70px">范围</label>
        <select id="dgChapter" class="tool-select" style="flex:1">
          <option value="">整门课（合成一张）</option>
          <option value="__all">每一章各画一张（最多 6 张）</option>
          ${ch.chapters.map((c) => `<option value="${esc(c.name)}"${c.name === presetChapter ? ' selected' : ''}>${esc(c.name)}（${c.n} 个概念）</option>`).join('')}
        </select>
      </div>
      <pre class="log hidden" id="dgLog"></pre>
      <div class="row" style="margin-top:12px">
        <button id="dgGo" class="primary">开始画</button>
        <button id="dgClose" class="ghost">取消</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  $('#dgClose').onclick = () => box.remove();
  $('#dgGo').onclick = async () => {
    const chapter = $('#dgChapter').value;
    const all = chapter === '__all';
    const log = $('#dgLog');
    log.classList.remove('hidden');
    log.textContent = all ? 'AI 正在逐章画…' : 'AI 正在读这一章的概念…';
    $('#dgGo').disabled = true;
    const { job } = await api('POST', `/api/diagram-gen/${courseId}`,
      { chapter: all ? '' : chapter, all });
    const timer = setInterval(async () => {
      const j = await api('GET', `/api/diagram-job/${job}`);
      log.textContent = (j.log || []).join('\n') || '思考中…';
      if (j.status !== 'running') {
        clearInterval(timer);
        if (j.status === 'done') {
          toast(`画好了 ${j.made} 张，共挂到 ${j.created} 张卡`);
          box.remove();
          await viewDiagram(courseId, j.diagramId);
        } else {
          $('#dgGo').disabled = false;
          toast('画图失败：' + (j.error || '未知错误'));
        }
      }
    }, 1200);
  };
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
    if (Math.abs(ax - bx) < 8) {
      p = `M ${ax} ${ay} L ${bx} ${by}`;
    } else if (by - ay > 6) {
      const my = (ay + by) / 2;
      p = `M ${ax} ${ay} L ${ax} ${my} L ${bx} ${my} L ${bx} ${by}`;
    } else if (b.y + b.h > a.y && Math.abs((b.x + b.w / 2) - (a.x + a.w / 2)) > 20) {
      // 大致同高：从右侧出、左侧进
      const sx2 = a.x + a.w, sy2 = a.y + a.h / 2;
      const tx2 = b.x, ty2 = b.y + b.h / 2;
      const mx2 = (sx2 + tx2) / 2;
      p = `M ${sx2} ${sy2} L ${mx2} ${sy2} L ${mx2} ${ty2} L ${tx2} ${ty2}`;
    } else {
      const my = (ay + by) / 2;
      p = `M ${ax} ${ay} L ${ax} ${my} L ${bx} ${my} L ${bx} ${by}`;
    }
    paths.push(`<path d="${p}" fill="none" stroke="var(--edge)" stroke-width="1.4"
      ${e.dashed ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#arrow-${d.diagram ? d.diagram.id : 'x'})"/>`);
  }
  const mid = `arrow-${(d.diagram && d.diagram.id) || 'x'}`;

  // 按 draw.io 的形状来画：椭圆/菱形/六边形/圆柱/纯文字…
  const shapeCss = (n) => {
    const base = `border:1px solid ${n.stroke};background:${n.fill};`;
    switch (n.shape) {
      case 'ellipse':
        return base + 'border-radius:50%;';
      case 'rhombus':
        return 'border:none;background:transparent;';
      case 'hexagon':
        return base + 'clip-path:polygon(22% 0,78% 0,100% 50%,78% 100%,22% 100%,0 50%);';
      case 'triangle':
        return base + 'clip-path:polygon(50% 0,100% 100%,0 100%);';
      case 'parallelogram':
        return base + 'transform:skewX(-12deg);';
      case 'trapezoid':
        return base + 'clip-path:polygon(18% 0,82% 0,100% 100%,0 100%);';
      case 'cylinder':
        return base + 'border-radius:50% / 14%;';
      case 'document':
        return base + 'border-radius:3px 3px 40% 3px / 3px 3px 18% 3px;';
      case 'text':
        return 'border:none;background:transparent;';
      case 'rounded':
        return base + 'border-radius:10px;';
      default:
        return base + 'border-radius:3px;';
    }
  };

  const nodesHtml = d.nodes.map((n) => {
    const cls = 'dia-node' + (n.cardId ? ' linked' : '') + (n.shape === 'rhombus' ? ' diamond' : '');
    const style = `left:${n.x - minX}px;top:${n.y - minY}px;width:${n.w}px;height:${n.h}px;` +
      `${shapeCss(n)}` +
      `font-size:${n.fontSize}px;${n.bold ? 'font-weight:600;' : ''}`;
    if (n.shape === 'rhombus') {
      // 菱形用旋转的内层画，文字单独一层不旋转
      return `<div class="${cls}" style="${style}" data-card="${n.cardId || ''}">
        <span class="dia-diamond" style="background:${n.fill};border-color:${n.stroke}"></span>
        <span class="dia-label" ${n.shape === 'parallelogram' ? 'style="transform:skewX(12deg)"' : ''}>${esc(n.text)}</span>
      </div>`;
    }
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

// ---------------- 课件批次 ----------------
async function viewBatches(courseId) {
  STATE.current = courseId;
  renderSidebar();
  const d = await api('GET', `/api/batches/${courseId}`);
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  w.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <button class="ghost small" id="btBack">← 返回课程</button>
    </div>
    <h1>课件批次 · ${esc(cname)}</h1>
    <p class="sub">这门课导入过的所有课件。移除某一批不会删除数据，卡片只会被归档，随时能恢复。</p>
    <div class="detail" id="btList"></div>`;
  m.appendChild(w);
  $('#btBack').onclick = () => { location.hash = `#/course/${courseId}`; };

  const list = $('#btList');
  if (!d.total) { list.innerHTML = '<p class="sub">这门课还没有导入过课件。</p>'; return; }
  for (const b of d.batches) {
    const row = el('div', 'cardrow');
    const docLabel = { ppt: '授课课件', exam: '题库真题', notes: '复习资料', syllabus: '考纲提纲' }[b.doc_type] || '授课课件';
    row.innerHTML = `<span class="t">${esc(b.fileName)}</span>
      <span class="pg">${docLabel} · ${b.kind === 'lab' ? '实验课' : '理论课'} · ${b.pages} 页 · ${b.cards} 张卡${b.active ? '' : ' · 已移除'}</span>`;
    const redo = el('button', 'ghost small', '重跑');
    redo.onclick = async () => {
      if (!confirm(`重跑会删掉这一批现有的卡，按原文件重新解析一遍。继续？`)) return;
      await api('POST', `/api/batch/${b.id}/reparse`, {});
      toast('已开始重跑，几分钟后回来看');
    };
    const btn = el('button', b.active ? 'ghost small' : 'small', b.active ? '移除' : '恢复');
    btn.onclick = async () => {
      if (b.active) {
        if (!confirm(`移除「${b.fileName}」？\n这张课的 ${b.cards} 张卡会被归档，可以恢复。`)) return;
        const r = await api('POST', `/api/batch/${b.id}/remove`, {});
        toast(`已移除，归档 ${r.archived} 张卡`);
      } else {
        const r = await api('POST', `/api/batch/${b.id}/restore`, {});
        toast(`已恢复 ${r.restored} 张卡`);
      }
      const b2 = await api('GET', '/api/bootstrap');
      STATE.courses = b2.courses;
      renderSidebar();
      viewBatches(courseId);
    };
    const box = el('span');
    box.style.marginLeft = 'auto';
    box.appendChild(redo);
    box.appendChild(btn);
    row.appendChild(box);
    list.appendChild(row);
  }
}

// ---------------- 考前抽检 ----------------
async function viewSpot(courseId, count) {
  STATE.current = courseId;
  renderSidebar();
  const cname = (STATE.courses.find((x) => x.id === courseId) || {}).name || '';
  const m = $('#main');
  m.innerHTML = '';
  const w = el('div', 'wrap');
  m.appendChild(w);

  // 先让用户选抽多少张
  if (!count) {
    w.innerHTML = `
      <h1>考前抽检 · ${esc(cname)}</h1>
      <p class="sub">从全课随机抽题，含已经复习过的卡。忘了的会打回复习队列。</p>
      <div class="row" style="margin-top:16px">
        <button class="primary small" data-n="5">抽 5 张（几分钟）</button>
        <button class="primary small" data-n="15">抽 15 张</button>
        <button class="primary small" data-n="30">抽 30 张（模拟一整场）</button>
      </div>`;
    w.querySelectorAll('[data-n]').forEach((b) => {
      b.onclick = () => viewSpot(courseId, Number(b.dataset.n));
    });
    return;
  }

  const d = await api('GET', `/api/spot/${courseId}?n=${count}`);
  if (!d.total) { w.innerHTML = '<h1>考前抽检</h1><p class="sub">这门课还没有卡片。</p>'; return; }

  let i = 0;
  let revealed = false;
  const forgotten = [];

  w.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <span class="sub" id="spCount"></span>
      <button class="ghost small" id="spQuit">结束抽检</button>
    </div>
    <div class="today-card exam-card">
      <div class="ex-term" id="spFront"></div>
      <div class="ex-ans" id="spBack"></div>
    </div>
    <div class="row" style="justify-content:center;margin-top:18px">
      <button id="spShow" class="primary">看答案（空格）</button>
      <button id="spKnow" class="small" style="display:none">还记得（←）</button>
      <button id="spForget" class="small" style="display:none">忘了（→）</button>
    </div>
    <p class="sub" style="text-align:center;margin-top:12px">${esc(cname)} · 随机 15 张，含已经复习过的卡</p>`;

  const paint = () => {
    const c = d.cards[i];
    $('#spCount').textContent = `${i + 1} / ${d.cards.length}　忘了 ${forgotten.length}`;
    $('#spFront').textContent = c.front;
    $('#spBack').textContent = c.back || '（没有释义）';
    $('#spBack').style.visibility = revealed ? 'visible' : 'hidden';
    $('#spShow').style.display = revealed ? 'none' : '';
    $('#spKnow').style.display = revealed ? '' : 'none';
    $('#spForget').style.display = revealed ? '' : 'none';
  };

  const answer = async (know) => {
    const c = d.cards[i];
    if (!know) {
      forgotten.push(c.front);
      await api('POST', '/api/review', { cardId: c.id, rating: 4 });
    }
    i += 1;
    revealed = false;
    if (i >= d.cards.length) return finish();
    paint();
  };

  const finish = () => {
    const n = d.cards.length;
    w.innerHTML = `
      <h1>抽检结束</h1>
      <p class="sub">${esc(cname)} · ${n} 张</p>
      <div class="today-card" style="text-align:center">
        <div class="big-num">${n - forgotten.length} / ${n}</div>
        <div class="sub">还记得 ${n - forgotten.length} 张，忘了 ${forgotten.length} 张</div>
        ${forgotten.length ? `<p class="hint" style="margin-top:10px">忘掉的已经打回复习队列：<br>${forgotten.map(esc).join('、')}</p>` : '<p class="hint" style="margin-top:10px">全记住了，状态不错。</p>'}
      </div>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button id="spAgain" class="primary small">再抽一轮</button>
        <button id="spBack" class="ghost small">回课程</button>
      </div>`;
    $('#spAgain').onclick = () => viewSpot(courseId, count);
    $('#spBack').onclick = () => { location.hash = `#/course/${courseId}`; };
  };

  $('#spShow').onclick = () => { revealed = true; paint(); };
  $('#spKnow').onclick = () => answer(true);
  $('#spForget').onclick = () => answer(false);
  $('#spQuit').onclick = () => { location.hash = `#/course/${courseId}`; };

  const key = (e) => {
    if (!document.body.contains(w)) { window.removeEventListener('keydown', key); return; }
    if (e.key === ' ') { e.preventDefault(); if (!revealed) { revealed = true; paint(); } }
    if (e.key === 'ArrowLeft' && revealed) answer(true);
    if (e.key === 'ArrowRight' && revealed) answer(false);
  };
  window.addEventListener('keydown', key);
  paint();
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
      <div>记得，不用看概念 <b>${dist[2] || 0}</b></div>
      <div>模糊 <b>${dist[3] || 0}</b></div>
      <div>完全不记得 <b>${dist[4] || 0}</b></div>
      <div class="sub" style="margin-top:12px">明天到期复习 <b>${s.dueTomorrow || 0}</b> 张</div>
      ${(s.streak || 0) >= 7 ? `<div class="streak-badge">连续第 <b>${s.streak}</b> 天，稳得很</div>` : ""}
    </div>
    ${(s.graduatedToday && s.graduatedToday.length)
    ? `<h2 style="margin-top:22px">今天标了「以后不用再考」的 ${s.graduatedToday.length} 张</h2>
         <p class="sub">扫一眼，标错了就点掉——点掉的那张会回到抽检池。</p>
         <div class="detail" id="gradList"></div>`
    : ''}`;
  if (s.graduatedToday && s.graduatedToday.length) {
    const list = w.querySelector('#gradList');
    for (const c of s.graduatedToday) {
      const line = el('div', 'cardrow');
      line.innerHTML = `<span class="t">${esc(c.front)}</span>`;
      const undo = el('button', 'ghost small', '这张不该毕业');
      undo.onclick = async () => {
        await api('POST', `/api/card/${c.id}`, { importance: 3 });
        await api('POST', '/api/review', { cardId: c.id, rating: 4 });
        line.remove();
        toast('已放回复习队列');
      };
      const box = el('span');
      box.style.marginLeft = 'auto';
      box.appendChild(undo);
      line.appendChild(box);
      list.appendChild(line);
    }
  }
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
    <h2>包含关系
      <button id="btnRebuildRel" class="small ghost" style="margin-left:10px"
        title="按课件原文重新算一遍「A 包括 B、C」这种关系，不会动卡片">重算关系</button>
    </h2>
    <div id="edges"></div>`;
  m.appendChild(w);

  w.querySelector('[data-t="today"]').onclick = () => { location.hash = `#/course/${id}`; };
  w.querySelector('[data-t="repo"]').onclick = () => { location.hash = `#/browse/${id}`; };

  const rbRel = w.querySelector('#btnRebuildRel');
  if (rbRel) {
    rbRel.onclick = async () => {
      rbRel.disabled = true;
      rbRel.textContent = '重算中…';
      try {
        const r = await api('POST', `/api/relations/rebuild/${id}`, {});
        toast(`重算完成：删掉旧关系 ${r.removed || 0} 条，新增 ${r.added || 0} 条，现在共 ${r.total || 0} 条`);
        await viewGraph(id);
      } catch (e) {
        toast('重算失败：' + (e.message || e));
        rbRel.disabled = false;
        rbRel.textContent = '重算关系';
      }
    };
  }

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
async function viewBrowse(id, q = '', filter = 'all', silent = false, kind = '', view = 'page') {
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
      <button class="small ${filter === 'pic' ? 'primary' : ''}" data-f="pic">只看有图的 ${d.picCount ?? ''}</button>
    </div>
    <div class="row" style="margin-bottom:10px">
      <button class="small ${!kind ? 'primary' : ''}" data-k="">理论+实验</button>
      <button class="small ${kind === 'theory' ? 'primary' : ''}" data-k="theory">只看理论课</button>
      <button class="small ${kind === 'lab' ? 'primary' : ''}" data-k="lab">只看实验课</button>
    </div>
    <div class="row" style="margin-bottom:8px">
      <button class="small ${view === 'chapter' ? 'primary' : ''}" data-v="chapter">按章节</button>
      <button class="small ${view === 'section' ? 'primary' : ''}" data-v="section">按小节</button>
      <button class="small ${view === 'page' ? 'primary' : ''}" data-v="page">按页码</button>
      <button class="small ${view === 'star' ? 'primary' : ''}" data-v="star">按重要度</button>
      <button class="small ${view === 'az' ? 'primary' : ''}" data-v="az">A→Z</button>
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
    b.onclick = () => viewBrowse(id, q, filter, false, b.dataset.k, view);
  });
  w.querySelectorAll('[data-v]').forEach((b) => {
    b.onclick = () => viewBrowse(id, q, filter, false, kind, b.dataset.v);
  });

  const list = w.querySelector('#list');
  const groups = d.groups || {};
  if (view === 'section') {
    // 章节内按页码断档切小节：相邻两张卡隔 >3 页就算新的一节
    const sorted = [...d.cards].sort((a, b) => Number(a.source_page) - Number(b.source_page));
    const groups = [];
    let cur = null;
    let prevPage = null;
    let prevCh = null;
    for (const c of sorted) {
      const ch = c.chapter || '未分章';
      const page = Number(c.source_page) || 0;
      const isNew = !cur || ch !== prevCh || (prevPage !== null && page - prevPage > 3);
      if (isNew) { cur = { ch, startPage: page, rows: [] }; groups.push(cur); }
      cur.rows.push(c);
      prevPage = page;
      prevCh = ch;
    }
    for (const g of groups) {
      list.appendChild(el('div', 'group-title', `${g.ch} · 第 ${g.startPage} 页起（${g.rows.length} 张）`));
      for (const c of g.rows) list.appendChild(browseRow(c));
    }
  } else if (view === 'chapter') {
    const byCh = new Map();
    for (const c of d.cards) {
      const k = c.chapter || '未分章';
      if (!byCh.has(k)) byCh.set(k, []);
      byCh.get(k).push(c);
    }
    for (const [k, rows] of byCh) {
      list.appendChild(el('div', 'group-title', `${esc(k)}（${rows.length} 张）`));
      for (const c of rows) list.appendChild(browseRow(c));
    }
  } else if (view === 'star') {
    const byStar = new Map();
    for (const c of d.cards) {
      const k = Number(c.importance) || 3;
      if (!byStar.has(k)) byStar.set(k, []);
      byStar.get(k).push(c);
    }
    for (const k of [...byStar.keys()].sort((a, b) => b - a)) {
      list.appendChild(el('div', 'group-title', `★ ${k}（${byStar.get(k).length} 张）`));
      for (const c of byStar.get(k)) list.appendChild(browseRow(c));
    }
  } else if (view === 'az') {
    const sorted = [...d.cards].sort((a, b) => String(a.front).localeCompare(String(b.front), 'zh'));
    let last = '';
    for (const c of sorted) {
      const k = String(c.front).slice(0, 1).toUpperCase();
      if (k !== last) { list.appendChild(el('div', 'group-title', k)); last = k; }
      list.appendChild(browseRow(c));
    }
  } else {
    for (const pg of Object.keys(groups).sort((a, b) => Number(a) - Number(b))) {
      list.appendChild(el('div', 'group-title', `第 ${pg} 页`));
      for (const c of groups[pg]) list.appendChild(browseRow(c));
    }
  }
  if (!d.cards.length) list.appendChild(el('div', 'empty', '没找到'));
}

// 仓库里的一行（三种视图共用）
function browseRow(c) {
  const row = el('div', 'cardrow');
  const where = c.chapter ? `${esc(c.chapter)} · 第 ${c.source_page} 页` : `第 ${c.source_page} 页`;
  const mark = c.dia_count > 0 ? '<span class="badge-dia" title="有机制图">图</span>' : '';
  row.innerHTML = `<span class="t">${esc(c.front)}</span>
        <span class="star">${stars(c.importance)}</span>
        ${mark}
        <span class="pg" title="${esc(c.fileName || '')}">${where}</span>`;
  row.onclick = () => { location.hash = `#/card/${c.id}`; };
  return row;
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
      ${c.image_path ? `<div class="cardimg"><img src="${imgUrl(c.image_path)}" data-card-id="${c.id}" alt="配图" loading="lazy"></div>` : ''}
      ${d.samePage.length ? `<div class="rel"><div class="sub" style="margin-bottom:4px">同一页的其他概念</div>
        ${d.samePage.map((x) => `<a data-go="${x.id}">${esc(x.front)}</a>`).join(' · ')}</div>` : ''}
      ${d.relations.length ? `<div class="rel"><div class="sub" style="margin-bottom:4px">相关概念（点 × 可删除）</div>
        ${d.relations.map((r) => `<span class="rel-item">${r.kind === 'contains' ? `<span class="rel-kind">${r.from_card === c.id ? '包含' : '属于'}</span>` : ''}<a data-go="${r.from_card === c.id ? r.to_card : r.from_card}">${esc(r.from_card === c.id ? r.to_front : r.from_front)}</a><span class="rel-x" data-rel="${r.rel_id || r.id}" title="删除这条关联">×</span></span>`).join(' ')}</div>` : ''}
      <div class="src">出处：${d.source && d.source.chapter ? esc(d.source.chapter) + ' · ' : ''}第 ${c.source_page} 页${d.source && d.source.fileName ? ' · ' + esc(d.source.fileName) : ''} · origin=${c.origin}</div>
      <div class="row" style="margin-top:18px">
        <button id="btnEdit" class="small">修改文字</button>
        <button id="btnSwapImg" class="small">${c.image_path ? '换配图' : '补一张配图'}</button>
        ${c.image_path ? '<button id="btnDelImg" class="ghost small">去掉配图</button>' : ''}
        <button id="btnRevert" class="ghost small" title="把标题和释义恢复成导入/AI 生成时的原样">恢复原版</button>
        <button id="btnMerge" class="small">并入其它卡（别名合并）</button>
        <button id="btnAddRel" class="small">＋ 关联一个概念</button>
        <button id="btnToQueue" class="small">加入今天的队列</button>
        <button id="btnQuizOne" class="small">就这一张，考我</button>
        <button id="btnShowPage" class="ghost small">查看原文</button>
      </div>
      <div id="addRelBox" class="hidden" style="margin-top:14px">
        <p class="hint">输入另一个概念的名字，建立「相关」关系。</p>
        <input id="addRelQ" placeholder="输入术语名，例如 补体">
        <div id="addRelList" class="detail" style="margin-top:8px"></div>
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
  $('#btnToQueue').onclick = async () => {
    const r = await api('POST', `/api/card/${c.id}/queue`, {});
    toast(r.already ? '这张已经在今天的队列里了' : '已加入今天的队列');
  };
  // 换配图 / 去掉配图 / 恢复原版
  const swap = $('#btnSwapImg');
  if (swap) swap.onclick = async () => {
    if (!window.nativeApi || !window.nativeApi.pickImage) return toast('网页版不支持选图片');
    const picked = await window.nativeApi.pickImage();
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    try {
      await api('POST', `/api/card/${c.id}/image`, { path });
      toast('配图已替换');
      viewCard(c.id);
    } catch (e) { toast('换图失败：' + (e.message || e)); }
  };
  const delImg = $('#btnDelImg');
  if (delImg) delImg.onclick = async () => {
    if (!confirm('去掉这张卡的配图？')) return;
    await api('POST', `/api/card/${c.id}/image-remove`, {});
    toast('配图已去掉');
    viewCard(c.id);
  };
  const revert = $('#btnRevert');
  if (revert) revert.onclick = async () => {
    if (!confirm('把标题和释义恢复成导入时的原样？你改过的内容会丢。')) return;
    try {
      await api('POST', `/api/card/${c.id}/revert`, {});
      toast('已恢复原版');
      viewCard(c.id);
    } catch (e) { toast(e.message || '恢复失败'); }
  };

  // 删除一条关联
  w.querySelectorAll('[data-rel]').forEach((x) => {
    x.onclick = async (ev) => {
      ev.stopPropagation();
      await api('POST', '/api/relation/delete', { id: x.dataset.rel });
      toast('关联已删除');
      viewCard(c.id);
    };
  });

  // 添加关联：输入名字搜卡片
  const addRel = $('#btnAddRel');
  if (addRel) addRel.onclick = () => {
    const box = $('#addRelBox');
    box.classList.toggle('hidden');
    const q = $('#addRelQ');
    q.focus();
    q.oninput = debounce(async () => {
      const kw = q.value.trim();
      const list = $('#addRelList');
      if (kw.length < 1) { list.innerHTML = ''; return; }
      const r = await api('GET', `/api/search?q=${encodeURIComponent(kw)}`);
      const rows = (r.hits || r.results || []).filter((x) => x.id !== c.id).slice(0, 8);
      list.innerHTML = rows.map((x) => `<div class="cardrow" data-pick="${x.id}">
        <span class="t">${esc(x.front)}</span><span class="pg">${esc(x.courseName || '')}</span></div>`).join('')
        || '<p class="sub">没找到</p>';
      list.querySelectorAll('[data-pick]').forEach((row) => {
        row.onclick = async () => {
          try {
            await api('POST', '/api/relation/add', { from: c.id, to: row.dataset.pick });
            toast('已建立关联');
            viewCard(c.id);
          } catch (e) { toast(e.message || '添加失败'); }
        };
      });
    }, 220);
  };

  $('#btnQuizOne').onclick = () => quizSingleCard(c, w);
  $('#btnShowPage').onclick = () => showPageText(c.id);

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
    <div class="set-nav">
      <a data-jump="sec-ai">AI 接口</a>
      <a data-jump="sec-look">外观</a>
      <a data-jump="sec-timer">计时器</a>
      <a data-jump="sec-pace">学习节奏</a>
      <a data-jump="sec-pref">显示偏好</a>
      <a data-jump="sec-export">导出</a>
      <a data-jump="sec-adv">高级</a>
      <a data-jump="sec-about">关于</a>
    </div>
    <h2 id="sec-ai">AI 接口</h2>
    <div class="detail" id="aiPanel"></div>
    <h2 id="sec-look">外观</h2>
    <div class="detail">
      <p class="hint">配色在第一栏「主题」里切换，这里只管首页那句话。</p>
      <div class="row" style="align-items:center;gap:12px;margin-top:10px">
        <label style="width:140px">首页一句话</label>
        <input id="pQuote" value="${esc(p.quote || '')}" placeholder="留空则不显示（可用「正文 —— 出处」）">
      </div>
      <p class="hint">写在首页顶上，给自己打气用。</p>
      <div style="margin-top:14px">
        <label class="sub">我的名言（每行一条，会并进内置的 130 多条里一起随机）</label>
        <textarea id="pQuotes" style="width:100%;height:110px;margin-top:6px;font-size:13px"
          placeholder="一天一个概念&#10;背不下来就先看懂一遍">${esc((p.quotes || []).join('\n'))}</textarea>
      </div>
    </div>
    <h2 id="sec-timer">计时器</h2>
    <div class="detail">
      <label><input type="checkbox" id="pTimer" ${p.card_timer !== false ? 'checked' : ''}> 每张卡计时（超时只提醒，不替你作答）</label>
      <div class="row" style="align-items:center;gap:12px;margin-top:10px">
        <label style="width:140px">超时阈值（秒）</label>
        <input id="pTimerSec" type="number" value="${Number(p.card_timer_sec) || 90}" style="width:120px">
      </div>
      <p class="hint">复习界面右上还有「本轮累计」计时，那个不限时，只是让你知道坐了多久。</p>
    </div>
    <h2 id="sec-pace">学习节奏</h2>
    <div class="detail">
      <div class="row" style="align-items:center;gap:12px">
        <label style="width:140px">每日新卡</label><input id="pNew" type="number" value="${p.daily_new_max}" style="width:120px">
      </div>
      <div class="row" style="align-items:center;gap:12px">
        <label style="width:140px">每日复习卡</label><input id="pRev" type="number" value="${p.daily_review_max}" style="width:120px">
      </div>
      <p class="hint">按课程计算：每门课各自独立（文档 D72）</p>
    </div>
    <h2 id="sec-pref">显示偏好</h2>
    <div class="detail">
      <label><input type="checkbox" id="pWeek" ${p.show_week ? 'checked' : ''}> 显示周视图</label>
      <label><input type="checkbox" id="pProg" ${p.show_progress ? 'checked' : ''}> 显示总进度</label>
      <label><input type="checkbox" id="pStreak" ${p.show_streak ? 'checked' : ''}> 显示连续天数</label>
      <label><input type="checkbox" id="pSplash" ${p.splash ? 'checked' : ''}> 启动画面</label>
      <label><input type="checkbox" id="pShuffle" ${p.shuffle ? 'checked' : ''}> 复习乱序（每天打散顺序）</label>
      <label><input type="checkbox" id="pPlainBtn" ${p.plain_buttons ? 'checked' : ''}> 功能按钮用纯白色（不勾选=彩色区分）</label>
    </div>
    <div class="row" style="margin-top:16px">
      <button id="pSave" class="primary">保存</button>
    </div>
    <details class="adv-box" id="sec-adv">
      <summary>高级（谨慎操作）</summary>
      <div class="detail">
        <p class="hint">这些操作会直接影响数据，用完最好跑一次自检。</p>
        <div class="row" style="margin-top:8px">
          <button id="advClearQueue" class="ghost small">清空今天的队列（不动卡片与记录）</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button id="advSelfCheck" class="ghost small">跑一次数据自检</button>
        </div>
        <pre id="advOut" class="log hidden"></pre>
      </div>
    </details>
    <h2 id="sec-export">导出</h2>
    <div class="detail">
      <p class="hint">把卡片导成文件：Markdown 方便打印/贴到别处，CSV 能进 Excel。</p>
      <div class="row" style="margin-top:8px">
        <select id="expCourse" class="tool-select" style="max-width:260px"></select>
        <button id="expMd" class="small">导出 Markdown</button>
        <button id="expCsv" class="small">导出 CSV</button>
      </div>
      <div class="row" style="margin-top:14px">
        <button id="expBackup" class="ghost small">备份数据库（.db）</button>
      </div>
      <pre id="expOut" class="log hidden"></pre>
    </div>
    <h2 id="sec-about">关于</h2>
    <div class="detail">
      <div class="row"><button id="btnAbout" class="small">版本与说明</button></div>
    </div>`;
  m.appendChild(w);  w.querySelectorAll('[data-jump]').forEach((a) => {
    a.onclick = () => {
      const elx = document.getElementById(a.dataset.jump);
      if (elx) {
        if (elx.tagName === 'DETAILS') elx.open = true;
        elx.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
  });
  $('#btnAbout').onclick = () => showAbout();
  const aq = $('#advClearQueue');
  if (aq) aq.onclick = async () => {
    if (!confirm('清空今天所有课程的队列？卡片和复习记录都会保留。')) return;
    const bb = await api('GET', '/api/bootstrap');
    for (const c of bb.courses) await api('POST', `/api/queue/clear/${c.id}`, {});
    toast('今天的队列已清空，下次进课程会重新排');
  };
  // 导出面板
  const expSel = $('#expCourse');
  if (expSel) {
    expSel.innerHTML = STATE.courses.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const doExport = async (format) => {
      const cid = expSel.value;
      if (!cid) return toast('先选一门课');
      try {
        const r = await api('GET', `/api/export/cards/${cid}?format=${format}`);
        if (!window.nativeApi || !window.nativeApi.saveText) return toast('网页版不支持保存文件');
        const out = await window.nativeApi.saveText(r.filename, r.text);
        if (out.ok) toast('已保存：' + out.path);
      } catch (e) { toast('导出失败：' + (e.message || e)); }
    };
    $('#expMd').onclick = () => doExport('md');
    $('#expCsv').onclick = () => doExport('csv');
    $('#expBackup').onclick = async () => {
      if (!window.nativeApi || !window.nativeApi.backupDb) return toast('网页版不支持备份');
      const r = await window.nativeApi.backupDb();
      if (r.ok) toast('已备份：' + r.path);
    };
  }

  const sc = $('#advSelfCheck');
  if (sc) sc.onclick = async () => {
    const out = $('#advOut');
    out.classList.remove('hidden');
    out.textContent = '自检中…';
    try {
      const r = await api('POST', '/api/selfcheck', {});
      out.textContent = (r.lines || []).join('\n');
    } catch (e) { out.textContent = '自检失败：' + (e.message || e); }
  };
  $('#pSave').onclick = async () => {
    await api('POST', '/api/settings', {
      daily_new_max: Number($('#pNew').value) || 10,
      daily_review_max: Number($('#pRev').value) || 5,
      show_week: $('#pWeek').checked,
      show_progress: $('#pProg').checked,
      show_streak: $('#pStreak').checked,
      splash: $('#pSplash').checked,
      shuffle: $('#pShuffle').checked,
      plain_buttons: $('#pPlainBtn').checked,
      theme: STATE.profile.theme || 'paper',
      quote: $('#pQuote').value.trim(),
      quotes: ($('#pQuotes').value || '').split('\n').map((s) => s.trim()).filter(Boolean),
      card_timer: $('#pTimer').checked,
      card_timer_sec: Number($('#pTimerSec').value) || 90,
    });
    toast('已保存');
    const b = await api('GET', '/api/bootstrap');
    STATE.profile = b.profile;
    applyButtonStyle(STATE.profile);
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
      <div id="aiBalance" class="sub" style="margin:10px 0 2px">正在查余额…</div>
      <div class="row" style="margin-top:14px">
        <button id="aiRecheck" class="primary small">再测一次</button>
        <button id="aiEdit" class="small">修改配置</button>
        <button id="aiGoCourse" class="ghost small">去选一门课试试 ›</button>
      </div>
      <pre id="aiTestOut" class="log hidden"></pre>`;
    $('#aiRecheck').onclick = () => runAiTest(cfg);
    // 余额明细
    api('GET', '/api/ai/balance').then((b) => {
      const el2 = $('#aiBalance');
      if (!el2) return;
      if (!b.supported) { el2.textContent = b.reason || '这个接口查不到余额'; return; }
      el2.innerHTML = `可用余额 <b>${b.total.toFixed(2)}</b> ${esc(b.currency)}`
        + ` · 今日调用 <b>${b.usage.today.calls}</b> 次`
        + ` · 累计 <b>${b.usage.all.c}</b> 次`;
    }).catch(() => {
      const el2 = $('#aiBalance');
      if (el2) el2.textContent = '余额查不到（不影响使用）';
    });
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
async function startRefine(courseId, opts = {}) {
  const cfg = await api('GET', '/api/ai/config');
  if (!cfg.hasKey && cfg.baseUrl !== 'mock') {
    toast('还没配置 API Key');
    location.hash = '#/settings';
    return;
  }
  const { job } = await api('POST', `/api/refine/${courseId}`, {});
  showRefineBox(job, courseId, opts);
}

function showRefineBox(jobId, courseId, opts = {}) {
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
        if (opts.autoDiagram) {
          box.remove();
          await drawAllChapters(courseId);
        } else {
          setTimeout(() => { box.remove(); route(); }, 1200);
        }
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

  // 一张卡都没抽到：别装作导入成功，直接说清楚怎么办
  if (!c.cards) {
    const box = el('div', 'modal');
    box.innerHTML = `
      <div class="modal-box" style="width:600px">
        <h3>导入完成，但一张卡都没抽到</h3>
        <p class="hint">课件能打开，但里面没有可用的文字（或者文字没有颜色标记）。常见原因：</p>
        <ul class="hint" style="line-height:1.9">
          <li><b>整页是图片/扫描件</b>：PPT 里文字被导出成了图片，程序读不到文字</li>
          <li><b>用的是旧版 .ppt</b>：现在会自动转，但如果本机没装 PowerPoint 就转不了</li>
          <li><b>文字都是黑色</b>：授课模式靠「红字=术语」抽卡，全黑的话抽不出来（可以试「考纲提纲」模式）</li>
        </ul>
        <p class="hint">建议：先用「考纲提纲」或「复习资料」模式再导一次同一份文件；</p>
        <div class="row">
          <button id="zeroClose" class="primary">知道了</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    $('#zeroClose').onclick = () => { box.remove(); location.hash = `#/course/${c.id}`; };
    return;
  }

  const cfg = await api('GET', '/api/ai/config');

  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:560px">
      <h3>导入完成 · ${esc(courseName)}</h3>
      <p class="hint">已按课件排版做了一版卡片。要不要现在用 AI 重新整理一遍术语？
        ${cfg.hasKey ? '' : '<br><b>还没配 API Key，先去设置里填。</b>'}</p>
      <div class="row">
        <button id="aiNow" class="primary">现在用 AI 整理</button>
        <button id="aiSpot" class="small">先抽检 5 张</button>
        <button id="aiLater" class="ghost">以后再说</button>
      </div>
      <label style="display:block;margin-top:12px;font-size:13px;color:var(--muted)">
        <input type="checkbox" id="aiAlsoDraw" checked> 顺便让 AI 把每一章画成机制图（会多花一点额度）
      </label>
    </div>`;
  document.body.appendChild(box);
  $('#aiLater').onclick = () => { box.remove(); location.hash = `#/course/${c.id}`; };
  $('#aiSpot').onclick = () => { box.remove(); location.hash = `#/spot/${c.id}`; };
  $('#aiNow').onclick = async () => {
    const alsoDraw = $('#aiAlsoDraw').checked;
    box.remove();
    if (!cfg.hasKey && cfg.baseUrl !== 'mock') {
      toast('还没配置 API Key');
      location.hash = '#/settings';
      return;
    }
    await startRefine(c.id, { autoDiagram: alsoDraw });
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
  const typed = $('#importPath').value.trim();
  const courseName = $('#importCourse').value.trim();
  const queue = (STATE.importQueue && STATE.importQueue.length) ? [...STATE.importQueue] : (typed ? [typed] : []);
  if (!queue.length || !courseName) return toast('路径和课程名都要填');
  const kind = document.querySelector('input[name="kind"]:checked')?.value || 'theory';
  const docType = $('#importDocType') ? $('#importDocType').value : 'ppt';
  const typeLabel = ({ ppt: '授课课件', exam: '题库真题', notes: '复习资料', syllabus: '考纲提纲' })[docType] || '授课课件';

  $('#importGo').disabled = true;
  const total = queue.length;
  let doneCount = 0;
  const failed = [];

  for (let qi = 0; qi < queue.length; qi += 1) {
    const file = queue[qi];
    const shortName = file.split(/[\\/]/).pop();
    const head = total > 1 ? `（${qi + 1}/${total}）${shortName}\n` : '';
    $('#importLog').textContent = `${head}解析中…（${kind === 'lab' ? '实验课' : '理论课'} · ${typeLabel}，无 AI，纯本地）`;

    // eslint-disable-next-line no-await-in-loop
    const { job } = await api('POST', '/api/import', { file, courseName, kind, docType });
    // eslint-disable-next-line no-await-in-loop
    const result = await new Promise((resolve) => {
      const poll = setInterval(async () => {
        const j = await api('GET', `/api/job/${job}`);
        const log = j.log || '';
        const pageM = [...log.matchAll(/\[page\] (\d+)\/(\d+)/g)].pop();
        let pct = 8;
        let stage = '读页';
        if (pageM) {
          pct = 8 + Math.min(60, Math.round((Number(pageM[1]) / Number(pageM[2])) * 60));
          stage = `读页 ${pageM[1]}/${pageM[2]}`;
        }
        if (log.includes('[stage] cards')) { pct = Math.max(pct, 72); stage = '写卡片'; }
        if (log.includes('[stage] relations')) { pct = Math.max(pct, 90); stage = '建关系'; }
        if (j.status === 'done') { pct = 100; stage = '完成'; }
        const bar = $('#importBar');
        if (bar) bar.style.width = Math.round(((qi + pct / 100) / total) * 100) + '%';
        const st = $('#importStage');
        if (st) st.textContent = total > 1 ? `第 ${qi + 1}/${total} 个 · ${stage}` : stage;
        const clean = log.split('\n').filter((l) => l && !l.startsWith('[')).join('\n');
        $('#importLog').textContent = head + (clean || '…');
        if (j.status !== 'running') {
          clearInterval(poll);
          resolve(j);
        }
      }, 700);
    });

    if (result.status === 'done') {
      doneCount += 1;
    } else {
      failed.push(shortName);
      const tail = (result.log || '').split('\n').filter(Boolean).slice(-2).join(' ');
      if (/文件不存在/.test(result.log || '')) {
        $('#importLog').textContent = `${head}找不到这个文件。手动输入的路径可能不完整，请用「选择文件」。`;
      } else {
        $('#importLog').textContent = `${head}失败：${tail}`;
      }
    }
  }

  $('#importGo').disabled = false;
  STATE.importQueue = null;
  const b = await api('GET', '/api/bootstrap');
  STATE.courses = b.courses;
  renderSidebar();

  if (!failed.length) {
    $('#importModal').classList.add('hidden');
    toast(total > 1 ? `${total} 份课件都导进来了` : '导入完成');
    askRefineAfterImport(courseName);
  } else {
    toast(`${doneCount} 份成功，${failed.length} 份失败`);
    $('#importStage').textContent = '有文件失败';
  }
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

// 图片查看器：滚轮缩放、拖动平移、←/→ 翻到上一张/下一张
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.cardimg')) {
    openImageViewer(e.target.dataset.cardId || '', e.target.src);
  }
});

function openImageViewer(cardId, src) {
  const box = el('div', 'imgview');
  box.innerHTML = `
    <div class="imgview-bar">
      <span class="imgview-title" id="ivTitle"></span>
      <span class="imgview-ops">
        <button id="ivZoomOut" class="ghost small">－</button>
        <button id="ivZoomIn" class="ghost small">＋</button>
        <button id="ivReset" class="ghost small">复位</button>
        <button id="ivClose" class="ghost small">关闭</button>
      </span>
    </div>
    <div class="imgview-stage" id="ivStage">
      <img id="ivImg" src="${src}" alt="">
    </div>
    <div class="imgview-foot" id="ivFoot"></div>`;
  document.body.appendChild(box);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let sx = 0;
  let sy = 0;
  const img = box.querySelector('#ivImg');
  const stage = box.querySelector('#ivStage');

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.cursor = dragging ? 'grabbing' : 'grab';
  };
  const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };

  box.querySelector('#ivZoomIn').onclick = () => { scale = Math.min(6, scale * 1.25); apply(); };
  box.querySelector('#ivZoomOut').onclick = () => { scale = Math.max(0.3, scale / 1.25); apply(); };
  box.querySelector('#ivReset').onclick = reset;
  box.querySelector('#ivClose').onclick = () => { window.removeEventListener('keydown', key); box.remove(); };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    scale = Math.max(0.3, Math.min(6, scale * k));
    apply();
  }, { passive: false });

  img.addEventListener('mousedown', (e) => {
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty; apply();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    tx = e.clientX - sx; ty = e.clientY - sy; apply();
  });
  window.addEventListener('mouseup', () => { dragging = false; apply(); });

  // 翻页：同一门课里带图的卡
  let nav = null;
  const load = async (id) => {
    nav = await api('GET', `/api/card/${id}/images`);
    img.src = imgUrl(nav.current);
    box.querySelector('#ivTitle').textContent =
      `${box.querySelector('#ivTitle').dataset.name || ''}（第 ${nav.index + 1}/${nav.total} 张）`;
    box.querySelector('#ivFoot').innerHTML =
      `${nav.prev ? `<a id="ivPrev">← 上一张 ${esc(nav.prev.front)}</a>` : '<span class="sub">已经是最前</span>'}
       <span style="flex:1"></span>
       ${nav.next ? `<a id="ivNext">下一张 ${esc(nav.next.front)} →</a>` : '<span class="sub">已经是最后</span>'}`;
    const p = box.querySelector('#ivPrev');
    const n = box.querySelector('#ivNext');
    if (p) p.onclick = () => load(nav.prev.id);
    if (n) n.onclick = () => load(nav.next.id);
    reset();
  };

  const key = (e) => {
    if (e.key === 'Escape') { box.remove(); window.removeEventListener('keydown', key); return; }
    if (e.key === 'ArrowLeft' && nav && nav.prev) load(nav.prev.id);
    if (e.key === 'ArrowRight' && nav && nav.next) load(nav.next.id);
  };
  window.addEventListener('keydown', key);

  if (cardId) load(cardId); else reset();
}

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

// 删除课程：必须手打课程名才让删（防误点）
async function confirmDeleteCourse(courseId, courseName, cardCount) {
  if (!courseId || courseId === 'undefined' || courseId === 'null') {
    toast('拿不到课程 ID，删不了。刷新一下页面（Ctrl+R）再试。');
    return;
  }
  const box = el('div', 'modal');
  box.innerHTML = `
    <div class="modal-box" style="width:580px">
      <h3 style="color:#c0392b">删除「${esc(courseName)}」</h3>
      <p class="hint">会一起删掉：<b>${cardCount || 0} 张卡片</b>、所有页面、机制图、
        复习进度、错题记录，以及导入的原课件副本。<br>
        <b>删了不能恢复</b>（除非你自己备份过 data 文件夹）。</p>
      <p class="hint">确认请输入课程名：<code>${esc(courseName)}</code></p>
      <input id="delConfirm" class="tool-input" style="width:100%" placeholder="在这里输入课程名">
      <div class="row" style="margin-top:12px">
        <button id="delGo" class="danger" disabled>确认删除</button>
        <button id="delCancel" class="ghost">取消</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  const input = box.querySelector('#delConfirm');
  const go = box.querySelector('#delGo');
  box.querySelector('#delCancel').onclick = () => box.remove();
  input.oninput = () => { go.disabled = input.value.trim() !== courseName; };
  input.focus();
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = '删除中…';
    try {
      const r = await api('DELETE', `/api/course/${courseId}`, { confirm: courseName });
      box.remove();
      const b = await api('GET', '/api/bootstrap');
      STATE.courses = b.courses;
      renderSidebar();
      toast(`已删除「${r.name}」：${r.deleted.card || 0} 张卡、${r.deleted.source_file || 0} 份课件`);
      location.hash = '#/';
    } catch (e) {
      toast('删除失败：' + (e.message || e));
      go.disabled = false;
      go.textContent = '确认删除';
    }
  };
}


// 小窗看另一张卡的释义（复习中途不打断、不跳页）
async function peekCard(cardId) {
  if (!cardId) return;
  try {
    const d = await api('GET', `/api/card/${cardId}`);
    const c = d.card;
    const box = el('div', 'modal');
    box.innerHTML = `
      <div class="modal-box" style="width:620px">
        <h3>${esc(c.front)}</h3>
        <p class="sub">${stars(c.importance)} · 第 ${c.source_page} 页</p>
        <div class="answer" style="margin-top:10px"><div class="label">课件原文</div>${esc(c.back || '（没有释义）')}</div>
        <div class="row" style="margin-top:14px;justify-content:flex-end">
          <button id="peekOpen" class="small">打开这张卡</button>
          <button id="peekClose" class="ghost">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('#peekClose').onclick = () => box.remove();
    box.querySelector('#peekOpen').onclick = () => { box.remove(); location.hash = `#/card/${c.id}`; };
    box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });
  } catch (e) { toast('打不开这张卡：' + (e.message || e)); }
}

// 复习背面：显示「包含」的子概念 / 「属于」的大类
async function fillRelations(holder, cardId) {
  if (!holder) return;
  let d;
  try { d = await api('GET', `/api/card/${cardId}`); } catch { return; }
  const rels = d.relations || [];
  const kids = rels.filter((r) => r.kind === 'contains' && r.from_card === cardId)
    .map((r) => ({ id: r.to_card, front: r.to_front }));
  const parents = rels.filter((r) => r.kind === 'contains' && r.to_card === cardId)
    .map((r) => ({ id: r.from_card, front: r.from_front }));
  if (!kids.length && !parents.length) return;

  const block = el('div', 'rev-rels');
  const line = (label, list) => {
    const row = el('div', 'rel-line');
    const tag = el('span', 'rel-tag', label);
    row.appendChild(tag);
    for (const item of list) {
      const chip = el('button', 'rel-chip', item.front);
      chip.onclick = () => peekCard(item.id);
      row.appendChild(chip);
    }
    block.appendChild(row);
  };
  if (kids.length) line(`包含 ${kids.length} 个`, kids);
  if (parents.length) line('属于', parents);
  holder.appendChild(block);
}


// ---------------- 检查更新 ----------------
let UPDATE_INFO = null;

async function bindUpdater(box) {
  const btn = box.querySelector('#btnCheckUpdate');
  const msg = box.querySelector('#updMsg');
  const actions = box.querySelector('#updActions');
  const barWrap = box.querySelector('#updBarWrap');
  const bar = box.querySelector('#updBar');
  if (!btn) return;
  if (!window.nativeApi || !window.nativeApi.checkUpdate) {
    msg.textContent = '网页版不能自动更新，请到 GitHub 下载新版本';
    btn.disabled = true;
    return;
  }

  btn.onclick = async () => {
    btn.disabled = true;
    msg.textContent = '正在连 GitHub…';
    actions.classList.add('hidden');
    try {
      const r = await window.nativeApi.checkUpdate();
      UPDATE_INFO = r;
      if (!r.ok) {
        msg.textContent = r.error || '检查失败';
      } else if (!r.hasUpdate) {
        msg.textContent = `已是最新版本（v${r.current}）`;
      } else {
        msg.textContent = `有新版本 v${r.latest}（当前 v${r.current}）`;
        actions.classList.remove('hidden');
      }
    } catch (e) {
      msg.textContent = '检查失败：' + (e.message || e);
    } finally {
      btn.disabled = false;
      btn.textContent = '再检查一次';
    }
  };

  box.querySelector('#btnUpdatePage').onclick = () => {
    if (UPDATE_INFO && UPDATE_INFO.url && window.nativeApi.openExternal) {
      window.nativeApi.openExternal(UPDATE_INFO.url);
    }
  };

  box.querySelector('#btnUpdateNow').onclick = async () => {
    const info = UPDATE_INFO;
    if (!info || !info.asset) return toast('这次发布没有 zip 附件，请去发布页下载');
    const now = box.querySelector('#btnUpdateNow');
    now.disabled = true;
    barWrap.classList.remove('hidden');
    msg.textContent = `开始下载 ${info.asset.name}（${Math.round(info.asset.size / 1048576)} MB）…`;
    const off = window.nativeApi.onUpdateProgress((p) => {
      bar.style.width = (p.pct || 0) + '%';
      msg.textContent = `下载中 ${p.pct || 0}%（${Math.round((p.got || 0) / 1048576)} / ${Math.round((p.total || 0) / 1048576)} MB）`;
    });
    try {
      const got = await window.nativeApi.downloadUpdate({ url: info.asset.url, name: info.asset.name });
      off && off();
      msg.textContent = `下载完成（${Math.round(got.size / 1048576)} MB），正在重启并替换…`;
      await window.nativeApi.installUpdate({ file: got.file });
    } catch (e) {
      off && off();
      msg.textContent = '下载失败：' + (e.message || e) + '　可以去发布页手动下载';
      now.disabled = false;
    }
  };
}

// 启动时静默看一次（一天最多一次），有新版本就在首页顶部提示
async function silentUpdateCheck() {
  if (!window.nativeApi || !window.nativeApi.checkUpdate) return;
  try {
    const key = 'update_checked_at';
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;
    localStorage.setItem(key, String(Date.now()));
    const r = await window.nativeApi.checkUpdate();
    if (r && r.ok && r.hasUpdate) {
      const tip = el('div', 'upd-toast');
      tip.innerHTML = `有新版本 v${esc(r.latest)}（当前 v${esc(r.current)}）<button class="small" id="updGo">去更新</button><button class="ghost small" id="updLater">以后</button>`;
      document.body.appendChild(tip);
      tip.querySelector('#updGo').onclick = () => { tip.remove(); location.hash = '#/settings'; };
      tip.querySelector('#updLater').onclick = () => tip.remove();
      setTimeout(() => tip.remove(), 20000);
    }
  } catch { /* 静默失败 */ }
}
