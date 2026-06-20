// app.js — 应用主控：连接音频引擎、DSP、渲染与界面
import { AudioEngine } from './audio.js';
import { detectPitch, estimateNoiseFloor, extractHarmonics, computeMetrics, estimateFormants } from './dsp.js';
import { computeLayout, draw, drawPitchTrack, drawResonanceMap } from './render.js';
import { pillText, summaryCards, metricsToPad } from './interpret.js';

// —— 可持久化的设置 —— //
const DEFAULTS = {
  smoothing: 0.85,   // 0~0.95，越大越平滑（时间常数越长，响应越慢）
  rmsGate: 0.008,    // 静音门限
  fmin: 75,
  fmax: 500,
  showBaseline: true,
  freeze: false,
  showTarget: false, // 是否在基频轨迹上显示固定的目标频率线
  targetHz: 165,     // 目标基频（Hz），由用户自定义
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('vh.settings');
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* 忽略损坏的本地存储 */ }
  return { ...DEFAULTS };
}
function saveSettings(s) {
  try { localStorage.setItem('vh.settings', JSON.stringify(s)); } catch { /* 配额/隐私模式 */ }
}

const settings = loadSettings();
const engine = new AudioEngine();

// —— 平滑状态（指数滑动平均） —— //
const state = {
  levels: [0, 0, 0, 0, 0],     // 实时谐波电平（显示量程 0~80）
  baseline: [0, 0, 0, 0, 0],   // 慢速基线（虚线参考）
  metrics: { h1h2: 0, h1h5: 0, lowHigh: 0, tilt: 0 },
  padX: 0.5,
  padY: 0.5,
  active: false,               // 当前帧是否检测到清晰人声
  f0: 0,
  f1: 0,                       // 第一共振峰（Hz，平滑后）
  f2: 0,                       // 第二共振峰（Hz，平滑后）
};

let lastVoicedAt = 0;          // 最近一次有声的时间戳（ms）
let frameCount = 0;
let hasData = false;           // 是否已检测到首次有效人声（决定是否显示摘要）
let lastSmoothTime = 0;        // 上次平滑的时间戳（用于帧率无关的时间常数平滑）
const f0Hist = [];             // 最近若干帧的 F0，用于中值滤波消除倍频误检
let smoothedFloor = -100;      // 平滑后的噪声基底（避免整体电平随基底一起抖）

// —— 基频实时曲线（音高轨迹） —— //
const PITCH_WINDOW_MS = 8000;          // 显示最近 8 秒
const MEAN_WINDOW_MS = 3000;           // 均值只统计最近 3 秒
const pitchHist = [];                  // [{t, f0}]，f0=0 表示该帧静音（曲线断开）
const pitchRange = { lo: 90, hi: 280 };// 显示用 Hz 范围（自适应 + 平滑）
let pitchSize = { w: 300, h: 130 };

// —— 共鸣空间图 F1×F2 —— //
const fHist = [];                      // 共振峰移动轨迹 [{f1,f2,t}]
const FHIST_MS = 2500;                 // 拖尾时长
let resonanceSize = { w: 300, h: 300 };

// —— 录音 —— //
let recording = false;
const recordBuffer = [];               // 录制期间的逐帧指标快照
let recordStart = 0;
let mediaRecorder = null;
let recordedChunks = [];
let monoNodes = null;                  // 录音用的单声道降混节点（录完断开）
let detailUrl = null;                  // 详情页音频回放的对象 URL
let historyRecs = [];                  // 历史记录（内存缓存，源自 IndexedDB）
let currentDetailId = null;            // 详情页当前查看的记录 id
let clearArmed = false;                // "清空全部"二次确认状态
let clearTimer = null;
const RECORD_MAX_MS = 120000;          // 最长 2 分钟

