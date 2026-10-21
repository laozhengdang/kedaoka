/* 计算器：表达式解析 + 界面（纯前端，无依赖）
 * 解析器可单独在 Node 里测：const { evaluate } = require('./calc.js')
 *
 * 支持：
 *   四则 + - * / × ÷，乘方 ^，括号，阶乘 !，百分号 %
 *   根：√ ∛ sqrt() cbrt() root(x,n)
 *   三角 sin cos tan / 反三角 asin acos atan / 双曲 sinh cosh tanh（可切角度/弧度）
 *   对数 ln log lg log2 log(x,底)
 *   组合 C(n,k) P(n,k) nCr nPr
 *   列表 sum() prod() mean() median() var() stdev() min() max()
 *   常量 pi e NA c h hbar kB R g qe F e0 me mp atm inf
 *   隐式乘法：2π、3(1+2)、2sin(30)
 */
(function (global) {
  'use strict';

  const CONSTS = {
    pi: Math.PI,
    e: Math.E,
    phi: (1 + Math.sqrt(5)) / 2,
    inf: Infinity,
    NA: 6.02214076e23,
    c: 299792458,
    h: 6.62607015e-34,
    hbar: 1.054571817e-34,
    kB: 1.380649e-23,
    R: 8.314462618,
    g: 9.80665,
    qe: 1.602176634e-19,
    F: 96485.33212,
    e0: 8.8541878128e-12,
    me: 9.1093837015e-31,
    mp: 1.67262192369e-27,
    atm: 101325,
  };

  function factorial(n) {
    if (!Number.isFinite(n) || n < 0) return NaN;
    if (!Number.isInteger(n)) return gamma(n + 1);
    if (n > 170) return Infinity;
    let r = 1;
    for (let i = 2; i <= n; i += 1) r *= i;
    return r;
  }

  function gamma(z) {
    const g = 7;
    const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
    const zz = z - 1;
    let x = C[0];
    for (let i = 1; i < g + 2; i += 1) x += C[i] / (zz + i);
    const t = zz + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, zz + 0.5) * Math.exp(-t) * x;
  }

  function nCr(n, k) {
    if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0 || k > n) return NaN;
    let r = 1;
    for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }

  function nPr(n, k) {
    if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0 || k > n) return NaN;
    let r = 1;
    for (let i = 0; i < k; i += 1) r *= n - i;
    return r;
  }

  const LISTFN = {
    sum: (a) => a.reduce((x, y) => x + y, 0),
    prod: (a) => a.reduce((x, y) => x * y, 1),
    mean: (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN),
    average: (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN),
    median: (a) => {
      if (!a.length) return NaN;
      const s = [...a].sort((x, y) => x - y);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
    var: (a) => {
      if (a.length < 2) return NaN;
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
    },
    stdev: (a) => Math.sqrt(LISTFN.var(a)),
    min: (a) => Math.min(...a),
    max: (a) => Math.max(...a),
  };

  function normalize(src) {
    return String(src == null ? '' : src)
      .replace(/[×✕✖·⋅]/g, '*')
      .replace(/[÷∕／]/g, '/')
      .replace(/[−–—]/g, '-')
      .replace(/[（【]/g, '(')
      .replace(/[）】]/g, ')')
      .replace(/［/g, '(').replace(/］/g, ')')
      .replace(/＋/g, '+').replace(/－/g, '-')
      .replace(/，/g, ',')
      .replace(/²/g, '^2').replace(/³/g, '^3')
      .replace(/π/g, 'pi')
      .replace(/√/g, 'sqrt')
      .replace(/∛/g, 'cbrt')
      .replace(/∑/g, 'sum').replace(/∏/g, 'prod')
      .replace(/\s+/g, '');
  }

  // 允许「函数名+数字」粘在一起的写法（√16 → sqrt16）
  const GLUED_OK = new Set([
    'sqrt', 'cbrt', 'abs', 'ln', 'lg', 'log', 'log2', 'log10', 'exp',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
    'floor', 'ceil', 'round', 'fact', 'root', 'mod', 'pow', 'hypot',
  ]);

  function tokenize(src) {
    const s = normalize(src);
    const out = [];
    let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';
    while (i < s.length) {
      const ch = s[i];
      if (isDigit(ch) || (ch === '.' && isDigit(s[i + 1]))) {
        let j = i;
        while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j += 1;
        const isExp = (s[j] === 'e' || s[j] === 'E')
          && (isDigit(s[j + 1]) || ((s[j + 1] === '+' || s[j + 1] === '-') && isDigit(s[j + 2])));
        if (isExp) {
          j += 1;
          if (s[j] === '+' || s[j] === '-') j += 1;
          while (j < s.length && isDigit(s[j])) j += 1;
        }
        out.push({ t: 'num', v: Number(s.slice(i, j)) });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
        let name = s.slice(i, j);
        // √16 归一化成 sqrt16，这里把已知函数名和后面的数字拆开
        const glued = name.match(/^([A-Za-z_]+?)([0-9]+)$/);
        if (glued && GLUED_OK.has(glued[1])) {
          out.push({ t: 'id', v: glued[1] });
          out.push({ t: 'num', v: Number(glued[2]) });
          i = j;
          continue;
        }
        out.push({ t: 'id', v: name });
        i = j;
        continue;
      }
      if ('+-*/^()!,%'.includes(ch)) {
        out.push({ t: 'op', v: ch });
        i += 1;
        continue;
      }
      throw new Error(`看不懂的符号：${ch}`);
    }
    return out;
  }

  function evaluate(src, opts) {
    const expr = String(src == null ? '' : src).trim();
    if (!expr) return { ok: false, error: '还没有输入' };
    const deg = Boolean(opts && opts.deg);
    let tokens;
    try {
      tokens = tokenize(expr);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const eat = (v) => {
      const tk = tokens[pos];
      if (tk && tk.t === 'op' && tk.v === v) { pos += 1; return true; }
      return false;
    };
    const toRad = (x) => (deg ? (x * Math.PI) / 180 : x);
    const fromRad = (x) => (deg ? (x * 180) / Math.PI : x);

    const FN = {
      sin: (x) => Math.sin(toRad(x)),
      cos: (x) => Math.cos(toRad(x)),
      tan: (x) => Math.tan(toRad(x)),
      asin: (x) => fromRad(Math.asin(x)),
      acos: (x) => fromRad(Math.acos(x)),
      atan: (x) => fromRad(Math.atan(x)),
      sinh: Math.sinh,
      cosh: Math.cosh,
      tanh: Math.tanh,
      asinh: Math.asinh,
      acosh: Math.acosh,
      atanh: Math.atanh,
      ln: Math.log,
      lg: Math.log10,
      log10: Math.log10,
      log2: Math.log2,
      log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
      exp: Math.exp,
      sqrt: Math.sqrt,
      cbrt: Math.cbrt,
      root: (x, n) => (n === undefined ? Math.sqrt(x) : Math.sign(x) * Math.abs(x) ** (1 / n)),
      abs: Math.abs,
      sign: Math.sign,
      floor: Math.floor,
      ceil: Math.ceil,
      round: (x, d) => {
        if (d === undefined) return Math.round(x);
        const f = 10 ** d;
        return Math.round(x * f) / f;
      },
      fact: factorial,
      gamma,
      nCr,
      nPr,
      C: nCr,
      P: nPr,
      mod: (a, b) => ((a % b) + b) % b,
      pow: Math.pow,
      rand: () => Math.random(),
      deg: (x) => (x * 180) / Math.PI,
      rad: (x) => (x * Math.PI) / 180,
      hypot: (...a) => Math.hypot(...a),
    };

    function startsValue(tk) {
      if (!tk) return false;
      if (tk.t === 'num' || tk.t === 'id') return true;
      return tk.t === 'op' && (tk.v === '(' || tk.v === '-');
    }

    function parseExpr() {
      let v = parseTerm();
      for (;;) {
        if (eat('+')) v += parseTerm();
        else if (eat('-')) v -= parseTerm();
        else return v;
      }
    }

    function parseTerm() {
      let v = parseUnary();
      for (;;) {
        if (eat('*')) { v *= parseUnary(); continue; }
        if (eat('/')) { v /= parseUnary(); continue; }
        const tk = peek();
        if (tk && startsValue(tk)) { v *= parseUnary(); continue; }
        return v;
      }
    }

    function parseUnary() {
      if (eat('-')) return -parseUnary();
      if (eat('+')) return parseUnary();
      return parsePower();
    }

    function parsePower() {
      const base = parsePostfix();
      if (eat('^')) return base ** parseUnary();
      return base;
    }

    function parsePostfix() {
      let v = parsePrimary();
      for (;;) {
        if (eat('!')) { v = factorial(v); continue; }
        if (eat('%')) { v /= 100; continue; }
        return v;
      }
    }

    function parseArgs() {
      const args = [];
      if (eat(')')) return args;
      for (;;) {
        args.push(parseExpr());
        if (eat(',')) continue;
        if (eat(')')) return args;
        throw new Error('括号没配对');
      }
    }

    function parsePrimary() {
      const tk = next();
      if (!tk) throw new Error('式子没写完');
      if (tk.t === 'num') return tk.v;
      if (tk.t === 'op' && tk.v === '(') {
        const v = parseExpr();
        if (!eat(')')) throw new Error('少一个右括号');
        return v;
      }
      if (tk.t === 'id') {
        const name = tk.v;
        const lower = name.toLowerCase();
        const isCall = peek() && peek().t === 'op' && peek().v === '(';
        const fnKey = Object.prototype.hasOwnProperty.call(FN, name) ? name : lower;
        const fn = FN[fnKey];
        if (isCall && LISTFN[lower]) { next(); return LISTFN[lower](parseArgs()); }
        if (isCall && fn) { next(); return fn(...parseArgs()); }
        if (!isCall && fn) { return fn(parsePostfix()); }
        if (Object.prototype.hasOwnProperty.call(CONSTS, name)) return CONSTS[name];
        if (Object.prototype.hasOwnProperty.call(CONSTS, lower)) return CONSTS[lower];
        throw new Error(`不认识的名称：${name}`);
      }
      throw new Error(`这里不该出现 ${tk.v}`);
    }

    try {
      const v = parseExpr();
      if (pos < tokens.length) throw new Error(`多出来的内容：${tokens[pos].v}`);
      if (Number.isNaN(v)) return { ok: false, error: '结果不是数（定义域问题？）' };
      return { ok: true, value: v };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  function fmt(v) {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
    if (v === 0) return '0';
    const abs = Math.abs(v);
    if (Number.isInteger(v) && abs < 1e15) return String(v);
    if (abs >= 1e15 || abs < 1e-6) {
      return v.toExponential(8).replace(/\.?0+e/, 'e').replace('e+', 'e');
    }
    return String(Number(v.toPrecision(12)));
  }

  const api = { evaluate, tokenize, normalize, fmt, CONSTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MiaoCalc = api;

  if (typeof document === 'undefined') return;

  // ---------------- 界面 ----------------
  const FNKEYS = [
    ['√', 'sqrt('], ['∛', 'cbrt('], ['x²', '^2'], ['x³', '^3'],
    ['xʸ', '^'], ['n!', '!'], ['%', '%'], ['1/x', '1/('],
    ['π', 'pi'], ['e', 'e'], ['EXP', 'e'],
    ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['ln', 'ln('], ['lg', 'lg('],
    ['logₐ', 'log('], ['C(n,k)', 'C('], ['P(n,k)', 'P('],
    ['Σ', 'sum('], ['Π', 'prod('], ['x̄', 'mean('], ['σ', 'stdev('],
    ['|x|', 'abs('], ['⌊x⌋', 'floor('], ['⌈x⌉', 'ceil('], ['round', 'round('],
    ['mod', 'mod('], ['root', 'root('],
  ];

  function openCalculator() {
    const exists = document.querySelector('.calc-ov');
    if (exists) {
      const inp = exists.querySelector('#calcInput');
      if (inp) inp.focus();
      return;
    }
    const ov = document.createElement('div');
    ov.className = 'calc-ov';
    ov.innerHTML = `
      <div class="calc-box" role="dialog" aria-label="计算器">
        <div class="calc-head">
          <span class="calc-title">计算器</span>
          <label class="calc-mode"><input type="checkbox" id="calcDeg"> 角度制</label>
          <button class="calc-mini" id="calcHistBtn" type="button">历史</button>
          <button class="calc-mini" id="calcClose" type="button">关闭</button>
        </div>
        <input id="calcInput" class="calc-input" spellcheck="false"
          placeholder="输入算式：sqrt(2)*sin(30)+3!  或  2^10">
        <div class="calc-out"><span id="calcResult">0</span></div>
        <div class="calc-pad" id="calcPad"></div>
        <div class="calc-foot">
          <span class="calc-hint">Enter 计算 · Esc 关闭 · 也可以直接用键盘打字</span>
          <span class="calc-mem" id="calcMem"></span>
        </div>
        <div class="calc-hist hidden" id="calcHist"></div>
      </div>`;
    document.body.appendChild(ov);

    const box = ov.querySelector('.calc-box');
    const input = ov.querySelector('#calcInput');
    const out = ov.querySelector('#calcResult');
    const pad = ov.querySelector('#calcPad');
    const memTag = ov.querySelector('#calcMem');
    const histBox = ov.querySelector('#calcHist');
    const degBox = ov.querySelector('#calcDeg');

    const state = {
      deg: localStorage.getItem('calc_deg') === '1',
      mem: Number(localStorage.getItem('calc_mem') || 0),
      history: (() => {
        try { return JSON.parse(localStorage.getItem('calc_hist') || '[]'); } catch { return []; }
      })(),
    };
    degBox.checked = state.deg;

    const close = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('#calcClose').onclick = close;

    const preview = () => {
      if (!input.value.trim()) { out.textContent = '0'; out.classList.remove('bad'); return; }
      const r = MiaoCalc.evaluate(input.value, { deg: state.deg });
      if (r.ok) { out.textContent = MiaoCalc.fmt(r.value); out.classList.remove('bad'); }
      else { out.textContent = r.error; out.classList.add('bad'); }
    };

    const paintMem = () => { memTag.textContent = state.mem ? `M = ${MiaoCalc.fmt(state.mem)}` : ''; };

    const renderHist = () => {
      histBox.innerHTML = state.history.length
        ? state.history.map((h, i) => `<div class="calc-hrow" data-i="${i}">
            <span class="e">${h.expr}</span><span class="r">${h.result}</span></div>`).join('')
        : '<p class="calc-none">还没有记录</p>';
      histBox.querySelectorAll('[data-i]').forEach((row) => {
        row.onclick = () => {
          input.value = state.history[Number(row.dataset.i)].result;
          histBox.classList.add('hidden');
          input.focus();
          preview();
        };
      });
    };

    const insert = (txt) => {
      const s = input.value;
      const a = input.selectionStart == null ? s.length : input.selectionStart;
      const b = input.selectionEnd == null ? s.length : input.selectionEnd;
      input.value = s.slice(0, a) + txt + s.slice(b);
      const p = a + txt.length;
      input.focus();
      input.setSelectionRange(p, p);
      preview();
    };

    const commit = () => {
      const r = MiaoCalc.evaluate(input.value, { deg: state.deg });
      if (!r.ok) { out.textContent = r.error; out.classList.add('bad'); return; }
      out.textContent = MiaoCalc.fmt(r.value);
      out.classList.remove('bad');
      state.history.unshift({ expr: input.value, result: MiaoCalc.fmt(r.value) });
      state.history = state.history.slice(0, 40);
      localStorage.setItem('calc_hist', JSON.stringify(state.history));
      renderHist();
    };

    // 数字键盘（5 列 × 4 行）
    const KEYS = [
      ['7', '8', '9', '/', 'C'],
      ['4', '5', '6', '*', '('],
      ['1', '2', '3', '-', ')'],
      ['0', '.', '^', '+', '='],
    ];
    const LABEL = { '/': '÷', '*': '×', '-': '−' };
    for (const row of KEYS) {
      const r = document.createElement('div');
      r.className = 'calc-row';
      for (const k of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'calc-key' + (k === '=' ? ' eq' : '') + (k === 'C' ? ' warn' : '');
        b.textContent = LABEL[k] || k;
        b.onclick = () => {
          if (k === '=') commit();
          else if (k === 'C') { input.value = ''; input.focus(); preview(); }
          else insert(k);
        };
        r.appendChild(b);
      }
      pad.appendChild(r);
    }

    // 函数键
    const fns = document.createElement('div');
    fns.className = 'calc-fns';
    for (const [label, txt] of FNKEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'calc-fn';
      b.textContent = label;
      b.onclick = () => insert(txt);
      fns.appendChild(b);
    }
    pad.appendChild(fns);

    // 记忆键
    const memRow = document.createElement('div');
    memRow.className = 'calc-row mem';
    for (const [label, act] of [['M+', 'add'], ['M−', 'sub'], ['MR', 'recall'], ['MC', 'clear'], ['⌫', 'back']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'calc-key fn';
      b.textContent = label;
      b.onclick = () => {
        const r = MiaoCalc.evaluate(input.value, { deg: state.deg });
        if (act === 'add' && r.ok) { state.mem += r.value; localStorage.setItem('calc_mem', String(state.mem)); paintMem(); }
        else if (act === 'sub' && r.ok) { state.mem -= r.value; localStorage.setItem('calc_mem', String(state.mem)); paintMem(); }
        else if (act === 'recall') insert(String(state.mem));
        else if (act === 'clear') { state.mem = 0; localStorage.setItem('calc_mem', '0'); paintMem(); }
        else if (act === 'back') {
          const p = input.selectionStart == null ? input.value.length : input.selectionStart;
          if (p > 0) {
            input.value = input.value.slice(0, p - 1) + input.value.slice(input.selectionEnd || p);
            input.focus();
            input.setSelectionRange(p - 1, p - 1);
            preview();
          }
        }
      };
      memRow.appendChild(b);
    }
    pad.appendChild(memRow);

    input.oninput = preview;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    degBox.onchange = () => {
      state.deg = degBox.checked;
      localStorage.setItem('calc_deg', state.deg ? '1' : '0');
      preview();
    };
    ov.querySelector('#calcHistBtn').onclick = () => histBox.classList.toggle('hidden');
    window.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); window.removeEventListener('keydown', esc); }
    });

    paintMem();
    renderHist();
    preview();
    setTimeout(() => input.focus(), 30);
    return box;
  }

  global.MiaoCalcUI = { openCalculator };
})(typeof window !== 'undefined' ? window : globalThis);
