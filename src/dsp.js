// dsp.js — 实时语音谐波分析的数字信号处理核心
//
// 职责：
//   1. detectPitch        基频 F0 检测（YIN / 累积均值归一化差函数 + 抛物线插值）
//   2. estimateNoiseFloor 频谱噪声基底估计（用于把 dB 映射到可读的 0~80 量程）
//   3. extractHarmonics   在 FFT 谱上提取 H1..Hn 的峰值电平（dB）
//   4. computeMetrics     由谐波电平计算 H1-H2 / H1-H5 / 低高平衡 / 频谱倾斜
//
// 所有“差值类”指标（H1-H2、H1-H5、低高平衡、倾斜）都只依赖谐波之间的相对电平，
// 因此与噪声基底偏移无关——这保证了即使量程发生平移，指标依然稳定可靠。

/**
 * YIN 风格的基频检测。返回基频（Hz）、清晰度（0~1）与 RMS 能量。
 * @param {Float32Array} buf        时域采样（[-1,1]）
 * @param {number} sampleRate
 * @param {number} fmin             允许的最低基频
 * @param {number} fmax             允许的最高基频
 * @param {number} rmsGate          静音门限（低于此 RMS 视为无人声）
 */
export function detectPitch(buf, sampleRate, fmin = 70, fmax = 500, rmsGate = 0.006) {
  const n = buf.length;

  // —— 静音门限：先算 RMS，过低直接判为无声 —— //
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < rmsGate) return { f0: 0, clarity: 0, rms };

  const tauMin = Math.max(2, Math.floor(sampleRate / fmax));
  const tauMax = Math.min(Math.floor(sampleRate / fmin), Math.floor(n / 2));
  if (tauMax <= tauMin) return { f0: 0, clarity: 0, rms };

  // —— 差函数 d(τ) —— //
  const diff = new Float32Array(tauMax + 1);
  const window = n - tauMax; // 用于相关的样本数
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const delta = buf[i] - buf[i + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // —— 累积均值归一化差函数 d'(τ) —— //
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  // —— 绝对阈值：在合法 τ 区间内找第一个跌破阈值后的局部最小 —— //
  const threshold = 0.12;
  let tauEst = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEst = tau;
      break;
    }
  }

  // 阈值未命中时，退化为区间内全局最小值；过高则判为无清晰基频
  if (tauEst === -1) {
    let min = Infinity;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cmnd[tau] < min) { min = cmnd[tau]; tauEst = tau; }
    }
    if (min > 0.5) return { f0: 0, clarity: 0, rms };
  }

  // —— 抛物线插值，获得亚采样精度 —— //
  const x0 = tauEst > 1 ? tauEst - 1 : tauEst;
  const x2 = tauEst + 1 <= tauMax ? tauEst + 1 : tauEst;
  let betterTau = tauEst;
  if (x0 !== x2) {
    const s0 = cmnd[x0], s1 = cmnd[tauEst], s2 = cmnd[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEst + (s2 - s0) / denom;
  }

  const f0 = sampleRate / betterTau;
  const clarity = Math.max(0, Math.min(1, 1 - cmnd[tauEst]));
  if (f0 < fmin || f0 > fmax) return { f0: 0, clarity: 0, rms };
  return { f0, clarity, rms };
}

/**
 * 噪声基底估计：取频谱 dB 的低分位数（默认 20%）。
 * 低分位由背景噪声主导，是一个稳健的“地板”参考。
 */