// —— DOM —— //
const canvas = document.getElementById('viz');
const ctx = canvas.getContext('2d');
const pitchCanvas = document.getElementById('pitch');
const pitchCtx = pitchCanvas.getContext('2d');
const resonanceCanvas = document.getElementById('resonance');
const resonanceCtx = resonanceCanvas.getContext('2d');
const pillEl = document.getElementById('pill');
const cardsEl = document.getElementById('cards');
const summaryEl = document.querySelector('.summary');
const f0El = document.getElementById('f0readout');
const f1El = document.getElementById('f1-val');
const f2El = document.getElementById('f2-val');
const recordBtn = document.getElementById('record-btn');
const recLabel = document.getElementById('rec-label');
const reportOverlay = document.getElementById('report-overlay');
const reportBody = document.getElementById('report-body');
const reportAudioEl = document.getElementById('report-audio');
const reportDownload = document.getElementById('report-download');
const historyBtn = document.getElementById('history-btn');
const reportTitle = document.getElementById('report-title');
const reportBack = document.getElementById('report-back');
const reportDelete = document.getElementById('report-delete');
const historyView = document.getElementById('history-view');
const detailView = document.getElementById('detail-view');
const historyListEl = document.getElementById('history-list');
const historyEmptyEl = document.getElementById('history-empty');
const historyClearBtn = document.getElementById('history-clear');
const historyCountEl = document.getElementById('history-count');
const startOverlay = document.getElementById('start-overlay');
const startBtn = document.getElementById('start-btn');
const startErr = document.getElementById('start-error');

let layout = null;
let dpr = 1;

function setupCanvas(cv, cx, minW, minH) {
  const rect = cv.getBoundingClientRect();
  const w = Math.max(minW, rect.width);
  const h = Math.max(minH, rect.height);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const m = setupCanvas(canvas, ctx, 320, 260);
  layout = computeLayout(m.w, m.h);
  pitchSize = setupCanvas(pitchCanvas, pitchCtx, 200, 90);
  resonanceSize = setupCanvas(resonanceCanvas, resonanceCtx, 220, 200);
}
window.addEventListener('resize', resize);

// —— 平滑工具 —— //
const lerp = (a, b, t) => a + (b - a) * t;

// 中值（用于 F0 历史，剔除偶发的倍频/半频尖峰）
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

// 稳健均值：先取中位数，剔除偏离过大的离群点（倍频/半频误检、飙到 500+ 的噪声尖峰），
// 再对剩余求均值。保留区间 [0.6×中位, 1.7×中位]：能挡住 2× 倍频与 0.5× 半频。
function robustMean(vals) {
  if (!vals.length) return 0;
  const med = median(vals);
  let s = 0, n = 0;
  for (const v of vals) if (v >= med * 0.6 && v <= med * 1.7) { s += v; n++; }
  return n ? s / n : med;
}

// 基于时间常数 tau(秒) 的 EMA 系数：与帧间隔 dt 挂钩，因此与帧率无关。
// 不论 60Hz 还是 144Hz 屏，达到同样平滑程度所需的物理时间一致。
const emaAlpha = (dt, tau) => 1 - Math.exp(-dt / tau);

function smoothAll(target, aMain, aSlow) {
  // 谐波电平
  for (let i = 0; i < 5; i++) {
    state.levels[i] = lerp(state.levels[i], target.levels[i], aMain);
    state.baseline[i] = lerp(state.baseline[i], target.levels[i], aSlow); // 慢速基线
  }
  // 指标
  const m = state.metrics, tm = target.metrics;
  m.h1h2 = lerp(m.h1h2, tm.h1h2, aMain);
  m.h1h5 = lerp(m.h1h5, tm.h1h5, aMain);
  m.lowHigh = lerp(m.lowHigh, tm.lowHigh, aMain);
  m.tilt = lerp(m.tilt, tm.tilt, aMain);
  // 特征垫坐标
  state.padX = lerp(state.padX, target.padX, aMain);
  state.padY = lerp(state.padY, target.padY, aMain);
}

