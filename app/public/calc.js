/* 计算器 v2：高精度（decimal.js）+ 单位量纲 + 变量
 *
 * 设计参考 sharkdp/insect（MIT）的几个核心想法：
 *   - 用十进制高精度库算，避免 0.1+0.2=0.30000000000000004
 *   - 量纲（单位）参与运算，加减要求量纲一致
 *   - 支持 `120 km/h to m/s` 这种自然写法
 *   - 结果带单位显示
 * 解析器是本项目自己实现的递归下降，没有移植 insect 的 PureScript 源码。
 *
 * 单独测试：const { evaluate } = require('./calc.js')
 */
(function (global) {
  'use strict';

  const Decimal = global.Decimal
    || (typeof require === 'function' ? require('./vendor/decimal.js') : null);
  if (!Decimal) throw new Error('缺少 decimal.js（vendor/decimal.js）');
  Decimal.set({ precision: 34, toExpNeg: -12, toExpPos: 21 });

  const D = (x) => new Decimal(x == null ? 0 : x);
  const ONE = () => D(1);

  // 量纲顺序：长度 质量 时间 电流 温度 物质的量 光强
  const DIMS = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd'];
  const zeroDims = () => [0, 0, 0, 0, 0, 0, 0];
  const addDims = (a, b, k = 1) => a.map((v, i) => v + b[i] * k);
  const sameDims = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

  const L = [1, 0, 0, 0, 0, 0, 0];
  const M = [0, 1, 0, 0, 0, 0, 0];
  const T = [0, 0, 1, 0, 0, 0, 0];
  const N_MOL = [0, 0, 0, 0, 0, 1, 0];
  const TEMP = [0, 0, 0, 0, 1, 0, 0];
  const VOL = [3, 0, 0, 0, 0, 0, 0];

  // 单位表：f 换算到 SI，d 量纲，offset 用于温度
  const UNITS = {
    m: { f: 1, d: L }, km: { f: 1000, d: L }, cm: { f: 0.01, d: L },
    mm: { f: 0.001, d: L }, um: { f: 1e-6, d: L }, nm: { f: 1e-9, d: L },
    in: { f: 0.0254, d: L }, ft: { f: 0.3048, d: L }, mi: { f: 1609.344, d: L },
    kg: { f: 1, d: M }, g: { f: 0.001, d: M }, mg: { f: 1e-6, d: M },
    ug: { f: 1e-9, d: M }, t: { f: 1000, d: M }, lb: { f: 0.45359237, d: M },
    s: { f: 1, d: T }, ms: { f: 0.001, d: T }, us: { f: 1e-6, d: T },
    ns: { f: 1e-9, d: T }, min: { f: 60, d: T }, h: { f: 3600, d: T },
    hr: { f: 3600, d: T }, day: { f: 86400, d: T },
    mol: { f: 1, d: N_MOL }, mmol: { f: 1e-3, d: N_MOL }, umol: { f: 1e-6, d: N_MOL },
    L: { f: 0.001, d: VOL }, l: { f: 0.001, d: VOL },
    mL: { f: 1e-6, d: VOL }, ml: { f: 1e-6, d: VOL }, uL: { f: 1e-9, d: VOL },
    K: { f: 1, d: TEMP }, C: { f: 1, d: TEMP, offset: 273.15 },
    F: { f: 5 / 9, d: TEMP, offset: 255.37222222222223 },
    rad: { f: 1, d: [] }, deg: { f: Math.PI / 180, d: [] },
    Hz: { f: 1, d: [0, 0, -1, 0, 0, 0, 0] },
    kHz: { f: 1000, d: [0, 0, -1, 0, 0, 0, 0] },
    MHz: { f: 1e6, d: [0, 0, -1, 0, 0, 0, 0] },
    N: { f: 1, d: [1, 1, -2, 0, 0, 0, 0] },
    J: { f: 1, d: [2, 1, -2, 0, 0, 0, 0] },
    kJ: { f: 1000, d: [2, 1, -2, 0, 0, 0, 0] },
    cal: { f: 4.184, d: [2, 1, -2, 0, 0, 0, 0] },
    kcal: { f: 4184, d: [2, 1, -2, 0, 0, 0, 0] },
    W: { f: 1, d: [2, 1, -3, 0, 0, 0, 0] },
    kW: { f: 1000, d: [2, 1, -3, 0, 0, 0, 0] },
    Pa: { f: 1, d: [-1, 1, -2, 0, 0, 0, 0] },
    kPa: { f: 1000, d: [-1, 1, -2, 0, 0, 0, 0] },
    MPa: { f: 1e6, d: [-1, 1, -2, 0, 0, 0, 0] },
    bar: { f: 1e5, d: [-1, 1, -2, 0, 0, 0, 0] },
    mmHg: { f: 133.322387415, d: [-1, 1, -2, 0, 0, 0, 0] },
    V: { f: 1, d: [2, 1, -3, -1, 0, 0, 0] },
    atm: { f: 101325, d: [-1, 1, -2, 0, 0, 0, 0] },
  };

  const DERIVED = [
    { name: 'N', d: [1, 1, -2, 0, 0, 0, 0] },
    { name: 'J', d: [2, 1, -2, 0, 0, 0, 0] },
    { name: 'W', d: [2, 1, -3, 0, 0, 0, 0] },
    { name: 'Pa', d: [-1, 1, -2, 0, 0, 0, 0] },
    { name: 'Hz', d: [0, 0, -1, 0, 0, 0, 0] },
    { name: 'V', d: [2, 1, -3, -1, 0, 0, 0] },
    { name: 'm/s', d: [1, 0, -1, 0, 0, 0, 0] },
    { name: 'm/s²', d: [1, 0, -2, 0, 0, 0, 0] },
    { name: 'kg/m³', d: [-3, 1, 0, 0, 0, 0, 0] },
  ];

  // 注意：h / g / t / F / C 这些字母已经是单位（小时、克、吨、华氏、摄氏），
  // 所以物理常量改用不容易冲突的名字。
  const CONSTS = {
    pi: Math.PI, e: Math.E, phi: (1 + Math.sqrt(5)) / 2,
    NA: 6.02214076e23,
    c: 299792458,              // 光速
    hplanck: 6.62607015e-34,   // 普朗克常数（h 是小时）
    planck: 6.62607015e-34,
    hbar: 1.054571817e-34,
    kB: 1.380649e-23,
    R: 8.314462618,
    g0: 9.80665,               // 重力加速度（g 是克）
    qe: 1.602176634e-19,
    Faraday: 96485.33212,      // F 是华氏度
    e0: 8.8541878128e-12,
    me: 9.1093837015e-31,
    mp: 1.67262192369e-27,
  };

  // 接受 Decimal、值对象 {d,...}、或普通数字
  const toNum = (x) => {
    if (x instanceof Decimal) return x.toNumber();
    if (x && x.d instanceof Decimal) return x.d.toNumber();
    return Number(x);
  };
  const fromNum = (n) => D(Number.isFinite(n) ? n : (n > 0 ? Infinity : -Infinity));

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

  function factorial(v) {
    if (v.isNegative()) return D(NaN);
    if (!v.isInteger()) return fromNum(gamma(v.toNumber() + 1));
    if (v.gt(1000)) return D(Infinity);
    let r = ONE();
    for (let i = D(2); i.lte(v); i = i.plus(1)) r = r.times(i);
    return r;
  }

  function nCr(a, b) {
    if (!a.isInteger() || !b.isInteger() || b.isNegative() || a.isNegative() || b.gt(a)) return D(NaN);
    let r = ONE();
    for (let i = D(1); i.lte(b); i = i.plus(1)) r = r.times(a.minus(b).plus(i)).div(i);
    return r.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  }

  function nPr(a, b) {
    if (!a.isInteger() || !b.isInteger() || b.isNegative() || a.isNegative() || b.gt(a)) return D(NaN);
    let r = ONE();
    for (let i = D(0); i.lt(b); i = i.plus(1)) r = r.times(a.minus(i));
    return r;
  }

  const dimensionless = (d) => ({ d: D(d), dims: zeroDims(), unit: null });

  function unitLabel(dims) {
    if (sameDims(dims, zeroDims())) return '';
    for (const u of DERIVED) if (sameDims(dims, u.d)) return u.name;
    const up = [];
    const down = [];
    dims.forEach((v, i) => {
      if (Math.abs(v) < 1e-9) return;
      const name = DIMS[i];
      if (v > 0) up.push(name + (Math.abs(v) === 1 ? '' : `^${v}`));
      else down.push(name + (Math.abs(v) === 1 ? '' : `^${Math.abs(v)}`));
    });
    if (!up.length && !down.length) return '';
    return (up.join('·') || '1') + (down.length ? '/' + down.join('·') : '');
  }

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
      .replace(/µ/g, 'u')
      .replace(/°/g, 'deg')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const PREFIX_OK = new Set([
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
    'ln', 'lg', 'log10', 'log2', 'exp', 'sqrt', 'cbrt', 'abs',
    'floor', 'ceil', 'round', 'fact', 'deg', 'rad',
  ]);

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
      if (ch === ' ') { i += 1; continue; }
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
        out.push({ t: 'num', v: s.slice(i, j) });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
        const name = s.slice(i, j);
        const glued = name.match(/^([A-Za-z_]+?)([0-9]+)$/);
        if (glued && GLUED_OK.has(glued[1])) {
          out.push({ t: 'id', v: glued[1] });
          out.push({ t: 'num', v: glued[2] });
        } else {
          out.push({ t: 'id', v: name });
        }
        i = j;
        continue;
      }
      if ('+-*/^()!,%'.includes(ch)) { out.push({ t: 'op', v: ch }); i += 1; continue; }
      throw new Error(`看不懂的符号：${ch}`);
    }
    return out;
  }

  function evaluate(src, opts) {
    const raw = String(src == null ? '' : src).trim();
    if (!raw) return { ok: false, error: '还没有输入' };
    const deg = Boolean(opts && opts.deg);
    const baseVars = Object.assign({}, (opts && opts.vars) || {});
    const newVars = {};
    const parts = raw.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
    let last = null;
    for (const part of parts) {
      const r = evaluateOne(part, { deg, vars: Object.assign({}, baseVars, newVars) });
      if (!r.ok) return r;
      if (r.assign) newVars[r.assign.name] = r.assign.value;
      last = r;
    }
    return {
      ok: true,
      value: toNum(last.value),
      decimal: last.value,
      display: last.display,
      unit: last.unit,
      vars: newVars,
    };
  }

  function evaluateOne(expr, ctx) {
    const { deg, vars } = ctx;

    let target = null;
    let body = expr;
    const assignMatch = expr.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (assignMatch && !/^(to|in)$/i.test(assignMatch[1])) {
      target = assignMatch[1];
      body = assignMatch[2];
    }

    let conv = null;
    const convMatch = body.match(/^(.*?)\s+(to|in|换算为|换算成|转成)\s+(.+)$/i);
    if (convMatch) { body = convMatch[1]; conv = convMatch[3]; }

    let tokens;
    try { tokens = tokenize(body); } catch (e) { return { ok: false, error: e.message }; }
    if (!tokens.length) return { ok: false, error: '还没有输入' };

    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const eat = (v) => {
      const tk = tokens[pos];
      if (tk && tk.t === 'op' && tk.v === v) { pos += 1; return true; }
      return false;
    };
    const toRad = (x) => (deg ? x.d.times(Math.PI).div(180) : x.d);

    function add(a, b) {
      if (!sameDims(a.dims, b.dims)) throw new Error(`量纲不一致：${unitLabel(a.dims) || '无单位'} 和 ${unitLabel(b.dims) || '无单位'} 不能相加`);
      return { d: a.d.plus(b.d), dims: a.dims, unit: a.unit || b.unit };
    }
    function sub(a, b) {
      if (!sameDims(a.dims, b.dims)) throw new Error(`量纲不一致：${unitLabel(a.dims) || '无单位'} 和 ${unitLabel(b.dims) || '无单位'} 不能相减`);
      return { d: a.d.minus(b.d), dims: a.dims, unit: a.unit || b.unit };
    }
    // 单位标签只在量纲仍然匹配时保留（mol/L * L 应该回到 mol，而不是留着 L）
    function keepUnit(unit, dims) {
      if (!unit || !UNITS[unit]) return null;
      const ud = UNITS[unit].d && UNITS[unit].d.length ? UNITS[unit].d : zeroDims();
      return sameDims(ud, dims) ? unit : null;
    }
    function mul(a, b) {
      const dims = addDims(a.dims, b.dims);
      const cand = b.unit == null ? a.unit : (a.unit == null ? b.unit : null);
      return { d: a.d.times(b.d), dims, unit: keepUnit(cand, dims) };
    }
    function div(a, b) {
      const dims = addDims(a.dims, b.dims, -1);
      const cand = b.unit == null ? a.unit : null;
      return { d: a.d.div(b.d), dims, unit: keepUnit(cand, dims) };
    }

    const dv = (n) => dimensionless(fromNum(n));

    const FN = {
      sin: (x) => dv(Math.sin(toNum(toRad(x)))),
      cos: (x) => dv(Math.cos(toNum(toRad(x)))),
      tan: (x) => dv(Math.tan(toNum(toRad(x)))),
      asin: (x) => dv(deg ? (Math.asin(toNum(x)) * 180) / Math.PI : Math.asin(toNum(x))),
      acos: (x) => dv(deg ? (Math.acos(toNum(x)) * 180) / Math.PI : Math.acos(toNum(x))),
      atan: (x) => dv(deg ? (Math.atan(toNum(x)) * 180) / Math.PI : Math.atan(toNum(x))),
      atan2: (a, b) => dv(Math.atan2(toNum(a), toNum(b))),
      sinh: (x) => dv(Math.sinh(toNum(x))),
      cosh: (x) => dv(Math.cosh(toNum(x))),
      tanh: (x) => dv(Math.tanh(toNum(x))),
      asinh: (x) => dv(Math.asinh(toNum(x))),
      acosh: (x) => dv(Math.acosh(toNum(x))),
      atanh: (x) => dv(Math.atanh(toNum(x))),
      ln: (x) => dv(Math.log(toNum(toRad(x)))),
      lg: (x) => dv(Math.log10(toNum(x))),
      log10: (x) => dv(Math.log10(toNum(x))),
      log2: (x) => dv(Math.log2(toNum(x))),
      log: (x, b) => dv(b == null ? Math.log10(toNum(x)) : Math.log(toNum(x)) / Math.log(toNum(b))),
      exp: (x) => dv(Math.exp(toNum(x))),
      sqrt: (x) => ({ d: x.d.sqrt(), dims: x.dims.map((v) => v / 2), unit: null }),
      cbrt: (x) => ({ d: fromNum(Math.cbrt(toNum(x.d))), dims: x.dims.map((v) => v / 3), unit: null }),
      root: (x, n) => ({ d: fromNum(Math.sign(toNum(x.d)) * Math.pow(Math.abs(toNum(x.d)), 1 / toNum(n))), dims: x.dims.map((v) => v / toNum(n)), unit: null }),
      abs: (x) => ({ d: x.d.abs(), dims: x.dims, unit: x.unit }),
      sign: (x) => dimensionless(x.d.sgn()),
      floor: (x) => ({ d: x.d.floor(), dims: x.dims, unit: x.unit }),
      ceil: (x) => ({ d: x.d.ceil(), dims: x.dims, unit: x.unit }),
      round: (x, n) => ({ d: x.d.toDecimalPlaces(n == null ? 0 : toNum(n), Decimal.ROUND_HALF_UP), dims: x.dims, unit: x.unit }),
      fact: (x) => dimensionless(factorial(x.d)),
      gamma: (x) => dv(gamma(toNum(x.d))),
      nCr: (a, b) => dimensionless(nCr(a.d, b.d)),
      nPr: (a, b) => dimensionless(nPr(a.d, b.d)),
      C: (a, b) => dimensionless(nCr(a.d, b.d)),
      P: (a, b) => dimensionless(nPr(a.d, b.d)),
      mod: (a, b) => ({ d: a.d.mod(b.d), dims: a.dims, unit: a.unit }),
      pow: (a, b) => ({ d: a.d.pow(b.d), dims: zeroDims(), unit: null }),
      hypot: (...a) => dv(Math.hypot(...a.map((x) => toNum(x.d)))),
      min: (...a) => a.slice().sort((x, y) => (x.d.lt(y.d) ? -1 : 1))[0],
      max: (...a) => a.slice().sort((x, y) => (x.d.gt(y.d) ? -1 : 1))[0],
      deg: (x) => dimensionless((toNum(x.d) * 180) / Math.PI),
      rad: (x) => dimensionless((toNum(x.d) * Math.PI) / 180),
    };

    const mean = (a) => div(a.reduce((x, y) => add(x, y), dimensionless(0)), dimensionless(a.length));
    const LISTFN = {
      sum: (a) => a.reduce((x, y) => add(x, y), dimensionless(0)),
      prod: (a) => a.reduce((x, y) => mul(x, y), dimensionless(1)),
      mean,
      average: mean,
      median: (a) => {
        const s = a.slice().sort((x, y) => (x.d.lt(y.d) ? -1 : 1));
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : div(add(s[m - 1], s[m]), dimensionless(2));
      },
      min: (a) => a.slice().sort((x, y) => (x.d.lt(y.d) ? -1 : 1))[0],
      max: (a) => a.slice().sort((x, y) => (x.d.gt(y.d) ? -1 : 1))[0],
      var: (a) => {
        const m = mean(a);
        const acc = a.reduce((s, v) => {
          const dv = sub(v, m);
          return add(s, { d: dv.d.times(dv.d), dims: addDims(dv.dims, dv.dims), unit: null });
        }, dimensionless(0));
        return div(acc, dimensionless(a.length - 1));
      },
      stdev: (a) => {
        const v = LISTFN.var(a);
        return { d: v.d.sqrt(), dims: v.dims.map((x) => x / 2), unit: null };
      },
    };

    function startsValue(tk) {
      if (!tk) return false;
      if (tk.t === 'num' || tk.t === 'id') return true;
      return tk.t === 'op' && tk.v === '(';
    }

    function parseExpr() {
      let v = parseTerm();
      for (;;) {
        if (eat('+')) v = add(v, parseTerm());
        else if (eat('-')) v = sub(v, parseTerm());
        else return v;
      }
    }

    function parseTerm() {
      let v = parseUnary();
      for (;;) {
        if (eat('*')) { v = mul(v, parseUnary()); continue; }
        if (eat('/')) { v = div(v, parseUnary()); continue; }
        const tk = peek();
        if (tk && startsValue(tk)) { v = mul(v, parseUnary()); continue; }
        return v;
      }
    }

    function parseUnary() {
      if (eat('-')) { const v = parseUnary(); return { d: v.d.neg(), dims: v.dims, unit: v.unit }; }
      if (eat('+')) return parseUnary();
      return parsePower();
    }

    function parsePower() {
      const base = parsePostfix();
      if (eat('^')) {
        const exp = parseUnary();
        if (!sameDims(exp.dims, zeroDims())) throw new Error('指数不能带单位');
        if (!exp.d.isInteger()) return fromNum(Math.pow(toNum(base.d), toNum(exp.d)));
        return { d: base.d.pow(exp.d), dims: base.dims.map((x) => x * toNum(exp.d)), unit: null };
      }
      return base;
    }

    function parsePostfix() {
      let v = parsePrimary();
      for (;;) {
        if (eat('!')) { v = dimensionless(factorial(v.d)); continue; }
        if (eat('%')) { v = div(v, dimensionless(100)); continue; }
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
      if (tk.t === 'num') return dimensionless(new Decimal(tk.v));
      if (tk.t === 'op' && tk.v === '(') {
        const v = parseExpr();
        if (!eat(')')) throw new Error('少一个右括号');
        return v;
      }
      if (tk.t === 'id') {
        const name = tk.v;
        const lower = name.toLowerCase();
        const isCall = peek() && peek().t === 'op' && peek().v === '(';
        if (isCall && LISTFN[lower]) { next(); return LISTFN[lower](parseArgs()); }
        const fnKey = Object.prototype.hasOwnProperty.call(FN, name) ? name : lower;
        if (isCall && FN[fnKey]) { next(); return FN[fnKey](...parseArgs()); }
        if (!isCall && FN[fnKey] && PREFIX_OK.has(fnKey)) return FN[fnKey](parsePostfix());
        if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
        if (Object.prototype.hasOwnProperty.call(vars, lower)) return vars[lower];
        if (Object.prototype.hasOwnProperty.call(UNITS, name)) {
          const u = UNITS[name];
          return { d: D(u.f), dims: (u.d && u.d.length ? u.d.slice() : zeroDims()), unit: name };
        }
        if (Object.prototype.hasOwnProperty.call(CONSTS, name)) return dimensionless(new Decimal(String(CONSTS[name])));
        if (Object.prototype.hasOwnProperty.call(CONSTS, lower)) return dimensionless(new Decimal(String(CONSTS[lower])));
        throw new Error(`不认识的名称：${name}`);
      }
      throw new Error(`这里不该出现 ${tk.v}`);
    }

    let value;
    try {
      value = parseExpr();
      if (pos < tokens.length) throw new Error(`多出来的内容：${tokens[pos].v}`);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }

    let unitText = value.unit || unitLabel(value.dims);
    if (conv) {
      const tgt = parseUnitExpr(conv);
      if (!tgt) return { ok: false, error: `看不懂的目标单位：${conv}` };
      if (!sameDims(value.dims.map((v) => v || 0), tgt.d)) {
        return { ok: false, error: `单位对不上：${unitLabel(value.dims) || '无单位'} 换不了 ${conv}` };
      }
      const srcUnit = value.unit && UNITS[value.unit] ? UNITS[value.unit] : null;
      const tempInvolved = (srcUnit && srcUnit.offset != null) || tgt.offset != null;
      if (tempInvolved) {
        // 温度：先统一换到开尔文，再按目标换算
        const kelvin = srcUnit && srcUnit.offset != null
          ? value.d.times(srcUnit.f).plus(srcUnit.offset)
          : value.d.times(srcUnit ? srcUnit.f : 1);
        value = {
          d: tgt.offset != null ? kelvin.minus(tgt.offset).div(tgt.f) : kelvin.div(tgt.f),
          dims: tgt.d,
          unit: null,
        };
      } else {
        value = { d: value.d.div(tgt.f), dims: tgt.d, unit: null };
      }
      unitText = conv.trim();
    } else if (!value.unit) {
      unitText = unitLabel(value.dims);
    }

    const display = formatValue(value, unitText);

    if (target) {
      return {
        ok: true,
        value: value.d,
        display,
        unit: unitText,
        assign: { name: target, value: { d: value.d, dims: value.dims, unit: value.unit } },
      };
    }
    return { ok: true, value: value.d, display, unit: unitText };
  }

  // 把 m/s、km/h、kg*m/s^2 这类写法解析成「因子 + 量纲」
  function parseUnitExpr(text) {
    let tokens;
    try { tokens = tokenize(text); } catch { return null; }
    let f = D(1);
    let dims = zeroDims();
    let offset = null;
    let sign = 1;
    let powNext = false;
    for (const tk of tokens) {
      if (tk.t === 'op' && tk.v === '*') { sign = 1; continue; }
      if (tk.t === 'op' && tk.v === '/') { sign = -1; continue; }
      if (tk.t === 'op' && tk.v === '^') { powNext = true; continue; }
      if (tk.t === 'op' && (tk.v === '(' || tk.v === ')')) continue;
      if (tk.t === 'num') {
        if (!powNext) return null;
        const e = Number(tk.v);
        f = f.pow(sign > 0 ? e : -e);
        dims = dims.map((x) => x + (sign > 0 ? 1 : -1) * e * 0);
        powNext = false;
        sign = 1;
        continue;
      }
      if (tk.t === 'id') {
        const u = UNITS[tk.v];
        if (!u) return null;
        const dm = u.d && u.d.length ? u.d : zeroDims();
        if (sign > 0) {
          f = f.times(u.f);
          dims = dims.map((x, i) => x + dm[i]);
          if (u.offset != null) offset = u.offset;
        } else {
          f = f.div(u.f);
          dims = dims.map((x, i) => x - dm[i]);
        }
        sign = 1;
        powNext = false;
        continue;
      }
      return null;
    }
    return { f, d: dims, offset, label: text };
  }

  function formatValue(v, unitText) {
    const dec = v.d;
    let s;
    if (!dec.isFinite()) s = dec.isNegative() ? '-∞' : '∞';
    else if (dec.isZero()) s = '0';
    else {
      const abs = dec.abs();
      if (dec.isInteger() && abs.lt('1e21')) s = dec.toFixed(0);
      else if (abs.gte('1e21') || abs.lt('1e-9')) s = dec.toExponential(13).replace(/\.?0+e/, 'e').replace('e+', 'e');
      else s = dec.toSignificantDigits(14).toString();
    }
    return unitText ? `${s} ${unitText}` : s;
  }

  function fmt(v) {
    if (v instanceof Decimal) return formatValue({ d: v }, '');
    return String(v);
  }

  const api = { evaluate, tokenize, normalize, fmt, Decimal, UNITS };
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
    ['mod', 'mod('], ['root', 'root('], ['to', ' to '],
  ];

  const EXAMPLES = [
    '120 km/h to m/s',
    '0.1 + 0.2',
    '5 mol/L * 2 L',
    'C(10,3)',
    'sqrt(2)*sin(45)',
  ];

  function openCalculator() {
    const exists = document.querySelector('.calc-ov');
    if (exists) {
      const i = exists.querySelector('#calcInput');
      if (i) i.focus();
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
          placeholder="120 km/h to m/s   或   sqrt(2)*sin(45)">
        <div class="calc-out"><span id="calcResult">0</span></div>
        <div class="calc-examples" id="calcExamples"></div>
        <div class="calc-pad" id="calcPad"></div>
        <div class="calc-foot">
          <span class="calc-hint">单位：5 mol/L * 2 L · 变量：x=3; x^2 · Esc 关闭</span>
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
      mem: localStorage.getItem('calc_mem') || '0',
      vars: {},
      history: (() => { try { return JSON.parse(localStorage.getItem('calc_hist') || '[]'); } catch { return []; } })(),
    };
    degBox.checked = state.deg;

    const close = () => ov.remove();
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('#calcClose').onclick = close;

    const preview = () => {
      if (!input.value.trim()) { out.textContent = '0'; out.classList.remove('bad'); return; }
      const r = MiaoCalc.evaluate(input.value, { deg: state.deg, vars: state.vars });
      if (r.ok) { out.textContent = r.display; out.classList.remove('bad'); }
      else { out.textContent = r.error; out.classList.add('bad'); }
    };

    const paintMem = () => { memTag.textContent = state.mem && state.mem !== '0' ? `M = ${state.mem}` : ''; };

    const renderHist = () => {
      histBox.innerHTML = state.history.length
        ? state.history.map((h, i) => `<div class="calc-hrow" data-i="${i}">
            <span class="e">${h.expr}</span><span class="r">${h.result}</span></div>`).join('')
        : '<p class="calc-none">还没有记录</p>';
      histBox.querySelectorAll('[data-i]').forEach((row) => {
        row.onclick = () => {
          input.value = state.history[Number(row.dataset.i)].result;
          histBox.classList.add('hidden');
          input.focus(); preview();
        };
      });
    };

    const insert = (txt) => {
      const s = input.value;
      const a = input.selectionStart == null ? s.length : input.selectionStart;
      const b = input.selectionEnd == null ? s.length : input.selectionEnd;
      input.value = s.slice(0, a) + txt + s.slice(b);
      const p = a + txt.length;
      input.focus(); input.setSelectionRange(p, p);
      preview();
    };

    const commit = () => {
      const r = MiaoCalc.evaluate(input.value, { deg: state.deg, vars: state.vars });
      if (!r.ok) { out.textContent = r.error; out.classList.add('bad'); return; }
      if (r.vars) Object.assign(state.vars, r.vars);
      out.textContent = r.display;
      out.classList.remove('bad');
      state.history.unshift({ expr: input.value, result: r.display });
      state.history = state.history.slice(0, 40);
      localStorage.setItem('calc_hist', JSON.stringify(state.history));
      renderHist();
    };

    const ex = ov.querySelector('#calcExamples');
    EXAMPLES.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'calc-chip'; b.textContent = e;
      b.onclick = () => { input.value = e; input.focus(); preview(); };
      ex.appendChild(b);
    });

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

    const fns = document.createElement('div');
    fns.className = 'calc-fns';
    for (const [label, txt] of FNKEYS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'calc-fn'; b.textContent = label;
      b.onclick = () => insert(txt);
      fns.appendChild(b);
    }
    pad.appendChild(fns);

    const memRow = document.createElement('div');
    memRow.className = 'calc-row mem';
    for (const [label, act] of [['M+', 'add'], ['M−', 'sub'], ['MR', 'recall'], ['MC', 'clear'], ['⌫', 'back']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'calc-key fn'; b.textContent = label;
      b.onclick = () => {
        const r = MiaoCalc.evaluate(input.value, { deg: state.deg, vars: state.vars });
        if (act === 'add' && r.ok) {
          state.mem = new MiaoCalc.Decimal(state.mem).plus(new MiaoCalc.Decimal(r.value)).toString();
          localStorage.setItem('calc_mem', state.mem); paintMem();
        } else if (act === 'sub' && r.ok) {
          state.mem = new MiaoCalc.Decimal(state.mem).minus(new MiaoCalc.Decimal(r.value)).toString();
          localStorage.setItem('calc_mem', state.mem); paintMem();
        } else if (act === 'recall') insert(state.mem);
        else if (act === 'clear') { state.mem = '0'; localStorage.setItem('calc_mem', '0'); paintMem(); }
        else if (act === 'back') {
          const p = input.selectionStart == null ? input.value.length : input.selectionStart;
          if (p > 0) {
            input.value = input.value.slice(0, p - 1) + input.value.slice(input.selectionEnd || p);
            input.focus(); input.setSelectionRange(p - 1, p - 1); preview();
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

    paintMem(); renderHist(); preview();
    setTimeout(() => input.focus(), 30);
    return box;
  }

  global.MiaoCalcUI = { openCalculator };
})(typeof window !== 'undefined' ? window : globalThis);