export function estimateNoiseFloor(freqDb, percentile = 0.2) {
  // 拷贝有限值后排序取分位，避开 -Infinity（空 bin）
  const vals = [];
  for (let i = 1; i < freqDb.length; i++) {
    const v = freqDb[i];
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return -120;
  vals.sort((a, b) => a - b);
  const idx = Math.min(vals.length - 1, Math.floor(vals.length * percentile));
  return vals[idx];
}

/**
 * 在 FFT 幅度谱（dB）上提取前 count 个谐波的峰值电平。
 *
 * 关键：用「紧窗定位 + 抛物线插值」而非宽窗取最大值。
 * 宽窗最大值会把微弱高次谐波旁边的噪声/频谱泄漏误当成谐波峰，
 * 系统性抬高 H3–H5、压低 H1–H5 与频谱倾斜。这里只在 ±halfWindow(≤3) 个
 * bin 内定位真正的局部峰，再对峰值做抛物线插值得到精确幅度。
 */
export function extractHarmonics(freqDb, sampleRate, fftSize, f0, count = 5) {
  const binHz = sampleRate / fftSize;
  const n = freqDb.length;
  const f0Bins = f0 / binHz;
  // 紧窗：约谐波间距的 12%，并限制在 1~3 个 bin，足以容忍 F0 轻微误差又不抓噪声
  const halfWindow = Math.max(1, Math.min(3, Math.round(f0Bins * 0.12)));
  const harmonics = [];

  for (let k = 1; k <= count; k++) {
    const freq = f0 * k;
    const c = Math.round(freq / binHz);
    const lo = Math.max(1, c - halfWindow);
    const hi = Math.min(n - 2, c + halfWindow);

    // 1) 在紧窗内找局部峰值 bin
    let peakBin = lo, peakVal = -Infinity;
    for (let b = lo; b <= hi; b++) {
      const v = freqDb[b];
      if (Number.isFinite(v) && v > peakVal) { peakVal = v; peakBin = b; }
    }

    // 2) 抛物线插值，得到更精确的峰值幅度（dB 域）。
    //    仅在 peakBin 确为局部极大（两侧都不高于它）时才插值，
    //    否则峰落在上升沿会被错误外推抬高。
    let db = peakVal;
    const ym1 = freqDb[peakBin - 1], y0 = freqDb[peakBin], yp1 = freqDb[peakBin + 1];
    if (Number.isFinite(ym1) && Number.isFinite(y0) && Number.isFinite(yp1)
        && y0 >= ym1 && y0 >= yp1) {
      const denom = ym1 - 2 * y0 + yp1;
      if (denom < 0) {
        const delta = (0.5 * (ym1 - yp1)) / denom;
        db = y0 - 0.25 * (ym1 - yp1) * delta;
      }
    }
    if (!Number.isFinite(db)) db = -120;
    harmonics.push({ index: k, freq, db });
  }
  return harmonics;
}

/** 最小二乘斜率（y 对 x）。 */
function linregSlope(xs, ys) {
  const n = xs.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * 由谐波电平计算各项嗓音指标。
 *   h1h2     H1−H2，气声/压声指标（越大越带气声）
 *   h1h5     H1−H5，整体衰减幅度
 *   lowHigh  低/高平衡 = mean(H3..H5) − mean(H1..H2)，负值表示能量偏低频（更暗）
 *   tilt     频谱倾斜（dB/oct），谐波电平对 log2(频率) 的回归斜率
 */
export function computeMetrics(harmonics) {
  const db = harmonics.map((h) => h.db);
  const h1h2 = db[0] - db[1];
  const h1h5 = db[0] - db[db.length - 1];

  const low = (db[0] + db[1]) / 2;
  const high = (db[2] + db[3] + db[4]) / 3;
  const lowHigh = high - low;

  const xs = harmonics.map((h) => Math.log2(h.freq));
  const tilt = linregSlope(xs, db);

  return { h1h2, h1h5, lowHigh, tilt };
}

// ————————————————————————————————————————————————————————————————
// 共振峰估计（F1/F2/F3）—— LPC（线性预测）法
//
// 流程（语音处理标准做法）：
//   预加重 → 降采样到 ~11kHz → 加 Hamming 窗 → 自相关 → Levinson-Durbin 求 LPC 系数
//   → 对分析多项式 A(z) 求根（Durand-Kerner）→ 复根角度换算成共振峰频率、模长换算带宽
//   → 按带宽与频率范围筛选，得到 F1<F2<F3。
//
// 共振峰反映声道形状（与基频无关）：F1≈口腔开合/下颌，F2≈舌位前后/声道前腔。
// ————————————————————————————————————————————————————————————————

function preEmphasis(x, a = 0.97) {
  const y = new Float64Array(x.length);
  y[0] = x[0];
  for (let n = 1; n < x.length; n++) y[n] = x[n] - a * x[n - 1];
  return y;
}

// 抗混叠（移动平均低通）后按整数因子抽取
function decimate(x, factor) {
  if (factor <= 1) return x;
  const w = factor;
  const lp = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i];
    if (i >= w) acc -= x[i - w];
    lp[i] = acc / Math.min(i + 1, w);
  }
  const out = new Float64Array(Math.floor(x.length / factor));
  const off = factor >> 1;
  for (let i = 0; i < out.length; i++) out[i] = lp[Math.min(x.length - 1, i * factor + off)];
  return out;
}

function applyHamming(x) {
  const N = x.length;
  const y = new Float64Array(N);
  for (let n = 0; n < N; n++) y[n] = x[n] * (0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1)));
  return y;
}