// —— 每帧分析 —— //
function analyzeFrame() {
  if (settings.freeze) return;
  const data = engine.poll();
  if (!data) return;

  const { freqDb, timeBuf } = data;
  const sr = engine.sampleRate;

  const pitch = detectPitch(timeBuf, sr, settings.fmin, settings.fmax, settings.rmsGate);

  if (pitch.f0 > 0 && pitch.clarity > 0.45) {
    // —— 帧率无关的时间常数平滑：smoothing 越大，时间常数越长越平稳 —— //
    const now = performance.now();
    let dt = (now - lastSmoothTime) / 1000;
    lastSmoothTime = now;
    dt = Math.min(Math.max(dt, 0.001), 0.05); // clamp：中断后恢复发声不会瞬跳
    const tau = 0.03 + settings.smoothing * 0.4; // 主时间常数 ≈ 0.03~0.41s
    const aMain = emaAlpha(dt, tau);
    const aSlow = emaAlpha(dt, 2.0);             // 参考基线缓慢跟随

    // —— F0 中值滤波：消除偶发倍频/半频误检导致的谐波采样错位（柱子整体乱跳） —— //
    f0Hist.push(pitch.f0);
    if (f0Hist.length > 5) f0Hist.shift();
    const f0 = median(f0Hist);

    // —— 噪声基底平滑：避免所有谐波电平随基底一起上下抖 —— //
    const rawFloor = estimateNoiseFloor(freqDb, 0.2);
    smoothedFloor = hasData ? lerp(smoothedFloor, rawFloor, emaAlpha(dt, 0.4)) : rawFloor;

    const harmonics = extractHarmonics(freqDb, sr, engine.fftSize, f0, 5);
    const metrics = computeMetrics(harmonics);
    const { padX, padY } = metricsToPad(metrics);

    // 把 dB 谐波电平减去噪声基底，映射到 0~80 量程（差值类指标不受影响）
    const levels = harmonics.map((h) => Math.max(0, Math.min(80, h.db - smoothedFloor)));

    smoothAll({ levels, metrics, padX, padY }, aMain, aSlow);
    state.active = true;
    state.f0 = f0;
    lastVoicedAt = now;
    pitchHist.push({ t: now, f0 });

    // 共振峰（LPC 较重，隔帧计算；变化慢，EMA 足够顺滑）
    if (frameCount % 2 === 0) {
      const fmt = estimateFormants(timeBuf, sr);
      if (fmt.f1) state.f1 = state.f1 ? lerp(state.f1, fmt.f1, aMain) : fmt.f1;
      if (fmt.f2) state.f2 = state.f2 ? lerp(state.f2, fmt.f2, aMain) : fmt.f2;
      if (state.f1 && state.f2) fHist.push({ f1: state.f1, f2: state.f2, t: now });
    }

    // 首次检测到有效人声：开始展示摘要
    if (!hasData) { hasData = true; summaryEl.hidden = false; }
  } else {
    // 无声/清晰度不足：冻结图表，绝不归零（保留最后的形态）。
    // “有声”指示给 500ms 的保持，避免词间短暂停顿造成药丸与状态点闪烁。
    const now = performance.now();
    state.active = now - lastVoicedAt < 500;
    f0Hist.length = 0;            // 清空音高历史，恢复发声时不沿用旧音高
    pitchHist.push({ t: now, f0: 0 }); // 记录静音断点，使曲线断开
  }
}

// —— 界面文本更新（节流，避免每帧重排） —— //
let lastUiUpdate = -1e9; // 让首帧/静态预览的 updateUI 一定执行
function updateUI(now) {
  if (now - lastUiUpdate < 120) return; // ~8fps 足够
  lastUiUpdate = now;

  // 尚未检测到人声：提示发声，摘要保持隐藏
  if (!hasData) {
    pillEl.classList.add('prompt');
    pillEl.classList.remove('inactive');
    pillEl.textContent = '请对着麦克风发声…';
    f0El.textContent = '— Hz';
    if (f1El) f1El.textContent = '—';
    if (f2El) f2El.textContent = '—';
    return;
  }

  pillEl.classList.remove('prompt');
  pillEl.textContent = pillText(state.metrics);
  pillEl.classList.toggle('inactive', !state.active);

  f0El.textContent = state.f0 > 0 ? `${state.f0.toFixed(0)} Hz` : '— Hz';
  if (f1El) f1El.textContent = state.f1 ? Math.round(state.f1) : '—';
  if (f2El) f2El.textContent = state.f2 ? Math.round(state.f2) : '—';

  const cards = summaryCards(state.metrics);
  // 仅在卡片结构变化时重建 DOM，否则只改文本，避免抖动
  if (cardsEl.children.length !== cards.length) {
    cardsEl.innerHTML = cards.map(cardHTML).join('');
  } else {
    cards.forEach((c, i) => fillCard(cardsEl.children[i], c));
  }
}

function cardHTML(c) {
  return `
    <div class="card">
      <div class="card-eyebrow"></div>
      <div class="card-body">
        <h3 class="card-heading"></h3>
        <div class="card-values"></div>
      </div>
      <p class="card-desc"></p>
    </div>`;
}
function fillCard(el, c) {
  el.querySelector('.card-eyebrow').textContent = c.eyebrow;
  el.querySelector('.card-heading').textContent = c.heading;
  el.querySelector('.card-values').innerHTML = c.values
    .map((v) => `<span>${v}</span>`).join('');
  el.querySelector('.card-desc').textContent = c.desc;
}

// —— 主循环 —— //
function renderCanvas() {
  draw(ctx, layout, {
    levels: state.levels,
    baseline: settings.showBaseline ? state.baseline : null,
    padX: state.padX,
    padY: state.padY,
    active: state.active,
    hasData,
  });
}

// 自适应 Hz 显示范围：取窗口内有效基频的极值并加边距，再做 EMA 平滑避免跳动
function updatePitchRange() {
  const t0 = performance.now() - PITCH_WINDOW_MS;
  const vals = [];
  for (const s of pitchHist) if (s.t >= t0 && s.f0 > 0) vals.push(s.f0);
  // 用中位数剔除离群（500+ 尖峰/倍频），避免一个误检把整条曲线压扁
  let mn = Infinity, mx = -Infinity;
  if (vals.length) {
    const med = median(vals);
    for (const v of vals) if (v >= med * 0.6 && v <= med * 1.7) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn === Infinity) { mn = med; mx = med; }
  }
  // 显示目标线时把目标频率纳入极值，确保固定的目标线始终可见
  if (settings.showTarget) {
    mn = Math.min(mn, settings.targetHz);
    mx = Math.max(mx, settings.targetHz);
  }
  if (mn === Infinity) return; // 既无人声也无目标线，保持当前范围
  let lo = mn - 15, hi = mx + 15;
  if (hi - lo < 80) { const c = (lo + hi) / 2; lo = c - 40; hi = c + 40; } // 最小跨度
  lo = Math.max(50, lo);
  hi = Math.min(520, hi);
  pitchRange.lo = lerp(pitchRange.lo, lo, 0.06);
  pitchRange.hi = lerp(pitchRange.hi, hi, 0.06);
}

function renderPitch() {
  const now = performance.now();
  const cutoff = now - PITCH_WINDOW_MS - 500;
  while (pitchHist.length && pitchHist[0].t < cutoff) pitchHist.shift(); // 修剪过期样本
  updatePitchRange();
  // 最近 3 秒、剔除离群后的稳健均值（500+ 误检不计入）
  const tMean = now - MEAN_WINDOW_MS;
  const recent = [];
  for (const x of pitchHist) if (x.t >= tMean && x.f0 > 0) recent.push(x.f0);
  const meanHz = robustMean(recent);
  drawPitchTrack(pitchCtx, pitchSize.w, pitchSize.h, pitchHist, {
    lo: pitchRange.lo, hi: pitchRange.hi, now, windowMs: PITCH_WINDOW_MS, hasData,
    showTarget: settings.showTarget, targetHz: settings.targetHz, meanHz,
  });
}

function renderResonance() {
  const cutoff = performance.now() - FHIST_MS;
  while (fHist.length && fHist[0].t < cutoff) fHist.shift(); // 修剪过期轨迹
  drawResonanceMap(resonanceCtx, resonanceSize.w, resonanceSize.h, {
    f1: state.f1, f2: state.f2, trail: fHist, active: state.active, hasData,
  });
}

function loop(now) {
  frameCount++;
  analyzeFrame();
  if (recording) recordTick(now || performance.now());
  renderCanvas();
  renderPitch();
  renderResonance();
  updateUI(now || 0);
  requestAnimationFrame(loop);
}

// —— 启动（需用户手势授权麦克风） —— //
async function startApp() {
  startErr.textContent = '';
  startBtn.disabled = true;
  startBtn.textContent = '正在请求麦克风…';
  try {
    await engine.start();
    startOverlay.classList.add('hidden');
    resize();
    requestAnimationFrame(loop);
    initSettingsPanel();
  } catch (err) {
    startBtn.disabled = false;
    startBtn.textContent = '开始分析';
    startErr.textContent = describeMicError(err);
  }
}

function describeMicError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '麦克风权限被拒绝。请在浏览器地址栏允许麦克风后重试。';
  if (name === 'NotFoundError')
    return '未检测到麦克风设备。请插入麦克风后重试。';
  if (location.protocol === 'file:')
    return '请通过 http://localhost 访问（getUserMedia 需要安全上下文）。见 README。';
  return '无法启动麦克风：' + (err && err.message ? err.message : String(err));
}

startBtn.addEventListener('click', startApp);

// —— 录音与分析 —— //
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function recordTick(now) {
  const el = now - recordStart;
  if (el >= RECORD_MAX_MS) { stopRecording(); return; }
  // 每 3 帧采一帧快照（~20/s，足够统计），仅在有声时记录指标值
  if (frameCount % 3 === 0 && hasData) {
    recordBuffer.push({
      t: el, f0: state.f0, f1: state.f1, f2: state.f2,
      tilt: state.metrics.tilt, h1h2: state.metrics.h1h2, active: state.active,
    });
  }
  recLabel.textContent = '停止 ' + fmtTime(el);
}