function autocorr(x, p) {
  const r = new Float64Array(p + 1);
  for (let k = 0; k <= p; k++) {
    let s = 0;
    for (let n = k; n < x.length; n++) s += x[n] * x[n - k];
    r[k] = s;
  }
  return r;
}

// Levinson-Durbin：自相关 r → LPC 分析多项式系数 a（A(z)=1+a1 z⁻¹+…+ap z⁻ᵖ）
function levinson(r, p) {
  const a = new Float64Array(p + 1);
  a[0] = 1;
  let e = r[0];
  if (e <= 0) return a;
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    const prev = a.slice(0, i); // a[0..i-1]
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) e = 1e-12;
  }
  return a;
}

// —— 复数小工具 —— //
const cAdd = (x, y) => ({ re: x.re + y.re, im: x.im + y.im });
const cSub = (x, y) => ({ re: x.re - y.re, im: x.im - y.im });
const cMul = (x, y) => ({ re: x.re * y.re - x.im * y.im, im: x.re * y.im + x.im * y.re });
function cDiv(x, y) {
  const d = y.re * y.re + y.im * y.im || 1e-30;
  return { re: (x.re * y.re + x.im * y.im) / d, im: (x.im * y.re - x.re * y.im) / d };
}
function horner(coef, z) {
  let r = { re: coef[0], im: 0 };
  for (let i = 1; i < coef.length; i++) r = cAdd(cMul(r, z), { re: coef[i], im: 0 });
  return r;
}

// Durand-Kerner：求 p 阶多项式（降幂系数 coef，最高次=1）的全部复根
function durandKerner(coef) {
  const p = coef.length - 1;
  const roots = [];
  for (let k = 0; k < p; k++) {
    const ang = (2 * Math.PI * k) / p + 0.4;
    roots.push({ re: 0.9 * Math.cos(ang), im: 0.9 * Math.sin(ang) });
  }
  for (let iter = 0; iter < 80; iter++) {
    let maxDelta = 0;
    for (let k = 0; k < p; k++) {
      const pv = horner(coef, roots[k]);
      let denom = { re: 1, im: 0 };
      for (let j = 0; j < p; j++) if (j !== k) denom = cMul(denom, cSub(roots[k], roots[j]));
      const delta = cDiv(pv, denom);
      roots[k] = cSub(roots[k], delta);
      const d = Math.hypot(delta.re, delta.im);
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta < 1e-10) break;
  }
  return roots;
}

// 从候选共振峰频率中挑出 F1、F2（按典型人声范围）
function pickF1F2(freqs) {
  let f1 = null, f2 = null;
  for (const f of freqs) {
    if (f1 === null) { if (f >= 200 && f <= 1100) f1 = f; continue; }
    if (f2 === null && f >= f1 + 150 && f <= 3200) { f2 = f; break; }
  }
  return { f1, f2 };
}

/**
 * 估计共振峰。调用方应只在有清晰人声时调用。
 * @returns {{ f1: number|null, f2: number|null, all: number[] }}
 */
export function estimateFormants(timeBuf, sampleRate) {
  const pre = preEmphasis(timeBuf, 0.97);
  const factor = Math.max(1, Math.round(sampleRate / 11000)); // 目标 ~11kHz
  const ds = decimate(pre, factor);
  const dsr = sampleRate / factor;
  if (ds.length < 32) return { f1: null, f2: null, all: [] };

  const win = applyHamming(ds);
  const p = Math.min(16, Math.max(8, 2 + Math.round(dsr / 1000))); // ~12–14
  const r = autocorr(win, p);
  if (r[0] <= 0) return { f1: null, f2: null, all: [] };

  const a = levinson(r, p);                 // [1, a1, …, ap]
  const roots = durandKerner(Array.from(a)); // A(z) 的根

  const found = [];
  for (const z of roots) {
    if (z.im <= 0) continue;                // 共轭根只取上半平面
    const mag = Math.hypot(z.re, z.im);
    if (mag <= 0 || mag >= 1) continue;     // 不稳定/无效根
    const f = (Math.atan2(z.im, z.re) * dsr) / (2 * Math.PI);
    const bw = (-Math.log(mag) * dsr) / Math.PI;
    if (f > 90 && f < dsr / 2 - 100 && bw < 500) found.push(f);
  }
  found.sort((x, y) => x - y);
  const { f1, f2 } = pickF1F2(found);
  return { f1, f2, all: found };
}