// 把麦克风源降混成单声道再录，避免立体声只有一侧有声、回放只剩一边
function buildMonoStream() {
  const ac = engine.ctx, src = engine.source;
  if (!ac || !src) return null;
  try {
    const mono = ac.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers'; // 多声道按规则降混为单声道
    const dest = ac.createMediaStreamDestination();
    dest.channelCount = 1;
    src.connect(mono);
    mono.connect(dest);
    monoNodes = { mono, dest };
    return dest.stream;
  } catch {
    return null;
  }
}
function teardownMono() {
  if (!monoNodes) return;
  try { monoNodes.mono.disconnect(); monoNodes.dest.disconnect(); } catch { /* 已断开 */ }
  monoNodes = null;
}

function startRecording() {
  if (!engine.running || recording) return;
  recording = true;
  recordBuffer.length = 0;
  recordStart = performance.now();
  recordBtn.classList.add('recording');
  recLabel.textContent = '停止 0:00';
  recordedChunks = [];
  const stream = buildMonoStream() || engine.stream; // 单声道流，失败则退回原始流
  try {
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch {
    mediaRecorder = null; // 音频录制不可用时仍记录指标并出报告
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  const dur = performance.now() - recordStart;
  recordBtn.classList.remove('recording');
  recLabel.textContent = '录制';
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = () => finishRecording(dur);
    try { mediaRecorder.stop(); } catch { finishRecording(dur); }
  } else {
    finishRecording(dur);
  }
}

async function finishRecording(durMs) {
  teardownMono();
  let blob = null, mime = null;
  if (recordedChunks.length) {
    mime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
    blob = new Blob(recordedChunks, { type: mime });
  }
  const stats = analyzeRecording(recordBuffer, durMs);
  const rec = { id: 'r' + Date.now(), createdAt: Date.now(), durationMs: durMs, stats, audio: blob, mime };
  await recsPut(rec);
  historyRecs = await recsAll();
  openDetail(rec); // 录完直接看这条的详细分析
}

function analyzeRecording(buf, durMs) {
  const voiced = buf.filter((s) => s.active && s.f0 > 0);
  const s = { durS: durMs / 1000, total: buf.length, voiced: voiced.length, voicedRatio: buf.length ? voiced.length / buf.length : 0 };
  if (!voiced.length) return s;

  const f0sorted = voiced.map((x) => x.f0).sort((a, b) => a - b);
  s.f0mean = avg(voiced.map((x) => x.f0));
  s.f0min = f0sorted[0];
  s.f0max = f0sorted[f0sorted.length - 1];
  s.f0median = f0sorted[f0sorted.length >> 1];
  s.semitones = 12 * Math.log2(s.f0max / Math.max(1, s.f0min));
  s.f0std = Math.sqrt(avg(voiced.map((x) => (x.f0 - s.f0mean) ** 2)));

  const f1v = voiced.filter((x) => x.f1 > 0).map((x) => x.f1);
  const f2v = voiced.filter((x) => x.f2 > 0).map((x) => x.f2);
  s.f1mean = avg(f1v);
  s.f2mean = avg(f2v);
  if (f1v.length) s.f1median = median(f1v);
  if (f2v.length) { s.f2median = median(f2v); s.f2min = Math.min(...f2v); s.f2max = Math.max(...f2v); }
  s.tiltMean = avg(voiced.map((x) => x.tilt));
  s.h1h2Mean = avg(voiced.map((x) => x.h1h2));

  // 共鸣方向占比（按 F1+F2 沿共鸣图对角线综合判别，样本校准）
  let fem = 0, neu = 0, masc = 0, ft = 0;
  for (const x of voiced) {
    if (x.f1 <= 0 || x.f2 <= 0) continue;
    ft++;
    const sc = resonanceScore(x.f1, x.f2);
    if (sc > 0.44) fem++;
    else if (sc < 0.38) masc++;
    else neu++;
  }
  ft = ft || 1;
  s.resFem = fem / ft; s.resNeu = neu / ft; s.resMasc = masc / ft;

  // 目标音高命中率（±1 半音内）
  if (settings.showTarget && settings.targetHz > 0) {
    let hit = 0;
    for (const x of voiced) if (Math.abs(12 * Math.log2(x.f0 / settings.targetHz)) <= 1) hit++;
    s.targetHit = hit / voiced.length;
    s.targetHz = settings.targetHz;
  }
  return s;
}

const toneWord = (t) => (t > -8 ? '明亮' : t < -16 ? '偏暗' : '居中');
const breathWord = (h) => (h > 8 ? '偏气声' : h < -2 ? '偏压声/紧绷' : '居中');

// 共鸣"女性化得分"：F1、F2 归一化后等权综合（沿共鸣图对角线）。
// 依据 Hillenbrand et al.(1995) 成人男/女 12 元音共振峰：归一化空间里 F1、F2 对性别的
// 分离度相当(各 Δ≈0.115)，故等权；男/女类心约 0.355 / 0.469，边界取中点 ≈0.41。
// 坐标区间与共鸣图一致（F2 700–2900, F1 250–1050）。
//   s < 0.38 偏男 · 0.38–0.44 中性 · s > 0.44 偏女。
function resonanceScore(f1, f2) {
  const x = Math.max(0, Math.min(1, (f2 - 700) / 2200));
  const y = Math.max(0, Math.min(1, (f1 - 250) / 800));
  return 0.5 * x + 0.5 * y;
}

function reportHTML(s) {
  if (!s.voiced) {
    return '<p class="report-row">这段录音没有检测到清晰的发声。靠近麦克风、持续发元音后重试。</p>';
  }
  const pct = (v) => Math.round(v * 100) + '%';
  const row = (k, v) => `<div class="report-row"><span>${k}</span><b>${v}</b></div>`;
  const section = (title, rows) => `<div class="report-section"><h3>${title}</h3>${rows.join('')}</div>`;
  let html = '';
  html += section('概况', [row('时长', s.durS.toFixed(1) + ' 秒'), row('发声占比', pct(s.voicedRatio))]);
  html += section('基频 F0（音高）', [
    row('平均', Math.round(s.f0mean) + ' Hz'),
    row('范围', Math.round(s.f0min) + ' – ' + Math.round(s.f0max) + ' Hz'),
    row('中位数', Math.round(s.f0median) + ' Hz'),
    row('音域跨度', s.semitones.toFixed(1) + ' 半音'),
    row('稳定度（标准差）', '±' + Math.round(s.f0std) + ' Hz'),
  ]);
  const pair = (m, md) => (m ? Math.round(m) : '—') + ' / ' + (md ? Math.round(md) : '—') + ' Hz';
  html += section('共振峰（共鸣）· 平均 / 中位', [
    row('F1', pair(s.f1mean, s.f1median)),
    row('F2', pair(s.f2mean, s.f2median)),
    row('F2 范围', s.f2max ? Math.round(s.f2min) + ' – ' + Math.round(s.f2max) + ' Hz' : '—'),
  ]);

  // 训练方向：用更稳健的 F1/F2 中位判定当前共鸣属于偏男/中性/偏女，并给双向调整建议
  if (s.f1median && s.f2median) {
    const sc = resonanceScore(s.f1median, s.f2median);
    const where = sc > 0.44 ? '偏女' : sc < 0.38 ? '偏男' : '中性';
    html += section('训练方向（按 F1/F2 中位）', [
      row('当前共鸣', `${where}（F1 ${Math.round(s.f1median)} · F2 ${Math.round(s.f2median)} Hz）`),
      row('更女性化 →', '抬高 F2：舌前移 · 唇展(微笑) · 喉位略上抬'),
      row('更男性化 →', '降低 F1/F2：喉位放松下沉 · 扩大口腔后部'),
    ]);
  }
  html += section('音色', [
    row('明暗（频谱倾斜）', s.tiltMean.toFixed(1) + ' dB/oct · ' + toneWord(s.tiltMean)),
    row('气声（H1−H2）', s.h1h2Mean.toFixed(1) + ' dB · ' + breathWord(s.h1h2Mean)),
  ]);
  html += `<div class="report-section"><h3>共鸣方向占比（按 F1+F2 共鸣）</h3>
    <div class="report-bars">
      <span style="width:${pct(s.resMasc)};background:#5bcefa"></span>
      <span style="width:${pct(s.resNeu)};background:#8595ad"></span>
      <span style="width:${pct(s.resFem)};background:#f5a9c4"></span>
    </div>
    <div class="report-legend">
      <span><i style="background:#5bcefa"></i>偏男 ${pct(s.resMasc)}</span>
      <span><i style="background:#8595ad"></i>中性 ${pct(s.resNeu)}</span>
      <span><i style="background:#f5a9c4"></i>偏女 ${pct(s.resFem)}</span>
    </div></div>`;
  if (s.targetHit != null) {
    html += section('目标音高', [row(`在目标 ${Math.round(s.targetHz)} Hz ±1 半音内`, pct(s.targetHit))]);
  }
  return html;
}

// —— 录音历史存储（IndexedDB；不可用时回退内存） —— //
const DB_NAME = 'vh-recordings', STORE = 'recs';
let memStore = null;
const useMem = () => (memStore || (memStore = []));

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbTx(mode, fn) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let out;
    const r = fn(tx.objectStore(STORE));
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  }));
}
async function recsAll() {
  try { return (await idbTx('readonly', (s) => s.getAll())) || []; }
  catch { return [...useMem()]; }
}
async function recsPut(rec) {
  try { await idbTx('readwrite', (s) => s.put(rec)); }
  catch { useMem().unshift(rec); }
}
async function recsDelete(id) {
  try { await idbTx('readwrite', (s) => s.delete(id)); }
  catch { memStore = useMem().filter((r) => r.id !== id); }
}
async function recsClear() {
  try { await idbTx('readwrite', (s) => s.clear()); }
  catch { memStore = []; }
}

// —— 历史列表 + 详情视图 —— //
function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function resWord(s) {
  if (!s || !s.voiced) return '无清晰发声';
  const m = Math.max(s.resMasc || 0, s.resNeu || 0, s.resFem || 0);
  if (m === s.resFem) return '偏女 ' + Math.round(s.resFem * 100) + '%';
  if (m === s.resMasc) return '偏男 ' + Math.round(s.resMasc * 100) + '%';
  return '中性 ' + Math.round((s.resNeu || 0) * 100) + '%';
}
function clearDetailUrl() {
  if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
}
// 停止并移除详情页的音频元素（关闭弹层/返回列表时调用，避免后台继续播放）
function stopDetailAudio() {
  const a = reportAudioEl.querySelector('audio');
  if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch { /* 忽略 */ } }
  reportAudioEl.innerHTML = '';
}

async function openHistory() {
  historyRecs = await recsAll();
  historyRecs.sort((a, b) => b.createdAt - a.createdAt);
  resetClear();
  renderHistoryList();
  reportTitle.textContent = '录音历史';
  reportBack.hidden = true;
  detailView.hidden = true;
  historyView.hidden = false;
  stopDetailAudio();
  clearDetailUrl();
  currentDetailId = null;
  reportOverlay.classList.add('open');
}

function renderHistoryList() {
  const n = historyRecs.length;
  historyClearBtn.hidden = n === 0;
  historyCountEl.textContent = n ? `共 ${n} 条` : '';
  if (!n) {
    historyListEl.innerHTML = '';
    historyEmptyEl.hidden = false;
    return;
  }
  historyEmptyEl.hidden = true;
  historyListEl.innerHTML = historyRecs.map((rec) => {
    const s = rec.stats || {};
    const f0 = s.f0mean ? Math.round(s.f0mean) + ' Hz' : '—';
    const dur = (rec.durationMs / 1000).toFixed(1) + 's';
    const masc = Math.round((s.resMasc || 0) * 100);
    const neu = Math.round((s.resNeu || 0) * 100);
    const fem = Math.round((s.resFem || 0) * 100);
    return `<div class="history-item">
      <button class="history-main" data-id="${rec.id}">
        <div class="history-date">${fmtDate(rec.createdAt)}</div>
        <div class="history-meta">时长 ${dur} · F0 ${f0} · ${resWord(s)}</div>
        <div class="history-mini">
          <span style="width:${masc}%;background:#5bcefa"></span>
          <span style="width:${neu}%;background:#8595ad"></span>
          <span style="width:${fem}%;background:#f5a9c4"></span>
        </div>
      </button>
      <button class="history-del" data-del="${rec.id}" aria-label="删除" title="删除">&#10005;</button>
    </div>`;
  }).join('');
}

function openDetail(rec) {
  resetClear();
  currentDetailId = rec.id;
  reportBody.innerHTML = reportHTML(rec.stats || {});
  stopDetailAudio();
  clearDetailUrl();
  if (rec.audio) {
    detailUrl = URL.createObjectURL(rec.audio);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = detailUrl;
    reportAudioEl.appendChild(audio);
    reportDownload.hidden = false;
    reportDownload.href = detailUrl;
    reportDownload.download = '录音-' + fmtDate(rec.createdAt).replace(/[:\s]/g, '-') + ((rec.mime || '').includes('ogg') ? '.ogg' : '.webm');
  } else {
    reportAudioEl.innerHTML = '<p class="report-row" style="color:var(--text-faint)">此浏览器未生成可回放音频，但分析已保存。</p>';
    reportDownload.hidden = true;
  }
  reportTitle.textContent = '录音分析 · ' + fmtDate(rec.createdAt);
  reportBack.hidden = false;
  historyView.hidden = true;
  detailView.hidden = false;
  reportOverlay.classList.add('open');
}

async function deleteRec(id) {
  await recsDelete(id);
  historyRecs = await recsAll();
  historyRecs.sort((a, b) => b.createdAt - a.createdAt);
  if (currentDetailId === id) openHistory();
  else renderHistoryList();
}

// "清空全部"：点一次进入确认态，2.6 秒内再点一次才真正清空
function resetClear() {
  clearArmed = false;
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  historyClearBtn.classList.remove('armed');
  historyClearBtn.textContent = '清空全部';
}
async function clearAll() {
  if (!historyRecs.length) return;
  if (!clearArmed) {
    clearArmed = true;
    historyClearBtn.classList.add('armed');
    historyClearBtn.textContent = '确认清空全部？';
    clearTimer = setTimeout(resetClear, 2600);
    return;
  }
  resetClear();
  await recsClear();
  historyRecs = await recsAll();
  renderHistoryList();
}

function closeReport() {
  reportOverlay.classList.remove('open');
  stopDetailAudio();
  clearDetailUrl();
}

function initRecording() {
  recordBtn.addEventListener('click', () => { recording ? stopRecording() : startRecording(); });
  historyBtn.addEventListener('click', openHistory);
  reportBack.addEventListener('click', openHistory);
  historyClearBtn.addEventListener('click', clearAll);
  document.getElementById('report-close').addEventListener('click', closeReport);
  reportOverlay.addEventListener('click', (e) => { if (e.target === reportOverlay) closeReport(); });
  reportDelete.addEventListener('click', () => { if (currentDetailId) deleteRec(currentDetailId); });
  historyListEl.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { deleteRec(del.getAttribute('data-del')); return; }
    const main = e.target.closest('[data-id]');
    if (main) {
      const rec = historyRecs.find((r) => r.id === main.getAttribute('data-id'));
      if (rec) openDetail(rec);
    }
  });
}

// —— 设置面板 —— //
function initSettingsPanel() {
  const gear = document.getElementById('settings-btn');
  const panel = document.getElementById('settings-panel');
  const backdrop = document.getElementById('settings-backdrop');
  if (gear.dataset.bound) return;
  gear.dataset.bound = '1';

  const open = () => { panel.classList.add('open'); backdrop.classList.add('open'); };
  const close = () => { panel.classList.remove('open'); backdrop.classList.remove('open'); };
  gear.addEventListener('click', open);
  backdrop.addEventListener('click', close);
  document.getElementById('settings-close').addEventListener('click', close);

  bindSlider('set-smoothing', 'smoothing', (v) => v / 100, (v) => Math.round(v * 100), '%');
  bindSlider('set-gate', 'rmsGate', (v) => v / 1000, (v) => Math.round(v * 1000), '');
  bindSlider('set-fmin', 'fmin', (v) => v, (v) => v, ' Hz');
  bindSlider('set-fmax', 'fmax', (v) => v, (v) => v, ' Hz');
  bindToggle('set-baseline', 'showBaseline');
  bindToggle('set-freeze', 'freeze');
  bindToggle('set-target', 'showTarget');
  bindSlider('set-targethz', 'targetHz', (v) => v, (v) => v, ' Hz');
}

function bindSlider(id, key, toModel, toView, suffix) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + '-val');
  if (!el) return;
  el.value = toView(settings[key]);
  out.textContent = el.value + suffix;
  el.addEventListener('input', () => {
    settings[key] = toModel(parseFloat(el.value));
    out.textContent = el.value + suffix;
    saveSettings(settings);
  });
}
function bindToggle(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = !!settings[key];
  el.addEventListener('change', () => {
    settings[key] = el.checked;
    saveSettings(settings);
  });
}

// 初次布局；空状态下只画坐标轴与特征垫，等待发声后再出现谐波与摘要
resize();
if (window.ResizeObserver) {
  // 桌面/窗口尺寸变化时让画布跟随容器（双栏布局下尤为重要）
  const ro = new ResizeObserver(() => { resize(); renderCanvas(); renderPitch(); renderResonance(); });
  ro.observe(canvas.parentElement);
  ro.observe(pitchCanvas.parentElement);
  ro.observe(resonanceCanvas.parentElement);
}
renderCanvas();
renderPitch();
renderResonance();
updateUI(0);
initRecording();
